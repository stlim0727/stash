import { useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import { readDurableBookmarks } from '@/storage/durable-snapshot';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';

export function LibraryStatus({ bookmarks, queue, authStatus, loading, loadError, syncing, paused = false, retry, signIn, guestActions }: {
  bookmarks: Bookmark[]; queue: LocalPendingBookmark[]; authStatus: string;
  loading: boolean; loadError: boolean; syncing: boolean; paused?: boolean;
  retry: () => void; signIn: () => void; guestActions?: ReactNode;
}) {
  const t = useT();
  const palette = usePalette();
  const [confirmation, setConfirmation] = useState<{ bookmarks: Bookmark[]; confirmed: boolean } | null>(null);
  const guest = ['anonymous', 'signed_out', 'not_configured'].includes(authStatus);
  useEffect(() => {
    if (!guest || loading || loadError || bookmarks.length === 0) return;
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
  }, [bookmarks, guest, loading, loadError]);

  if (loading || loadError) return null;
  const expired = authStatus === 'session_expired';
  const failed = !guest && queue.some((item) => item.sync_status === 'failed');
  const waiting = !guest && queue.length > 0;
  const saved = guest && confirmation?.bookmarks === bookmarks && confirmation.confirmed;
  const key = expired ? 'library.resume' : guest ? (saved ? 'library.saved' : 'library.guest')
    : paused ? 'library.paused' : failed ? 'library.failed' : waiting ? 'library.waiting' : null;
  if (!key || (guest && bookmarks.length === 0)) return null;
  return <View testID="library-status" accessibilityRole="summary"
    style={{ padding: 16, marginBottom: 12, gap: 8, borderRadius: 16, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card }}>
    <Text style={{ color: key === 'library.failed' ? palette.danger : palette.textSecondary }}>{t(key)}</Text>
    {guest ? guestActions : null}
    {expired || (!guest && paused) ? <Button variant="ghost" onPress={signIn}>{t(expired ? 'settings.account.signIn' : 'nav.settings')}</Button>
      : failed ? <Button variant="ghost" disabled={syncing} onPress={retry}>{t('library.retry')}</Button> : null}
  </View>;
}
