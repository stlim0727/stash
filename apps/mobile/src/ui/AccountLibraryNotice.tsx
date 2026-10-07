import { ActivityIndicator, Text, View } from 'react-native';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';

/** Local ownership checks and cloud loading are never an empty-library result. */
export function AccountLibraryNotice({ state, transferredCount = 0, offline = false, paused = false, onRetry, onSettings, resumeHere = false, onDismiss }: {
  state: 'ready' | 'checking' | 'error';
  transferredCount?: number;
  offline?: boolean;
  paused?: boolean;
  onRetry: () => void;
  onSettings: () => void;
  resumeHere?: boolean;
  onDismiss?: () => void;
}) {
  const t = useT();
  const palette = usePalette();
  if (state === 'ready' && !transferredCount) return null;
  const waiting = state !== 'ready' && (offline || paused);
  const key = waiting ? offline ? 'library.offline' : 'library.paused'
    : state === 'error' ? 'account.libraryError'
    : state === 'checking' ? 'account.libraryChecking' : 'account.localBookmarksKept';
  return <View testID="account-library-notice" style={{ gap: 8, paddingVertical: 12 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {state === 'checking' && !waiting ? <ActivityIndicator color={palette.accent} /> : null}
      <Text accessibilityLiveRegion="polite" style={{ color: state === 'error' && !waiting ? palette.danger : palette.textSecondary, flex: 1 }}>
        {t(key, { count: transferredCount })}
      </Text>
    </View>
    {state !== 'ready' && transferredCount > 0 ? <Text style={{ color: palette.textSecondary }}>
      {t('account.localBookmarksKept', { count: transferredCount })}
    </Text> : null}
    {transferredCount > 0 && onDismiss ? <Button variant="ghost" size="sm" onPress={onDismiss}>{t('common.ok')}</Button> : null}
    {state === 'error' && !waiting ? <Button variant="ghost" onPress={onRetry}>{t('library.retry')}</Button> : null}
    {state !== 'ready' && paused && !offline ? <Button variant="ghost" onPress={onSettings}>{t(resumeHere ? 'settings.sync.resumeButton' : 'library.viewSync')}</Button> : null}
  </View>;
}
