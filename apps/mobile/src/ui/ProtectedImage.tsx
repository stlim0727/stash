import { useEffect, useMemo, useState } from 'react';
import { Image, type ImageProps } from 'react-native';

import { privateImageReference, signedImageUrl, PRIVATE_IMAGE_URL_TTL_SECONDS } from '@/domain/private-image';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { StashSupabaseClient } from '@/supabase/client';
import { getSupabaseConfigState } from '@/supabase/config';
import { isPublicPreviewUrl } from '@/domain/preview-network';

type Props = Omit<ImageProps, 'source'> & { uri: string };

/** Sign only Keepory's own uploaded images. No tokens/signatures are persisted
 * in bookmark rows, sync, exports or local storage. Local/external images keep
 * their existing loading path. */
export function ProtectedImage({ uri, onError, ...props }: Props) {
  const auth = useSupabaseAuth();
  const config = useMemo(() => getSupabaseConfigState(), []);
  const usableSession = auth.status === 'authenticated' || auth.status === 'anonymous' ? auth.session : null;
  const projectUrl = config.status === 'configured' ? config.config.url : '';
  const reference = privateImageReference(uri, projectUrl, usableSession?.user.id ?? null);
  const path = reference.kind === 'private' ? reference.path : null;
  const identity = `${usableSession?.user.id ?? ''}|${uri}`;
  const [resolved, setResolved] = useState<{ identity: string; url: string; expiresAt: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [retry, setRetry] = useState<{ identity: string; count: number }>({ identity: '', count: 0 });

  useEffect(() => {
    if (!path || !usableSession || config.status !== 'configured') return;
    const client = new StashSupabaseClient(config.config);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const requestedAt = Date.now();
    void client.request(`/storage/v1/object/sign/bookmark-images/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', accessToken: usableSession.access_token,
      body: { expiresIn: PRIVATE_IMAGE_URL_TTL_SECONDS }, signal: controller.signal,
    }).then((response) => {
      const url = signedImageUrl(config.config.url, path, response);
      if (!active) return;
      setResolved({ identity, url, expiresAt: requestedAt + PRIVATE_IMAGE_URL_TTL_SECONDS * 1000 });
      timer = setTimeout(() => setRefresh((value) => value + 1), (PRIVATE_IMAGE_URL_TTL_SECONDS - 30) * 1000);
    }).catch(() => {
      if (!active) return;
      setResolved(null);
      // Retry once on a transient signing failure; never load the public URL.
      if (retry.identity !== identity || retry.count === 0) {
        setRetry({ identity, count: 1 });
        timer = setTimeout(() => setRefresh((value) => value + 1), 60_000);
      }
    });
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [path, identity, usableSession?.access_token, config, refresh]);

  const displayUri = reference.kind === 'external' ?
    (/^https?:/i.test(uri) && !isPublicPreviewUrl(uri) ? null : uri)
    : reference.kind === 'private' && resolved?.identity === identity && resolved.expiresAt > Date.now() ? resolved.url : null;
  if (!displayUri) return null;
  return <Image {...props} source={{ uri: displayUri }} onError={(event) => {
    if (reference.kind === 'private' && (retry.identity !== identity || retry.count === 0)) {
      setRetry({ identity, count: 1 });
      setResolved(null);
      setRefresh((value) => value + 1);
      return;
    }
    onError?.(event);
  }} />;
}
