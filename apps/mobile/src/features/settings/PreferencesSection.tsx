import { usePostHogFull } from '@/analytics-full/posthog-full-runtime';
import { useAnalytics } from '@/analytics/provider';
import {
  type AiSuggestionsMode
} from "@/domain/ai-suggestions-pref";
import {
  type ShareBehavior
} from "@/domain/share-behavior";
import { AI_SUGGESTIONS_MODE_OPTIONS, LANGUAGE_OPTIONS, makeStyles } from '@/features/settings/layout';
import { Group, Row } from '@/features/settings/presentation';
import { type LocalePreference } from "@/i18n";
import type { TFunction } from '@/i18n/translate';
import { usePalette } from '@/theme';
import type { Dispatch, SetStateAction } from 'react';
import {
  ActivityIndicator,
  Platform,
  Switch
} from "react-native";
interface Props {
  styles: ReturnType<typeof makeStyles>;
  t: TFunction;
  palette: ReturnType<typeof usePalette>;
  languagePref: LocalePreference;
  setLanguageSheetOpen: Dispatch<SetStateAction<boolean>>;
  aiSuggestionsMode: AiSuggestionsMode;
  setAiSuggestionsSheetOpen: Dispatch<SetStateAction<boolean>>;
  isAuthenticated: boolean;
  pushNotificationsEnabled: boolean;
  pushNotificationsBusy: boolean;
  canUsePushNotifications: boolean;
  handlePushNotificationsChange: (enabled: boolean) => void;
  shareBehavior: ShareBehavior;
  setShareBehavior: Dispatch<SetStateAction<ShareBehavior>>;
  analytics: ReturnType<typeof useAnalytics>;
  analyticsBusy: boolean;
  handleAnalyticsChange: (enabled: boolean) => void;
  sessionReplay: ReturnType<typeof usePostHogFull>;
  sessionReplayBusy: boolean;
  handleSessionReplayChange: (enabled: boolean) => void;
  recentCount: number;
  confirmClearRecents: () => void;
}

export function PreferencesSection({
  styles,
  t,
  palette,
  languagePref,
  setLanguageSheetOpen,
  aiSuggestionsMode,
  setAiSuggestionsSheetOpen,
  isAuthenticated,
  pushNotificationsEnabled,
  pushNotificationsBusy,
  canUsePushNotifications,
  handlePushNotificationsChange,
  shareBehavior,
  setShareBehavior,
  analytics,
  analyticsBusy,
  handleAnalyticsChange,
  sessionReplay,
  sessionReplayBusy,
  handleSessionReplayChange,
  recentCount,
  confirmClearRecents,
}: Props) {
  return (<Group styles={styles} title={t("settings.section.preferences")}>
    <Row
      styles={styles}
      palette={palette}
      icon="language-outline"
      label={t("settings.language.label")}
      value={t(
        LANGUAGE_OPTIONS.find((option) => option.value === languagePref)
          ?.labelKey ?? "settings.language.system",
      )}
      onPress={() => setLanguageSheetOpen(true)}
    />
    <Row
      styles={styles}
      palette={palette}
      icon="sparkles-outline"
      label={t("settings.aiSuggestions.label")}
      value={t(
        AI_SUGGESTIONS_MODE_OPTIONS.find(
          (option) => option.value === aiSuggestionsMode,
        )?.labelKey ?? "settings.aiSuggestions.confirm",
      )}
      onPress={() => setAiSuggestionsSheetOpen(true)}
    />
    {/* The AI backlog/quota counters that used to live here moved to the
            Activity section's single "AI suggestions" row (STASH settings
            counter cleanup) — this row stays a pure mode selector. */}
    <Row
      styles={styles}
      palette={palette}
      icon="notifications-outline"
      label={t("settings.pushNotifications.label")}
      value={
        Platform.OS === "web"
          ? t("settings.pushNotifications.unsupportedPlatform")
          : !isAuthenticated
            ? t("settings.pushNotifications.signInRequired")
            : aiSuggestionsMode === "off"
              ? t("settings.pushNotifications.aiOff")
              : pushNotificationsEnabled
                ? t("settings.pushNotifications.on")
                : t("settings.pushNotifications.off")
      }
      right={
        pushNotificationsBusy ? (
          <ActivityIndicator color={palette.textSecondary} />
        ) : (
          <Switch
            accessibilityLabel={t("settings.pushNotifications.label")}
            value={pushNotificationsEnabled}
            disabled={!canUsePushNotifications}
            onValueChange={handlePushNotificationsChange}
            trackColor={{ true: palette.accent, false: palette.border }}
            thumbColor="#ffffff"
          />
        )
      }
    />
    <Row
      styles={styles}
      palette={palette}
      icon="share-outline"
      label={t("settings.share.label")}
      value={
        shareBehavior === "inbox"
          ? t("settings.share.inbox")
          : t("settings.share.toast")
      }
      right={
        <Switch
          value={shareBehavior === "inbox"}
          onValueChange={(on) => setShareBehavior(on ? "inbox" : "toast")}
          trackColor={{ true: palette.accent, false: palette.border }}
          thumbColor="#ffffff"
        />
      }
    />
    <Row
      styles={styles}
      palette={palette}
      icon="analytics-outline"
      label={t("settings.analytics.label")}
      value={
        !analytics.configured
          ? t("settings.analytics.unconfigured")
          : analytics.enabled
            ? t("settings.analytics.enabled")
            : t("settings.analytics.disabled")
      }
      right={
        <Switch
          accessibilityLabel={t("settings.analytics.label")}
          value={analytics.configured && analytics.enabled}
          disabled={!analytics.configured || !analytics.ready || analyticsBusy}
          onValueChange={handleAnalyticsChange}
          trackColor={{ true: palette.accent, false: palette.border }}
          thumbColor="#ffffff"
        />
      }
    />
    {/* Hidden entirely (not just disabled) when this build has no
            build-time PostHog full-SDK gate — the toggle can never work in
            that build, so showing a permanently-dimmed row would just be
            confusing clutter on every build that hasn't opted into the
            trial, which is the default/common case. */}
    {sessionReplay.configured && (
      <Row
        styles={styles}
        palette={palette}
        icon="analytics-outline"
        label={t("settings.sessionReplay.label")}
        value={
          sessionReplay.enabled
            ? t("settings.sessionReplay.enabled")
            : t("settings.sessionReplay.disabled")
        }
        right={
          <Switch
            accessibilityLabel={t("settings.sessionReplay.label")}
            value={sessionReplay.enabled}
            disabled={
              !analytics.enabled || !sessionReplay.ready || sessionReplayBusy
            }
            onValueChange={handleSessionReplayChange}
            trackColor={{ true: palette.accent, false: palette.border }}
            thumbColor="#ffffff"
          />
        }
      />
    )}
    {/* Clear search history (A3): the privacy escape hatch for the recents
            shelf. Disabled (no onPress) and reading "No recent searches" when
            there's nothing to clear. The a11y label is the reserved
            `search.clearRecentsA11y` rather than the visible label. */}
    <Row
      styles={styles}
      palette={palette}
      icon="time-outline"
      label={t("settings.search.clearLabel")}
      value={
        recentCount > 0
          ? t("settings.search.clearValue", { count: recentCount })
          : t("settings.search.clearEmpty")
      }
      accessibilityLabel={t("search.clearRecentsA11y")}
      last
      disabled={recentCount === 0}
      onPress={recentCount > 0 ? confirmClearRecents : undefined}
    />
  </Group>);
}
