import { useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import { readDurableBookmarks } from '@/storage/durable-snapshot';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { buildLibrarySyncFlow, type LibrarySyncFlow, type SyncDisplayPhase } from '@/domain/library-sync-status';
import { useSyncDisplay } from '@/ui/use-sync-display';
import type { MessageKey } from '@/i18n/messages';

const SYNC_COPY: Partial<Record<SyncDisplayPhase, MessageKey>> = {
  syncing: 'library.syncing', delayed: 'library.delayed', complete: 'library.complete',
  offline: 'library.offline', paused: 'library.paused', sign_in: 'library.resume',
  permission: 'library.permission', attention: 'library.attention',
};

export function LibraryStatus({ bookmarks, queue, authStatus, loading, loadError, syncing, paused = false, signIn, guestActions, inline = false, flow, scopeKey }: {
  bookmarks: Bookmark[]; queue: LocalPendingBookmark[]; authStatus: string;
  loading: boolean; loadError: boolean; syncing: boolean; paused?: boolean;
  signIn: () => void; guestActions?: ReactNode; inline?: boolean;
  flow?: LibrarySyncFlow; scopeKey?: string | null;
}) {
  const t = useT();
  const palette = usePalette();
  const [confirmation, setConfirmation] = useState<{ bookmarks: Bookmark[]; confirmed: boolean } | null>(null);
  const guest = ['anonymous', 'signed_out', 'not_configured'].includes(authStatus);
  const cloudEnabled = authStatus === 'authenticated' || authStatus === 'anonymous';
  const observation = loading || loadError || (!cloudEnabled && authStatus !== 'session_expired' && authStatus !== 'error')
    ? { phase: 'idle' as const, remaining: 0 }
    : flow ?? buildLibrarySyncFlow({ authStatus, paused, offline: false, syncing, queue });
  const phase = useSyncDisplay(observation, `${scopeKey ?? authStatus}:${loading}:${loadError}`);
  useEffect(() => {
    if (!inline || !guest || loading || loadError || bookmarks.length === 0) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const verify = async (attempt: number) => {
      const saved = await readDurableBookmarks();
      if (!active) return;
      const byId = new Map(saved?.map((item) => [item.id, item]));
      const confirmed = saved !== null && bookmarks.every((item) => JSON.stringify(byId.get(item.id)) === JSON.stringify(item));
      setConfirmation({ bookmarks, confirmed });
      // Read after an optimistic save settles, without delaying or changing writes.
      if (!confirmed && attempt < 2) timer = setTimeout(() => { void verify(attempt + 1); }, 500);
    };
    timer = setTimeout(() => { void verify(0); }, 100);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [bookmarks, guest, loading, loadError, inline]);

  if (loading || loadError) return null;
  const saved = guest && confirmation?.bookmarks === bookmarks && confirmation.confirmed;
  const key = (phase === 'sign_in' && authStatus !== 'session_expired' && authStatus !== 'error' ? 'library.attention' : SYNC_COPY[phase]) ?? (guest && saved ? 'library.saved' : null);
  const actionable = phase === 'sign_in' || phase === 'permission' || phase === 'attention';
  if (inline) {
    if (actionable || !key) return null;
    const isInteractive = phase === 'paused' || (guest && saved);
    return <Text testID="library-status-inline" numberOfLines={1} accessibilityLiveRegion="polite"
      style={{ color: palette.textSecondary, fontSize: 13, flexShrink: 1 }}
      onPress={isInteractive ? signIn : undefined} accessibilityRole={isInteractive ? 'button' : undefined}
      accessibilityHint={guest && saved ? t('settings.account.signIn') : undefined}>
      · {t(key)}
    </Text>;
  }
  // Routine queue activity and guest persistence belong beside the saved count.
  if (!actionable || !key) return null;
  return <View testID="library-status" accessibilityRole="summary"
    style={{ padding: 16, marginBottom: 12, gap: 8, borderRadius: 16, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card }}>
    <Text style={{ color: phase === 'sign_in' ? palette.textSecondary : palette.danger }}>{t(key)}</Text>
    {guest ? guestActions : null}
    {phase === 'sign_in' && (authStatus === 'session_expired' || authStatus === 'error') ? <Button variant="ghost" onPress={signIn}>{t('settings.account.signIn')}</Button>
      : <Button variant="ghost" onPress={signIn}>{t('library.viewSync')}</Button>}
  </View>;
}
