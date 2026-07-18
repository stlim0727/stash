import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/theme';
import { useT } from '@/i18n';
import { getPreference, setPreference } from '@/storage/preferences';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';

/**
 * Durable per-install dismissal flag (repository meta store, not synced — a
 * fresh device/account always sees the nudge again until its own user
 * dismisses it there). Matches the `pref.*` naming other Inbox prefs use.
 */
export const ANONYMOUS_NUDGE_DISMISSED_PREF_KEY = 'pref.inbox.anonymousNudgeDismissed';

/** Show the nudge only once an anonymous library has some real content in it —
 * not on the very first save, which is still mid-onboarding. */
export const ANONYMOUS_NUDGE_MIN_BOOKMARKS = 2;

interface AnonymousNudgeBannerProps {
  /** True for an anonymous (device-only) session; false once signed in with a
   * real account, or when there is no cloud session at all. */
  isAnonymous: boolean;
  /** Count of active (non-trashed) bookmarks, used for the "2nd save" trigger. */
  bookmarkCount: number;
}

/**
 * A small, dismissible-forever banner nudging an anonymous user to sign in
 * once their local library is real enough to be worth backing up. Never a
 * modal, never blocks the list — just an inline card above the Inbox rows.
 *
 * The "Sign in" action routes to Settings rather than re-implementing the
 * provider buttons here: the account card's sign-in flow (`AUTH_PROVIDERS` in
 * `app/settings.tsx`) is tightly coupled to that screen's own busy/error
 * state, so duplicating it would be a second sign-in UI to keep in sync. This
 * mirrors the existing `session_expired` banner in the Inbox header, which
 * routes to Settings for the same reason.
 */
export function AnonymousNudgeBanner({ isAnonymous, bookmarkCount }: AnonymousNudgeBannerProps) {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  // `null` = not yet loaded from durable storage. Stay hidden until resolved so
  // an about-to-be-dismissed banner never flashes in on remount.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    getPreference(ANONYMOUS_NUDGE_DISMISSED_PREF_KEY)
      .then((raw) => {
        if (active) {
          setDismissed(raw === '1');
        }
      })
      .catch(() => {
        if (active) {
          setDismissed(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    void setPreference(ANONYMOUS_NUDGE_DISMISSED_PREF_KEY, '1');
  };

  const shouldShow =
    isAnonymous && bookmarkCount >= ANONYMOUS_NUDGE_MIN_BOOKMARKS && dismissed === false;
  if (!shouldShow) {
    return null;
  }

  return (
    <Card testID="anonymous-nudge-banner" elevated={false} style={styles.card}>
      <View style={styles.row}>
        <Ionicons
          name="cloud-upload-outline"
          size={20}
          color={palette.accent}
          style={styles.icon}
        />
        <Text style={[styles.body, { color: palette.text }]}>
          {t('inbox.anonymousNudgeBody')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('inbox.anonymousNudgeDismissA11y')}
          testID="anonymous-nudge-dismiss"
          hitSlop={8}
          onPress={handleDismiss}
        >
          <Ionicons name="close" size={18} color={palette.textSecondary} />
        </Pressable>
      </View>
      <Button
        variant="secondary"
        size="sm"
        style={styles.signInButton}
        onPress={() => router.push('/settings')}
      >
        {t('settings.account.signIn')}
      </Button>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 14,
    marginBottom: 12,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  icon: {
    marginTop: 2,
  },
  body: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  signInButton: {
    alignSelf: 'flex-start',
  },
});
