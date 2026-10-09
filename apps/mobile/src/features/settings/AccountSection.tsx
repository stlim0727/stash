import { AUTH_PROVIDERS, makeStyles } from '@/features/settings/layout';
import type { TFunction } from '@/i18n/translate';
import { useSupabaseAuth } from "@/supabase/auth-provider";
import type { OAuthProvider } from "@/supabase/types";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { AccountLibraryNotice } from "@/ui/AccountLibraryNotice";
import { PostHogMaskView } from "posthog-react-native";
import {
  Text,
  View
} from "react-native";

interface Props {
  styles: ReturnType<typeof makeStyles>;
  t: TFunction;
  isAuthenticated: boolean;
  auth: ReturnType<typeof useSupabaseAuth>;
  authBusy: OAuthProvider | "signout" | null;
  handleSignOut: () => void;
  handleSignIn: (provider: OAuthProvider) => Promise<void>;
  accountFocused?: boolean;
  accountLibraryState?: "ready" | "checking" | "error";
  accountTransferCount?: number;
  dismissAccountTransfer?: () => void;
  offline?: boolean;
  syncPaused?: boolean;
  syncNow?: (options?: { force?: boolean }) => Promise<boolean>;
  setSyncPaused?: (paused: boolean) => void | Promise<void>;
}

export function AccountSection({
  styles,
  t,
  isAuthenticated,
  auth,
  authBusy,
  handleSignOut,
  handleSignIn,
  accountFocused,
  accountLibraryState = 'ready',
  accountTransferCount = 0,
  dismissAccountTransfer,
  offline,
  syncPaused,
  syncNow,
  setSyncPaused,
}: Props) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{t("settings.section.account")}</Text>
      <Card
        style={[styles.account, accountFocused && styles.accountFocused]}
        elevated={false}
        testID="settings-account-card"
      >
        <View style={[styles.accountHeaderOnly, accountFocused && styles.accountFocusedHeader]}>
          {isAuthenticated ? (
            <>
              <View style={styles.accountText}>
                <Text style={styles.accountMeta}>
                  {t("settings.account.signedIn")}
                </Text>
                {/* `accessible` + `accessibilityLabel` give VoiceOver/
                        TalkBack the real identity as one announced unit — the
                        masked Text below has no accessible ancestor of its own
                        otherwise (standalone, not inside a Pressable). */}
                <View
                  accessible
                  accessibilityLabel={
                    auth.email ??
                    auth.displayName ??
                    t("settings.account.signedIn")
                  }
                >
                  <PostHogMaskView>
                    <Text style={styles.accountName} numberOfLines={1}>
                      {auth.email ??
                        auth.displayName ??
                        t("settings.account.signedIn")}
                    </Text>
                  </PostHogMaskView>
                </View>
              </View>
              <Button
                variant="ghost"
                size="sm"
                disabled={authBusy !== null}
                onPress={handleSignOut}
              >
                {t("settings.account.signOut")}
              </Button>
            </>
          ) : auth.status === "not_configured" ? (
            <View style={styles.accountText}>
              <Text style={styles.accountName} numberOfLines={1}>
                {t("settings.account.cloudUnavailable")}
              </Text>
              <Text style={styles.accountMeta} numberOfLines={1}>
                {t("settings.account.worksOffline")}
              </Text>
            </View>
          ) : (
            <>
              <View style={accountFocused ? styles.accountFocusedText : styles.accountText}>
                <Text style={styles.accountName} numberOfLines={1}>
                  {t(
                    auth.status === "session_expired"
                      ? "settings.account.sessionExpired"
                      : "settings.account.signIn",
                  )}
                </Text>
                {accountFocused ? (
                  <Text style={styles.accountGuide} testID="settings-account-sign-in-guide">
                    {t("settings.account.signInGuide")}
                  </Text>
                ) : null}
                {auth.status === "session_expired" ? (
                  <Text style={styles.accountMeta} numberOfLines={2}>
                    {t("settings.account.sessionExpiredBody")}
                  </Text>
                ) : auth.status === "anonymous" || auth.status === "signed_out" ? (
                  <Text style={styles.accountMeta}>{t("account.guestCarryOver")}</Text>
                ) : null}
              </View>
              <View style={[styles.authButtons, accountFocused && styles.accountFocusedButtons]}>
                {AUTH_PROVIDERS.map(({ id, label, icon, a11yKey }) => (
                  <Button
                    key={id}
                    variant={accountFocused && id === "google" ? "primary" : "ghost"}
                    size={accountFocused ? "md" : "sm"}
                    icon={icon}
                    accessibilityLabel={t(a11yKey)}
                    disabled={authBusy !== null}
                    onPress={() => void handleSignIn(id)}
                  >
                    {accountFocused ? t(a11yKey) : label}
                  </Button>
                ))}
              </View>
            </>
          )}
        </View>
        <AccountLibraryNotice
          state={accountLibraryState}
          transferredCount={accountTransferCount}
          onDismiss={dismissAccountTransfer}
          offline={offline}
          paused={syncPaused}
          resumeHere
          onRetry={() => { void syncNow?.({ force: true }); }}
          onSettings={() => { void setSyncPaused?.(false); }}
        />
      </Card>
    </View>
  );
}
