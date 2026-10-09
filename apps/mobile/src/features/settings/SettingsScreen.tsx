import { AccountSection } from '@/features/settings/AccountSection';
import { ActivitySection } from '@/features/settings/ActivitySection';
import { DataSection } from '@/features/settings/DataSection';
import { AI_SUGGESTIONS_MODE_OPTIONS, DEVELOPER_MODE_PREF_KEY, formatQuotaResetTime, LANGUAGE_OPTIONS, makeStyles, showAlert, webOverscrollContain } from '@/features/settings/layout';
import { PreferencesSection } from '@/features/settings/PreferencesSection';
import { Group, InfoRow, Row } from '@/features/settings/presentation';
import { useAccountActions } from '@/features/settings/use-account-actions';
import { useExportActions } from '@/features/settings/use-export-actions';
import { useImportActions } from '@/features/settings/use-import-actions';
import { useResetActions } from '@/features/settings/use-reset-actions';
import { useFloatingReportPreference } from "@/feedback/floating-report-preference";
import { useOpenReport } from "@/feedback/open-report";
import { Ionicons } from "@expo/vector-icons";
import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState, type ElementRef } from "react";
import {
  AccessibilityInfo,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  useWindowDimensions,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { usePostHogFull } from "@/analytics-full/posthog-full-runtime";
import { useAnalytics } from "@/analytics/provider";
import { describeAppVersion, describeBuild, getBuildInfo } from "@/domain/build-info";
import {
  DEFAULT_PUSH_NOTIFICATIONS_ENABLED,
  LAST_REGISTERED_PUSH_TOKEN_PREF_KEY,
  parsePushNotificationsEnabled,
  PUSH_NOTIFICATIONS_PREF_KEY,
  serializePushNotificationsEnabled,
} from "@/domain/push-notifications-pref";
import {
  parseRecents,
  RECENT_SEARCHES_PREF_KEY,
  serializeRecents,
} from "@/domain/recent-searches";
import {
  DEFAULT_SHARE_BEHAVIOR,
  parseShareBehavior,
  serializeShareBehavior,
  SHARE_BEHAVIOR_PREF_KEY,
  type ShareBehavior,
} from "@/domain/share-behavior";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { requestPushPermissionAndToken } from "@/notifications/push-permission";
import { createDefaultPushTokenWriter } from "@/notifications/push-token-client";
import {
  deregisterPushToken,
  registerPushToken,
} from "@/notifications/push-token-registration";
import { getPreference, setPreference } from "@/storage/preferences";
import { useBookmarks } from "@/store/bookmarks";
import { useSupabaseAuth } from "@/supabase/auth-provider";
import { getPullDiagnostics } from "@/sync/pull-diagnostics";
import { isPermanentlyUnsyncableUrl } from "@/sync/sync-bookmarks";
import { usePalette } from "@/theme";
import { ActionSheet } from "@/ui/ActionSheet";
import { BookmarkletButton } from "@/ui/BookmarkletButton";
import { ResetLibraryDialog } from "@/ui/ResetLibraryDialog";
import { SyncDiagnostics } from "@/ui/SyncDiagnostics";
import { TutorialModal } from "@/ui/TutorialModal";
import { useNetworkOffline } from "@/ui/use-network-offline";

export default function SettingsScreen() {
  const palette = usePalette();
  const styles = makeStyles(palette);
  const router = useRouter();
  const params = useLocalSearchParams<{ focus?: string }>();
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  const accountScrollPending = useRef(false);
  const { openReport, capturing } = useOpenReport('/settings');
  const [floatingReport, setFloatingReport] = useFloatingReportPreference();
  // Wide viewports present Settings as a right-side sheet over a dimmed Inbox;
  // phones keep the full-screen layout. One width rule, no Platform branch.
  const { width, height } = useWindowDimensions();
  const asSheet = width >= 760;
  const {
    t,
    preference: languagePref,
    setLocalePreference,
    formatDate,
  } = useI18n();
  const {
    queue,
    isSyncing,
    syncNow,
    librarySyncFlow,
    accountLibraryState = "ready",
    accountTransferCount = 0,
    dismissAccountTransfer,
    syncPaused,
    setSyncPaused,
    inbox,
    trash,
    lastPulledAt,
    collections,
    getTagsForBookmark,
    getEnrichment,
    importBookmarks,
    resetLibrary,
    isResettingLibrary,
    aiSuggestionsMode,
    setAiSuggestionsMode,
    processingStats,
    aiQuotaExceeded,
  } = useBookmarks();
  const [aiSuggestionsSheetOpen, setAiSuggestionsSheetOpen] = useState(false);
  const [processingDetailsOpen, setProcessingDetailsOpen] = useState(false);
  const [processingStagesOpen, setProcessingStagesOpen] = useState(false);
  const [diagnosticCountsOpen, setDiagnosticCountsOpen] = useState(false);
  const [appInfoCopied, setAppInfoCopied] = useState(false);
  const auth = useSupabaseAuth();
  const offline = useNetworkOffline();
  const analytics = useAnalytics();
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const sessionReplay = usePostHogFull();
  const [sessionReplayBusy, setSessionReplayBusy] = useState(false);

  const handleAnalyticsChange = (enabled: boolean) => {
    if (!analytics.configured || !analytics.ready || analyticsBusy) return;
    setAnalyticsBusy(true);
    // Narrower consent (session replay) doesn't survive revoking the broader
    // one (base analytics) — cascade the opt-out unconditionally (not gated
    // on the current `sessionReplay.enabled` read, which can be stale if a
    // replay opt-in is still in flight) and in parallel with the base call
    // (not sequenced after it succeeds), so the cascade still runs even if
    // the base call itself rejects after already flipping its own in-memory
    // state to off. `PostHogFullProvider.setEnabled` internally serializes
    // against any in-flight opt-in, so this can never race to a stale result.
    const cascade = enabled ? Promise.resolve() : sessionReplay.setEnabled(false);
    void Promise.all([analytics.setEnabled(enabled), cascade])
      .catch(() =>
        showAlert(
          t("settings.analytics.errorTitle"),
          t("settings.analytics.errorBody"),
        ),
      )
      .finally(() => setAnalyticsBusy(false));
  };

  const handleSessionReplayChange = (enabled: boolean) => {
    if (
      !sessionReplay.configured ||
      !analytics.enabled ||
      !sessionReplay.ready ||
      sessionReplayBusy
    )
      return;
    setSessionReplayBusy(true);
    void sessionReplay
      .setEnabled(enabled)
      .catch(() =>
        showAlert(
          t("settings.sessionReplay.errorTitle"),
          t("settings.sessionReplay.errorBody"),
        ),
      )
      .finally(() => setSessionReplayBusy(false));
  };
  const { authBusy, tutorialOpen, setTutorialOpen, handleSignIn, handleSignOut } = useAccountActions({
    auth,
    t,
  });

  // Data export: build a portable file from the on-device library and hand it
  // to the platform delivery shim (browser download on web, share sheet on
  // native). This is the user's "your data is yours" escape hatch — it works
  // offline and produces formats other apps can import.
  const [exportSheetOpen, setExportSheetOpen] = useState(false);
  // Android only: the format the user picked, while the follow-up "share or
  // save to device" sheet is open (null = sheet closed). iOS/web deliver
  // immediately — the iOS share sheet already offers "Save to Files" and the
  // web path is a direct download.
  const [exportDeliveryKind, setExportDeliveryKind] = useState<
    "html" | "json" | "csv" | null
  >(null);
  const [exporting, setExporting] = useState(false);
  const [languageSheetOpen, setLanguageSheetOpen] = useState(false);
  const totalBookmarks = inbox.length;
  const { chooseExport, runExport } = useExportActions({
    collections,
    setExportSheetOpen,
    setExportDeliveryKind,
    exporting,
    setExporting,
    inbox,
    getTagsForBookmark,
    getEnrichment,
    t,
  });
  const { importSheetOpen, setImportSheetOpen, importing, runImport } = useImportActions({
    importBookmarks,
    t,
  });
  const { resetDialogOpen, setResetDialogOpen, resetError, setResetError, runReset } = useResetActions({
    isResettingLibrary,
    resetLibrary,
    t,
  });

  // Developer mode hides diagnostics behind an opt-in so the everyday screen
  // stays compact. Persisted so it survives app restarts.
  const [developerMode, setDeveloperMode] = useState(false);
  const devLoaded = useRef(false);
  useEffect(() => {
    let active = true;
    getPreference(DEVELOPER_MODE_PREF_KEY)
      .then((raw) => {
        if (active) {
          setDeveloperMode(raw === "true");
        }
      })
      .catch(() => { })
      .finally(() => {
        devLoaded.current = true;
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!devLoaded.current) {
      return;
    }
    void setPreference(
      DEVELOPER_MODE_PREF_KEY,
      developerMode ? "true" : "false",
    ).catch(() => { });
  }, [developerMode]);

  // Recent-search count drives the "Clear search history" row (label + disabled
  // state). Loaded the same way the Inbox loads recents — local-only meta store,
  // never synced. Mirrors the `recentsLoaded`-style guard so the initial empty
  // default can't clobber anything; here it just gates the load.
  const [recentCount, setRecentCount] = useState(0);
  useEffect(() => {
    let active = true;
    getPreference(RECENT_SEARCHES_PREF_KEY)
      .then((raw) => {
        if (active) {
          setRecentCount(parseRecents(raw).length);
        }
      })
      .catch(() => { });
    return () => {
      active = false;
    };
  }, []);

  // Clear search history (A3): wipe the persisted recents after a confirm. The
  // write is local-only and fire-and-forget (recents never sync); the row flips
  // to its disabled empty state optimistically via `recentCount` → 0. The Inbox
  // re-reads recents on focus, so returning there shows no recents.
  const clearRecentSearches = () => {
    setRecentCount(0);
    void setPreference(RECENT_SEARCHES_PREF_KEY, serializeRecents([])).catch(
      () => { },
    );
  };
  const confirmClearRecents = () => {
    if (Platform.OS === "web") {
      if (
        typeof confirm === "undefined" ||
        confirm(t("settings.search.clearConfirmTitle"))
      ) {
        clearRecentSearches();
      }
      return;
    }
    Alert.alert(
      t("settings.search.clearConfirmTitle"),
      t("settings.search.clearConfirmBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("settings.search.clearConfirm"),
          style: "destructive",
          onPress: clearRecentSearches,
        },
      ],
    );
  };

  // What happens after a URL is shared in from another app. Default is a
  // modeless toast (no navigation); opting in lands on the Inbox instead.
  const [shareBehavior, setShareBehavior] = useState<ShareBehavior>(
    DEFAULT_SHARE_BEHAVIOR,
  );
  const shareLoaded = useRef(false);
  useEffect(() => {
    let active = true;
    getPreference(SHARE_BEHAVIOR_PREF_KEY)
      .then((raw) => {
        if (active) {
          setShareBehavior(parseShareBehavior(raw));
        }
      })
      .catch(() => { })
      .finally(() => {
        shareLoaded.current = true;
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!shareLoaded.current) {
      return;
    }
    void setPreference(
      SHARE_BEHAVIOR_PREF_KEY,
      serializeShareBehavior(shareBehavior),
    ).catch(() => { });
  }, [shareBehavior]);

  const insets = useSafeAreaInsets();
  const isAuthenticated = auth.status === "authenticated";
  const accountFocused = params.focus === "account" &&
    !isAuthenticated && auth.status !== "loading" && auth.status !== "not_configured";

  useEffect(() => {
    accountScrollPending.current = accountFocused;
    if (accountFocused) {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
      AccessibilityInfo.announceForAccessibility(t("settings.account.signInGuide"));
    }
  }, [accountFocused, t]);

  // Push notification for AI-catchup (STASH #579): "notify once the AI
  // enrichment overflow queue (#578) fully drains for this user." Opt-in
  // only — the OS permission prompt only fires when the user flips this on,
  // never on launch. Loaded/persisted the same local-preference way as the
  // other toggles above.
  const [pushNotificationsEnabled, setPushNotificationsEnabled] = useState(
    DEFAULT_PUSH_NOTIFICATIONS_ENABLED,
  );
  const [pushNotificationsBusy, setPushNotificationsBusy] = useState(false);
  useEffect(() => {
    let active = true;
    getPreference(PUSH_NOTIFICATIONS_PREF_KEY)
      .then((raw) => {
        if (active) {
          setPushNotificationsEnabled(parsePushNotificationsEnabled(raw));
        }
      })
      .catch(() => { });
    return () => {
      active = false;
    };
  }, []);

  // Requires a real (non-anonymous) session — an anonymous device has no
  // stable cross-device identity to bind a token to, see the push_tokens
  // migration — AND an AI-suggestions mode other than `off`, since `off`
  // means nothing ever queues for the backend worker to notify about.
  // Remote push notifications are also unsupported on web.
  // Rather than hide the row when either is unmet, it stays visible but
  // disabled with an explanatory value line (same pattern as "Clear search
  // history" below), so the setting doesn't appear to vanish. Turning AI
  // suggestions back on does NOT require re-flipping this toggle: an
  // already-enabled preference (and its registered token, if any) is left
  // alone rather than force-cleared while suggestions are off.
  const canUsePushNotifications =
    Platform.OS !== "web" && isAuthenticated && aiSuggestionsMode !== "off";

  const handlePushNotificationsChange = (enabled: boolean) => {
    if (pushNotificationsBusy || !canUsePushNotifications) {
      return;
    }
    setPushNotificationsBusy(true);
    void (async () => {
      // Everything below is best-effort and must never surface an unhandled
      // rejection or leave the switch stuck busy — wrapping the whole flow
      // (not just the individual client calls, which already swallow their
      // own errors) covers e.g. createSupabaseClient() throwing when
      // Supabase env vars are missing.
      try {
        await runPushNotificationsChange(enabled);
      } catch (err) {
        console.warn("[push-notifications] Toggle handling failed:", err);
        setPushNotificationsEnabled(false);
        await setPreference(
          PUSH_NOTIFICATIONS_PREF_KEY,
          serializePushNotificationsEnabled(false),
        ).catch(() => { });
        showAlert(
          t("settings.pushNotifications.unavailableTitle"),
          t("settings.pushNotifications.unavailableBody"),
        );
      }
    })().finally(() => setPushNotificationsBusy(false));
  };

  const runPushNotificationsChange = async (enabled: boolean) => {
    if (!enabled) {
      setPushNotificationsEnabled(false);
      await setPreference(
        PUSH_NOTIFICATIONS_PREF_KEY,
        serializePushNotificationsEnabled(false),
      ).catch(() => { });
      // Best-effort deregister of whatever token this device last
      // registered. Never surfaced to the user and never lets a failure
      // stop the toggle from turning off locally — a leftover server-side
      // token is harmless (Expo/the worker prune it once it's stale) and
      // this must never block anything (Capture is sacred extends here:
      // nothing about this feature may block or delay unrelated UI).
      const lastToken = await getPreference(
        LAST_REGISTERED_PUSH_TOKEN_PREF_KEY,
      ).catch(() => null);
      if (lastToken && auth.session) {
        await deregisterPushToken({
          client: createDefaultPushTokenWriter(),
          session: auth.session,
          token: lastToken,
        });
      }
      await setPreference(LAST_REGISTERED_PUSH_TOKEN_PREF_KEY, "").catch(
        () => { },
      );
      return;
    }

    const outcome = await requestPushPermissionAndToken();
    if (outcome.outcome !== "granted") {
      setPushNotificationsEnabled(false);
      await setPreference(
        PUSH_NOTIFICATIONS_PREF_KEY,
        serializePushNotificationsEnabled(false),
      ).catch(() => { });
      if (outcome.outcome === "denied") {
        showAlert(
          t("settings.pushNotifications.deniedTitle"),
          t("settings.pushNotifications.deniedBody"),
        );
      } else if (
        outcome.outcome === "no_project_id" ||
        outcome.outcome === "unsupported"
      ) {
        showAlert(
          t("settings.pushNotifications.unavailableTitle"),
          t("settings.pushNotifications.unavailableBody"),
        );
      }
      return;
    }

    if (!auth.session) {
      // Session dropped mid-flow (e.g. a sign-out raced the permission
      // prompt) — nothing to register a token against.
      setPushNotificationsEnabled(false);
      return;
    }

    const registered = await registerPushToken({
      client: createDefaultPushTokenWriter(),
      session: auth.session,
      token: outcome.token,
      platform: outcome.platform,
    });
    if (!registered) {
      setPushNotificationsEnabled(false);
      await setPreference(
        PUSH_NOTIFICATIONS_PREF_KEY,
        serializePushNotificationsEnabled(false),
      ).catch(() => { });
      showAlert(
        t("settings.pushNotifications.unavailableTitle"),
        t("settings.pushNotifications.unavailableBody"),
      );
      return;
    }

    setPushNotificationsEnabled(true);
    await Promise.all([
      setPreference(
        PUSH_NOTIFICATIONS_PREF_KEY,
        serializePushNotificationsEnabled(true),
      ).catch(() => { }),
      setPreference(LAST_REGISTERED_PUSH_TOKEN_PREF_KEY, outcome.token).catch(
        () => { },
      ),
    ]);
  };

  // Sync row is status-led: the right-hand glyph is the action/state.
  //  - cloud reachable + something queued → tappable refresh (upload-then-pull)
  //  - syncing → spinner
  //  - cloud reachable + nothing queued → a static "all backed up" checkmark
  //  - no cloud session (anonymous works, only "not configured" lacks one) →
  //    "local only", no glyph. Pulls still happen automatically (on sign-in /
  //    account switch / when work is queued), so there is no manual-pull button.
  // A permanently-too-long URL (Sentry STASH-2J) stays in the queue forever
  // (removing it would make startup orphan reconciliation rebuild a fresh,
  // equally doomed create for the same bookmark) but can never actually
  // sync, so it must not count as "waiting" — that would show a stuck
  // syncing/refresh state that can never clear.
  const waiting = queue.filter(
    (entry) =>
      entry.sync_status !== "synced" && !isPermanentlyUnsyncableUrl(entry),
  ).length;
  const cloudAvailable = auth.isSignedIn; // anonymous OR authenticated session
  const hasPending = waiting > 0 || (librarySyncFlow?.remaining ?? 0) > 0
    || ["retrying", "attention", "sign_in", "permission"].includes(librarySyncFlow?.phase ?? "idle");
  const canSync =
    cloudAvailable &&
    hasPending &&
    !isSyncing &&
    !isResettingLibrary &&
    !syncPaused && !offline && librarySyncFlow?.phase !== "offline";

  // A bookmark may be uploading, fetching metadata, and queued for AI at the
  // same time. `processingStats` assigns it to exactly one display stage
  // (attention > cloud > metadata > AI), so these rows add up to `remaining`
  // instead of exposing overlapping pipeline totals.
  const queueBlocksAiDispatch = queue.some(
    (entry) =>
      entry.sync_status === "pending" || entry.sync_status === "syncing",
  );
  const aiQuotaResetTime = aiQuotaExceeded
    ? formatQuotaResetTime(aiQuotaExceeded.retryAt, formatDate)
    : null;
  const incompleteSyncSummary = !cloudAvailable && librarySyncFlow?.phase !== "sign_in" ? null : librarySyncFlow?.phase === "retrying" ? t("library.delayed")
    : librarySyncFlow?.phase === "attention" ? t("library.attention")
      : librarySyncFlow?.phase === "sign_in" ? t(auth.status === "error" || auth.status === "session_expired" ? "library.resume" : "library.attention")
        : librarySyncFlow?.phase === "permission" ? t("library.permission")
          : librarySyncFlow?.phase === "working" ? t("library.syncing")
            : librarySyncFlow?.phase === "offline" ? t("library.offline")
              : librarySyncFlow?.phase === "paused" ? t("library.paused") : null;
  const processingSummary =
    processingStats.remaining === 0 && incompleteSyncSummary ? incompleteSyncSummary
      : processingStats.remaining === 0
        ? t("settings.processing.complete")
        : processingStats.stages.attention > 0
          ? t("settings.processing.remainingWithAttention", {
            count: processingStats.remaining,
            attention: processingStats.stages.attention,
          })
          : t("settings.processing.remaining", { count: processingStats.remaining });
  const cloudStageValue = !cloudAvailable
    ? t("settings.processing.cloud.localOnly", {
      count: processingStats.stages.cloud,
    })
    : syncPaused
      ? t("settings.processing.cloud.paused", {
        count: processingStats.stages.cloud,
      })
      : isSyncing
        ? t("settings.processing.cloud.syncing", {
          count: processingStats.stages.cloud,
        })
        : t("settings.processing.count", { count: processingStats.stages.cloud });
  const aiStageValue = aiQuotaResetTime
    ? t("settings.processing.ai.quota", {
      count: processingStats.stages.ai,
      resetTime: aiQuotaResetTime,
    })
    : aiSuggestionsMode === "off"
      ? t("settings.processing.ai.off", { count: processingStats.stages.ai })
      : syncPaused && queueBlocksAiDispatch
        ? t("settings.processing.ai.localPaused", {
          count: processingStats.stages.ai,
        })
        : t("settings.processing.count", { count: processingStats.stages.ai });

  // Recorded by `sync/pull-diagnostics.ts` on every pull attempt (success or
  // failure), newest first, so a stuck/failed pull leaves durable evidence
  // that survives a reload instead of only living in the session log buffer.
  const recentPulls = getPullDiagnostics();

  const build = getBuildInfo(Constants.expoConfig?.extra);
  const storeVersion = describeAppVersion(
    Constants.expoConfig?.version,
    Application.nativeBuildVersion,
  );
  const appVersion = `${storeVersion} (Expo SDK ${Constants.expoConfig?.sdkVersion ?? "56"
    })`;
  // Always-visible footer line so the deployed version/commit is verifiable
  // without opening Developer mode. Appends the commit when one is baked in.
  const buildLine =
    `Keepory ${storeVersion}` +
    (build.shortSha
      ? ` · ${build.ref ? `${build.ref} @ ` : ""}${build.shortSha}`
      : "");

  const content = (
    <ScrollView
      ref={scrollRef}
      onContentSizeChange={() => {
        if (accountScrollPending.current) {
          accountScrollPending.current = false;
          scrollRef.current?.scrollTo({ y: 0, animated: false });
        }
      }}
      style={[styles.scroll, webOverscrollContain]}
      contentContainerStyle={[
        styles.container,
        { paddingBottom: insets.bottom + 24 },
      ]}
    >
      {/* Account — identity, sign in/out only. Sync/metadata/AI status moved
          to the Activity section below (STASH settings counter cleanup): this
          card is purely who's signed in, not what's happening. */}
      <AccountSection
        styles={styles}
        t={t}
        isAuthenticated={isAuthenticated}
        auth={auth}
        authBusy={authBusy}
        handleSignOut={handleSignOut}
        handleSignIn={handleSignIn}
        accountFocused={accountFocused}
        accountLibraryState={accountLibraryState}
        accountTransferCount={accountTransferCount}
        dismissAccountTransfer={dismissAccountTransfer}
        offline={offline}
        syncPaused={syncPaused}
        syncNow={syncNow}
        setSyncPaused={setSyncPaused}
      />

      {/* Activity — a single deduplicated summary line. The four raw
          pipeline stages and their diagnostic breakdown moved to Developer
          mode (below the Advanced toggle) so the everyday screen stays to
          one row; the sync controls that used to live on the cloud-stage row
          live here instead since they act on sync regardless of which stage
          is showing. */}
      <ActivitySection
        styles={styles}
        t={t}
        palette={palette}
        processingSummary={processingSummary}
        cloudAvailable={cloudAvailable}
        isSyncing={isSyncing}
        canSync={canSync}
        syncNow={syncNow}
        offline={offline}
        librarySyncFlow={librarySyncFlow}
        syncPaused={syncPaused}
        isResettingLibrary={isResettingLibrary}
        setSyncPaused={setSyncPaused}
      />

      {/* Library — navigation into the user's own content. Reviewing AI
          suggestions now lives on the Inbox (the persistent review banner), not
          here — Settings is for configuration, not a recurring workflow. */}
      <Group styles={styles} title={t("settings.section.library")}>
        <Row
          styles={styles}
          palette={palette}
          icon="trash-outline"
          label={t("settings.trash.label")}
          value={t("settings.trash.value", { count: trash.length })}
          last
          onPress={() => router.push("/trash")}
        />
      </Group>

      {/* Preferences — everyday app behaviour: language, share landing, and the
          search-history privacy control. */}
      <PreferencesSection
        styles={styles}
        t={t}
        palette={palette}
        languagePref={languagePref}
        setLanguageSheetOpen={setLanguageSheetOpen}
        aiSuggestionsMode={aiSuggestionsMode}
        setAiSuggestionsSheetOpen={setAiSuggestionsSheetOpen}
        isAuthenticated={isAuthenticated}
        pushNotificationsEnabled={pushNotificationsEnabled}
        pushNotificationsBusy={pushNotificationsBusy}
        canUsePushNotifications={canUsePushNotifications}
        handlePushNotificationsChange={handlePushNotificationsChange}
        shareBehavior={shareBehavior}
        setShareBehavior={setShareBehavior}
        analytics={analytics}
        analyticsBusy={analyticsBusy}
        handleAnalyticsChange={handleAnalyticsChange}
        sessionReplay={sessionReplay}
        sessionReplayBusy={sessionReplayBusy}
        handleSessionReplayChange={handleSessionReplayChange}
        recentCount={recentCount}
        confirmClearRecents={confirmClearRecents}
      />

      {/* Save from your browser — the desktop bookmarklet (web only). Native
          apps capture via the OS share sheet, so this is meaningless there. */}
      {Platform.OS === "web" ? (
        <Group
          styles={styles}
          title={t("settings.section.browser")}
          footnote={t("settings.bookmarklet.note")}
        >
          <View style={styles.bookmarkletRow}>
            <BookmarkletButton
              label={t("settings.bookmarklet.button")}
              copiedLabel={t("settings.bookmarklet.copied")}
              accent={palette.accent}
            />
          </View>
        </Group>
      ) : null}

      {/* Your data — export / import / portability. */}
      <DataSection
        styles={styles}
        t={t}
        palette={palette}
        exporting={exporting}
        totalBookmarks={totalBookmarks}
        isResettingLibrary={isResettingLibrary}
        setExportSheetOpen={setExportSheetOpen}
        importing={importing}
        setImportSheetOpen={setImportSheetOpen}
        auth={auth}
        setResetError={setResetError}
        setResetDialogOpen={setResetDialogOpen}
      />

      {/* Help & Guide — introductory feature tutorial and app walkthrough */}
      <Group styles={styles} title={t("settings.section.help")}>
        <Row
          styles={styles}
          palette={palette}
          icon="help-circle-outline"
          label={t("settings.tutorial.label")}
          value={t("settings.tutorial.value")}
          testID="settings-tutorial-row"
          onPress={() => setTutorialOpen(true)}
        />
        <Row
          styles={styles}
          palette={palette}
          icon="chatbubble-ellipses-outline"
          label={t("settings.report.label")}
          value={t("settings.report.value")}
          testID="settings-report-row"
          onPress={capturing ? undefined : () => void openReport()}
        />
        <Row
          styles={styles}
          palette={palette}
          icon="chatbubbles-outline"
          label={t("settings.floatingReport.label")}
          value={t("settings.floatingReport.value")}
          last
          testID="settings-floating-report-row"
          right={
            <Switch
              accessibilityLabel={t("settings.floatingReport.label")}
              value={floatingReport}
              onValueChange={setFloatingReport}
              trackColor={{ true: palette.accent, false: palette.border }}
              thumbColor="#ffffff"
            />
          }
        />
      </Group>

      {/* Advanced — developer mode toggle, and the diagnostics it reveals. */}
      <Group styles={styles} title={t("settings.section.advanced")}>
        <Row
          styles={styles}
          palette={palette}
          icon="construct-outline"
          label={t("settings.developer.label")}
          value={t("settings.developer.value")}
          last
          right={
            <Switch
              accessibilityLabel={t("settings.developer.label")}
              value={developerMode}
              onValueChange={setDeveloperMode}
              trackColor={{ true: palette.accent, false: palette.border }}
              thumbColor="#ffffff"
            />
          }
        />
      </Group>

      {developerMode ? (
        <>
          <SyncDiagnostics
            status={!cloudAvailable && librarySyncFlow?.phase !== "sign_in" ? t("settings.sync.localOnly")
              : incompleteSyncSummary ?? t("settings.diagnostics.noCloudWork")}
            lastPulledAt={lastPulledAt}
            remaining={librarySyncFlow?.remaining ?? waiting}
            recentPulls={recentPulls}
            reporting={capturing}
            attention={["attention", "sign_in", "permission"].includes(librarySyncFlow?.phase ?? "idle")}
            onReport={() => void openReport()}
          />
          <Group styles={styles} title={t("settings.diagnostics.workTitle")}>
            <Row styles={styles} palette={palette} icon="layers-outline"
              label={t("settings.diagnostics.workTitle")}
              value={processingStats.remaining === 0 ? t("settings.diagnostics.noWork") : processingSummary}
              onPress={() => setProcessingStagesOpen(open => !open)}
              expanded={processingStagesOpen}
              right={<Ionicons name={processingStagesOpen ? "chevron-up" : "chevron-down"} size={18} color={palette.textSecondary} />}
            />
            {processingStagesOpen ? <>
              <Row
                styles={styles}
                palette={palette}
                icon={syncPaused ? "pause-circle-outline" : "cloud-upload-outline"}
                label={t("settings.processing.cloud.label")}
                value={cloudStageValue}
                testID="processing-stage-cloud"
              />
              <Row
                styles={styles}
                palette={palette}
                icon="document-text-outline"
                label={t("settings.processing.metadata.label")}
                value={t("settings.processing.count", {
                  count: processingStats.stages.metadata,
                })}
                testID="processing-stage-metadata"
              />
              <Row
                styles={styles}
                palette={palette}
                icon={aiQuotaResetTime ? "hourglass-outline" : "sparkles-outline"}
                label={t("settings.processing.ai.label")}
                value={aiStageValue}
                testID="processing-stage-ai"
              />
              <Row
                styles={styles}
                palette={palette}
                icon={
                  processingStats.stages.attention > 0
                    ? "warning-outline"
                    : "checkmark-circle-outline"
                }
                label={t("settings.processing.attention.label")}
                value={t("settings.processing.count", {
                  count: processingStats.stages.attention,
                })}
                accent={processingStats.stages.attention > 0}
                testID="processing-stage-attention"
              />
              <Row
                styles={styles}
                palette={palette}
                icon="analytics-outline"
                label={t("settings.processing.details.label")}
                value={t(
                  processingDetailsOpen
                    ? "settings.processing.details.hide"
                    : "settings.processing.details.show",
                )}
                onPress={() => setProcessingDetailsOpen((open) => !open)}
                right={
                  <Ionicons
                    name={processingDetailsOpen ? "chevron-up" : "chevron-down"}
                    size={18}
                    color={palette.textSecondary}
                  />
                }
              />
              {processingDetailsOpen ? (
                <>
                  <InfoRow styles={styles} label={t("settings.diagnostics.supabaseAuth")} value={auth.status} />
                  <InfoRow
                    styles={styles}
                    label={t("settings.processing.details.syncStates.label")}
                    value={t("settings.processing.details.syncStates.value", {
                      pending: processingStats.details.sync.pending,
                      syncing: processingStats.details.sync.syncing,
                      failed: processingStats.details.sync.failed,
                    })}
                  />
                  <InfoRow
                    styles={styles}
                    label={t("settings.processing.details.syncOps.label")}
                    value={t("settings.processing.details.syncOps.value", {
                      create: processingStats.details.sync.operations.create,
                      update: processingStats.details.sync.operations.update,
                      delete: processingStats.details.sync.operations.delete,
                    })}
                  />
                  <InfoRow
                    styles={styles}
                    label={t("settings.processing.details.syncHealth.label")}
                    value={t("settings.processing.details.syncHealth.value", {
                      retries: processingStats.details.sync.maxRetries,
                      oldest: processingStats.details.sync.oldestCreatedAt
                        ? formatDate(processingStats.details.sync.oldestCreatedAt)
                        : t("settings.processing.details.none"),
                    })}
                  />
                  <InfoRow
                    styles={styles}
                    label={t("settings.processing.details.metadata.label")}
                    value={t("settings.processing.details.metadata.value", {
                      pending: processingStats.details.metadata.pending,
                      failed: processingStats.details.metadata.failed,
                      skipped: processingStats.details.metadata.skipped,
                    })}
                  />
                  <InfoRow
                    styles={styles}
                    label={t("settings.processing.details.aiLocal.label")}
                    value={t("settings.processing.details.aiLocal.value", {
                      trigger: processingStats.details.ai.trigger,
                      dispatch: processingStats.details.ai.dispatch,
                      retry: processingStats.details.ai.retry,
                      active: processingStats.details.ai.inFlight,
                    })}
                  />
                  <InfoRow
                    styles={styles}
                    label={t("settings.processing.details.aiServer.label")}
                    value={t("settings.processing.details.aiServer.value", {
                      pending: processingStats.details.ai.serverPending,
                      processing: processingStats.details.ai.serverProcessing,
                      failed: processingStats.details.ai.serverFailed,
                    })}
                  />
                  <InfoRow
                    styles={styles}
                    label={t("settings.processing.details.degraded.label")}
                    value={t("settings.processing.details.degraded.value", {
                      count: processingStats.details.ai.degradedRateLimited,
                    })}
                  />
                </>
              ) : null}
            </> : null}
          </Group>
          <Group styles={styles} title={t("settings.diagnostics.countsTitle")}
            footnote={diagnosticCountsOpen ? t("settings.diagnostics.countsScope") : undefined}>
            <Row styles={styles} palette={palette} icon="stats-chart-outline"
              label={t("settings.diagnostics.countsTitle")}
              value={t("settings.diagnostics.countsHint")}
              onPress={() => setDiagnosticCountsOpen(open => !open)}
              expanded={diagnosticCountsOpen}
              right={<Ionicons name={diagnosticCountsOpen ? "chevron-up" : "chevron-down"} size={18} color={palette.textSecondary} />}
            />
            {diagnosticCountsOpen ? <>
              <InfoRow
                styles={styles}
                label={t("settings.diagnostics.syncLifecycle.label")}
                value={t("settings.diagnostics.syncLifecycle.value", {
                  once: processingStats.diagnostics.sync.done,
                  twice: processingStats.diagnostics.sync.syncingTwice,
                })}
              />
              <InfoRow
                styles={styles}
                label={t("settings.diagnostics.metadataDone.label")}
                value={t("settings.diagnostics.metadataDone.value", {
                  done: processingStats.diagnostics.metadata.done,
                })}
              />
              <InfoRow
                styles={styles}
                label={t("settings.diagnostics.aiDone.label")}
                value={t("settings.diagnostics.aiDone.value", {
                  done: processingStats.diagnostics.ai.done,
                })}
              />
            </> : null}
          </Group>
          <Group styles={styles} title={t("settings.diagnostics.appInfo")}>
            <InfoRow
              styles={styles}
              label={t("settings.diagnostics.appVersion")}
              value={appVersion}
            />
            <Row
              styles={styles}
              palette={palette}
              icon="git-commit-outline"
              label={t("settings.diagnostics.build")}
              value={describeBuild(build)}
              onPress={
                build.commitUrl
                  ? () => void Linking.openURL(build.commitUrl!)
                  : undefined
              }
            />
            <Row styles={styles} palette={palette} icon="copy-outline"
              label={t(appInfoCopied ? "settings.diagnostics.copied" : "settings.diagnostics.copyAppInfo")}
              onPress={() => void Clipboard.setStringAsync(`${appVersion}\n${describeBuild(build)}`).then(() => setAppInfoCopied(true)).catch(() => setAppInfoCopied(false))}
              last />
          </Group>
        </>
      ) : null}

      <Pressable
        onPress={
          build.commitUrl
            ? () => void Linking.openURL(build.commitUrl!)
            : undefined
        }
        disabled={!build.commitUrl}
        style={styles.buildLine}
        accessibilityRole={build.commitUrl ? "link" : undefined}
      >
        <Text style={styles.buildLineText}>{buildLine}</Text>
      </Pressable>

      <ActionSheet
        visible={exportSheetOpen}
        title={t("settings.exportSheet.title")}
        onClose={() => setExportSheetOpen(false)}
        actions={[
          {
            key: "html",
            label: t("settings.exportSheet.html"),
            description: t("settings.exportSheet.htmlDescription"),
            icon: "globe-outline",
            onPress: () => chooseExport("html"),
          },
          {
            key: "csv",
            label: t("settings.exportSheet.csv"),
            description: t("settings.exportSheet.csvDescription"),
            icon: "grid-outline",
            onPress: () => chooseExport("csv"),
          },
          {
            key: "json",
            label: t("settings.exportSheet.json"),
            description: t("settings.exportSheet.jsonDescription"),
            icon: "code-slash-outline",
            onPress: () => chooseExport("json"),
          },
        ]}
      />

      {/* Android: how to deliver the chosen format — share sheet, or a direct
          save into a user-picked folder (issue #601). */}
      <ActionSheet
        visible={exportDeliveryKind !== null}
        title={
          exportDeliveryKind
            ? t(`settings.exportSheet.${exportDeliveryKind}` as MessageKey)
            : undefined
        }
        onClose={() => setExportDeliveryKind(null)}
        actions={[
          {
            key: "share",
            label: t("settings.exportSheet.share"),
            icon: "share-outline",
            onPress: () => {
              if (exportDeliveryKind) {
                void runExport(exportDeliveryKind, "share");
              }
            },
          },
          {
            key: "save",
            label: t("settings.exportSheet.saveToDevice"),
            icon: "download-outline",
            onPress: () => {
              if (exportDeliveryKind) {
                void runExport(exportDeliveryKind, "save");
              }
            },
          },
        ]}
      />

      <ActionSheet
        visible={importSheetOpen}
        title={t("settings.importSheet.title")}
        onClose={() => setImportSheetOpen(false)}
        actions={[
          {
            key: "html",
            label: t("settings.importSheet.html"),
            icon: "globe-outline",
            onPress: () => void runImport("html"),
          },
          {
            key: "json",
            label: t("settings.importSheet.json"),
            icon: "code-slash-outline",
            onPress: () => void runImport("json"),
          },
          {
            key: "csv",
            label: t("settings.importSheet.pocket"),
            icon: "bookmark-outline",
            onPress: () => void runImport("csv"),
          },
        ]}
      />

      <ResetLibraryDialog
        visible={resetDialogOpen}
        busy={isResettingLibrary}
        error={resetError}
        onConfirm={() => void runReset()}
        onClose={() => setResetDialogOpen(false)}
      />

      <TutorialModal
        visible={tutorialOpen}
        onClose={() => setTutorialOpen(false)}
      />

      <ActionSheet
        visible={languageSheetOpen}
        title={t("settings.language.sheetTitle")}
        onClose={() => setLanguageSheetOpen(false)}
        actions={LANGUAGE_OPTIONS.map((option) => ({
          key: option.value,
          label: t(option.labelKey),
          selected: option.value === languagePref,
          onPress: () => {
            setLocalePreference(option.value);
            setLanguageSheetOpen(false);
          },
        }))}
      />

      <ActionSheet
        visible={aiSuggestionsSheetOpen}
        title={t("settings.aiSuggestions.sheetTitle")}
        onClose={() => setAiSuggestionsSheetOpen(false)}
        actions={AI_SUGGESTIONS_MODE_OPTIONS.map((option) => ({
          key: option.value,
          label: t(option.labelKey),
          selected: option.value === aiSuggestionsMode,
          onPress: () => {
            setAiSuggestionsMode(option.value);
            setAiSuggestionsSheetOpen(false);
          },
        }))}
      />
    </ScrollView>
  );

  const dismissSettings = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  };

  // The Stack header is hidden for this screen, so Settings supplies its own
  // header row (title + close) for both layouts.
  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.headerTitle}>{t("nav.settings")}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        onPress={dismissSettings}
        hitSlop={8}
        style={({ pressed }) => [
          styles.headerClose,
          pressed && { opacity: 0.6 },
        ]}
      >
        <Ionicons name="close" size={24} color={palette.text} />
      </Pressable>
    </View>
  );

  // Settings is a `transparentModal`, so the Inbox is mounted behind it. On web
  // the modal container sizes to its content instead of the viewport, which
  // collapses the `flex: 1` roots to content height and lets the Inbox bleed
  // through below Settings. Pin both layouts to the real viewport height so the
  // opaque background always covers the full screen (a no-op on native, where
  // the modal already fills the screen and this height equals the flex fill).
  if (asSheet) {
    // Right-side sheet: the Inbox shows dimmed behind the backdrop; tapping the
    // backdrop closes. The panel caps at 460px on the right.
    return (
      <View style={[styles.sheetOverlay, { height }]}>
        <Pressable
          testID="settings-sheet-backdrop"
          style={styles.sheetBackdrop}
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={dismissSettings}
        />
        <View style={styles.sheetPanel}>
          {header}
          {content}
        </View>
      </View>
    );
  }

  return (
    <View testID="settings-fullscreen" style={[styles.fullScreen, { height }]}>
      {header}
      {content}
    </View>
  );
}
