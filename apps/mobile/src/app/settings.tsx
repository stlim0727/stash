import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { usePalette } from "@/theme";
import { BookmarkletButton } from "@/ui/BookmarkletButton";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { ActionSheet } from "@/ui/ActionSheet";
import { describeBuild, getBuildInfo } from "@/domain/build-info";
import {
  DEFAULT_SHARE_BEHAVIOR,
  parseShareBehavior,
  serializeShareBehavior,
  SHARE_BEHAVIOR_PREF_KEY,
  type ShareBehavior,
} from "@/domain/share-behavior";
import {
  AI_SUGGESTIONS_MODES,
  type AiSuggestionsMode,
} from "@/domain/ai-suggestions-pref";
import {
  exportFilename,
  toCsv,
  toJsonBackup,
  toNetscapeHtml,
  type ExportInput,
} from "@/domain/export";
import { parseImport } from "@/domain/import";
import {
  RECENT_SEARCHES_PREF_KEY,
  parseRecents,
  serializeRecents,
} from "@/domain/recent-searches";
import {
  DEFAULT_PUSH_NOTIFICATIONS_ENABLED,
  LAST_REGISTERED_PUSH_TOKEN_PREF_KEY,
  PUSH_NOTIFICATIONS_PREF_KEY,
  parsePushNotificationsEnabled,
  serializePushNotificationsEnabled,
} from "@/domain/push-notifications-pref";
import { useI18n, SUPPORTED_LOCALES, type LocalePreference } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { getPreference, setPreference } from "@/storage/preferences";
import { ResetLibraryDialog } from "@/ui/ResetLibraryDialog";
import { deliverExport, saveExportToDevice } from "@/share/export-data";
import { pickImportFile } from "@/share/import-data";
import { useBookmarks } from "@/store/bookmarks";
import { isPermanentlyUnsyncableUrl } from "@/sync/sync-bookmarks";
import { useSupabaseAuth } from "@/supabase/auth-provider";
import type { OAuthProvider } from "@/supabase/types";
import { useAnalytics } from "@/analytics/provider";
import { requestPushPermissionAndToken } from "@/notifications/push-permission";
import { createDefaultPushTokenWriter } from "@/notifications/push-token-client";
import {
  deregisterPushToken,
  registerPushToken,
} from "@/notifications/push-token-registration";

const DEVELOPER_MODE_PREF_KEY = "settings.developer-mode";

// Web only: Settings is a `transparentModal`, so the Inbox stays mounted behind
// it. On mobile browsers, dragging the scroll past its end rubber-bands the
// whole page (the scroll chains up to the transparent html/body — see
// pwa-head.web.ts), sliding this opaque modal and exposing the Inbox cards
// underneath. Containing overscroll stops the chain so nothing bleeds through.
// `overscrollBehavior` is a web CSS property react-native-web forwards but RN's
// ViewStyle type doesn't model, hence the cast; it's inert on native.
const webOverscrollContain: StyleProp<ViewStyle> =
  Platform.OS === "web"
    ? ({ overscrollBehavior: "contain" } as ViewStyle)
    : undefined;

type AppPalette = ReturnType<typeof usePalette>;

/** Sign-in providers, in display order (Google first), with logo + a11y keys. */
const AUTH_PROVIDERS: {
  id: OAuthProvider;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  a11yKey: MessageKey;
}[] = [
  {
    id: "google",
    label: "Google",
    icon: "logo-google",
    a11yKey: "account.signInGoogle",
  },
  {
    id: "apple",
    label: "Apple",
    icon: "logo-apple",
    a11yKey: "account.signInApple",
  },
];

/** The language-preference options, in display order, with their label keys. */
const LANGUAGE_OPTIONS: { value: LocalePreference; labelKey: MessageKey }[] = [
  { value: "system", labelKey: "settings.language.system" },
  ...SUPPORTED_LOCALES.map((code) => ({
    value: code,
    labelKey: `settings.language.${code}` as MessageKey,
  })),
];

/** The AI-suggestions mode options, in display order (least → most automatic),
 *  with their label keys. */
const AI_SUGGESTIONS_MODE_OPTIONS: {
  value: AiSuggestionsMode;
  labelKey: MessageKey;
}[] = AI_SUGGESTIONS_MODES.map((mode) => ({
  value: mode,
  labelKey: `settings.aiSuggestions.${mode}` as MessageKey,
}));

/** "5:41 PM" for a reset later today, "Aug 3, 5:41 PM" otherwise — a bare
 *  time for a reset on a different day would misread as already past once
 *  it's tomorrow's clock time (Codex review, PR #664). */
function formatQuotaResetTime(
  retryAt: number,
  formatDate: ReturnType<typeof useI18n>["formatDate"],
): string {
  const isToday = new Date(retryAt).toDateString() === new Date().toDateString();
  return formatDate(
    retryAt,
    isToday
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  );
}

export default function SettingsScreen() {
  const palette = usePalette();
  const styles = makeStyles(palette);
  const router = useRouter();
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
    diagnosticStats,
    aiQuotaExceeded,
  } = useBookmarks();
  const [aiSuggestionsSheetOpen, setAiSuggestionsSheetOpen] = useState(false);
  const auth = useSupabaseAuth();
  const analytics = useAnalytics();
  const [analyticsBusy, setAnalyticsBusy] = useState(false);

  const handleAnalyticsChange = (enabled: boolean) => {
    if (!analytics.ready || analyticsBusy) return;
    setAnalyticsBusy(true);
    void analytics
      .setEnabled(enabled)
      .catch(() =>
        Alert.alert(
          t("settings.analytics.errorTitle"),
          t("settings.analytics.errorBody"),
        ),
      )
      .finally(() => setAnalyticsBusy(false));
  };

  // Sign in / out happens inline in the account card (no separate screen).
  // `authBusy` disables the auth buttons while a provider flow or sign-out runs.
  const [authBusy, setAuthBusy] = useState<OAuthProvider | "signout" | null>(
    null,
  );
  const handleSignIn = async (provider: OAuthProvider) => {
    setAuthBusy(provider);
    try {
      await auth.signIn(provider);
    } catch (error) {
      Alert.alert(
        t("account.signInFailedTitle"),
        error instanceof Error ? error.message : t("account.signInFailedBody"),
      );
    } finally {
      setAuthBusy(null);
    }
  };
  // Sign-out is confirmed first: logging out hides the whole library from view,
  // so we reassure that the data is safe in the account before proceeding. Only
  // the destructive confirm actually calls `auth.signOut()`.
  const runSignOut = async () => {
    setAuthBusy("signout");
    try {
      await auth.signOut();
    } finally {
      setAuthBusy(null);
    }
  };
  const handleSignOut = () => {
    if (Platform.OS === "web") {
      // Alert.alert has no button support on web, so the confirm dialog never
      // appears and sign-out never fires ("logout does not work"). Fall back to
      // window.confirm like the other destructive confirms on this screen.
      if (
        typeof confirm === "undefined" ||
        confirm(t("settings.account.signOutConfirmBody"))
      ) {
        void runSignOut();
      }
      return;
    }
    Alert.alert(
      t("settings.account.signOutConfirmTitle"),
      t("settings.account.signOutConfirmBody"),
      [
        { text: t("settings.account.signOutCancel"), style: "cancel" },
        {
          text: t("settings.account.signOutConfirm"),
          style: "destructive",
          onPress: () => void runSignOut(),
        },
      ],
    );
  };

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

  const chooseExport = (kind: "html" | "json" | "csv") => {
    if (Platform.OS === "android") {
      setExportSheetOpen(false);
      setExportDeliveryKind(kind);
      return;
    }
    void runExport(kind, "share");
  };

  const runExport = async (
    kind: "html" | "json" | "csv",
    delivery: "share" | "save",
  ) => {
    setExportSheetOpen(false);
    setExportDeliveryKind(null);
    if (exporting) {
      return;
    }
    setExporting(true);
    try {
      const bookmarks = [...inbox];
      const tagsByBookmark: ExportInput["tagsByBookmark"] = {};
      const enrichmentByBookmark: NonNullable<
        ExportInput["enrichmentByBookmark"]
      > = {};
      for (const bookmark of bookmarks) {
        tagsByBookmark[bookmark.id] = getTagsForBookmark(bookmark.id);
        enrichmentByBookmark[bookmark.id] = getEnrichment(bookmark.id);
      }
      const input: ExportInput = {
        bookmarks,
        tagsByBookmark,
        enrichmentByBookmark,
        collections,
        exportedAt: new Date().toISOString(),
        appVersion: Constants.expoConfig?.version ?? undefined,
      };

      const file =
        kind === "html"
          ? {
              filename: exportFilename("html", input.exportedAt),
              mimeType: "text/html",
              contents: toNetscapeHtml(input),
            }
          : kind === "csv"
            ? {
                filename: exportFilename("csv", input.exportedAt),
                mimeType: "text/csv",
                contents: toCsv(input),
              }
            : {
                filename: exportFilename("json", input.exportedAt),
                mimeType: "application/json",
                contents: toJsonBackup(input),
              };
      if (delivery === "save") {
        const saved = await saveExportToDevice(file);
        if (saved) {
          Alert.alert(
            t("settings.export.savedTitle"),
            t("settings.export.savedBody", { name: file.filename }),
          );
        }
      } else {
        await deliverExport(file);
      }
    } catch (error) {
      Alert.alert(
        t("settings.export.failedTitle"),
        error instanceof Error
          ? error.message
          : t("settings.export.failedBody"),
      );
    } finally {
      setExporting(false);
    }
  };

  // Data import: pick a previously exported file (a Stash JSON backup, or a
  // Netscape HTML bookmarks file from any browser/bookmark app), parse it, and
  // re-ingest the bookmarks local-first. The mirror of export — "you can bring
  // your data in as easily as you can take it out."
  const [importSheetOpen, setImportSheetOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const runImport = async (kind: "json" | "html" | "csv") => {
    setImportSheetOpen(false);
    if (importing) {
      return;
    }
    setImporting(true);
    try {
      const picked = await pickImportFile(kind);
      if (!picked) {
        return; // user cancelled the picker
      }
      const items = parseImport(kind, picked.text);
      const summary = importBookmarks(items);

      if (summary.notReady) {
        Alert.alert(
          t("settings.import.notReadyTitle"),
          t("settings.import.notReadyBody"),
        );
        return;
      }
      if (
        summary.imported === 0 &&
        summary.duplicates === 0 &&
        summary.skipped === 0
      ) {
        Alert.alert(
          t("settings.import.nothingTitle"),
          t("settings.import.nothingBody", { name: picked.name }),
        );
        return;
      }
      const parts = [t("settings.import.added", { count: summary.imported })];
      if (summary.duplicates > 0) {
        parts.push(
          t("settings.import.duplicates", { count: summary.duplicates }),
        );
      }
      if (summary.skipped > 0) {
        parts.push(t("settings.import.skipped", { count: summary.skipped }));
      }
      Alert.alert(t("settings.import.completeTitle"), parts.join("\n"));
    } catch (error) {
      Alert.alert(
        t("settings.import.failedTitle"),
        error instanceof Error
          ? error.message
          : t("settings.import.failedBody"),
      );
    } finally {
      setImporting(false);
    }
  };

  // Library reset (issue #600): a destructive, online-only, type-to-confirm
  // flow. The store owns ordering (remote wipe first, local clear only after
  // it succeeds); this screen owns the confirmation gate and result surfacing.
  // While it runs, export/import/sync controls are disabled (see the rows and
  // canSync below).
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const runReset = async () => {
    if (isResettingLibrary) {
      return;
    }
    setResetError(null);
    const result = await resetLibrary();
    if (result.ok) {
      setResetDialogOpen(false);
      Alert.alert(
        t("settings.reset.successTitle"),
        t("settings.reset.successBody"),
      );
      return;
    }
    const bodyKey = (
      {
        busy: "settings.reset.failedBusy",
        auth: "settings.reset.failedAuth",
        remote: "settings.reset.failedRemote",
        local: "settings.reset.failedLocal",
      } as const
    )[result.reason];
    // Keep the dialog open with the failure inline so retry keeps its context.
    setResetError(
      result.message ? `${t(bodyKey)}\n${result.message}` : t(bodyKey),
    );
  };

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
      .catch(() => {})
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
    ).catch(() => {});
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
      .catch(() => {});
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
      () => {},
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
      .catch(() => {})
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
    ).catch(() => {});
  }, [shareBehavior]);

  const insets = useSafeAreaInsets();
  const isAuthenticated = auth.status === "authenticated";

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
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Requires a real (non-anonymous) session — an anonymous device has no
  // stable cross-device identity to bind a token to, see the push_tokens
  // migration — AND an AI-suggestions mode other than `off`, since `off`
  // means nothing ever queues for the backend worker to notify about.
  // Rather than hide the row when either is unmet, it stays visible but
  // disabled with an explanatory value line (same pattern as "Clear search
  // history" below), so the setting doesn't appear to vanish. Turning AI
  // suggestions back on does NOT require re-flipping this toggle: an
  // already-enabled preference (and its registered token, if any) is left
  // alone rather than force-cleared while suggestions are off.
  const canUsePushNotifications =
    isAuthenticated && aiSuggestionsMode !== "off";

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
        ).catch(() => {});
      }
    })().finally(() => setPushNotificationsBusy(false));
  };

  const runPushNotificationsChange = async (enabled: boolean) => {
    if (!enabled) {
      setPushNotificationsEnabled(false);
      await setPreference(
        PUSH_NOTIFICATIONS_PREF_KEY,
        serializePushNotificationsEnabled(false),
      ).catch(() => {});
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
        () => {},
      );
      return;
    }

    const outcome = await requestPushPermissionAndToken();
    if (outcome.outcome !== "granted") {
      setPushNotificationsEnabled(false);
      await setPreference(
        PUSH_NOTIFICATIONS_PREF_KEY,
        serializePushNotificationsEnabled(false),
      ).catch(() => {});
      if (outcome.outcome === "denied") {
        Alert.alert(
          t("settings.pushNotifications.deniedTitle"),
          t("settings.pushNotifications.deniedBody"),
        );
      } else if (outcome.outcome === "no_project_id") {
        Alert.alert(
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
      ).catch(() => {});
      Alert.alert(
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
      ).catch(() => {}),
      setPreference(LAST_REGISTERED_PUSH_TOKEN_PREF_KEY, outcome.token).catch(
        () => {},
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
  const hasPending = waiting > 0;
  const canSync =
    cloudAvailable &&
    hasPending &&
    !isSyncing &&
    !isResettingLibrary &&
    !syncPaused;

  const syncSummary = syncPaused
    ? hasPending
      ? t("settings.sync.pausedWaiting", { count: waiting })
      : t("settings.sync.paused")
    : isSyncing
      ? t("settings.sync.syncing", { count: waiting })
      : !cloudAvailable
        ? t("settings.sync.localOnly")
        : hasPending
          ? t("settings.sync.waiting", { count: waiting })
          : t("settings.sync.allBackedUp");

  // Sync-pipeline breakdown (Sentry STASH-4W): the headline row above only
  // ever reports the upload queue, which reads as "stuck" when metadata
  // enrichment or AI tagging is still working (or stalled on quota) after
  // uploads finish. These conditional sub-rows surface each pipeline's own
  // count independently — they are NOT a partition of one total, a bookmark
  // can be counted in more than one stage at once (e.g. freshly captured is
  // both upload-pending and metadata-pending).
  const uploadingCount = waiting; // same value as today's headline count
  const fetchingInfoCount = diagnosticStats.metadata.todo;
  const aiCount = aiSuggestionsMode !== "off" ? diagnosticStats.ai.todo : 0;
  const aiQuotaReached = aiQuotaExceeded !== null;
  const syncStages = [
    { key: "uploading" as const, count: uploadingCount },
    { key: "fetchingInfo" as const, count: fetchingInfoCount },
    { key: "aiSuggestions" as const, count: aiCount },
  ].filter((stage) => stage.count > 0);
  const showSyncBreakdown =
    cloudAvailable && !syncPaused && syncStages.length >= 2;

  const build = getBuildInfo(Constants.expoConfig?.extra);
  const appVersion = `${Constants.expoConfig?.version ?? "0.0.0"} (Expo SDK ${
    Constants.expoConfig?.sdkVersion ?? "56"
  })`;
  // Always-visible footer line so the deployed version/commit is verifiable
  // without opening Developer mode. Appends the commit when one is baked in.
  const buildLine =
    `Keepory ${Constants.expoConfig?.version ?? "0.0.0"}` +
    (build.shortSha
      ? ` · ${build.ref ? `${build.ref} @ ` : ""}${build.shortSha}`
      : "");

  const content = (
    <ScrollView
      style={[styles.scroll, webOverscrollContain]}
      contentContainerStyle={[
        styles.container,
        { paddingBottom: insets.bottom + 24 },
      ]}
    >
      {/* Account & sync — identity, sign in/out, and sync status in one card.
          The auth control sits beside the identity (sign in with a provider, or
          log out); the sync row below shows backup status. All inline — no
          separate screen. */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t("settings.section.account")}</Text>
        <Card style={styles.account} elevated={false}>
          <View style={styles.accountHeader}>
            {isAuthenticated ? (
              <>
                <View style={styles.accountText}>
                  <Text style={styles.accountMeta}>
                    {t("settings.account.signedIn")}
                  </Text>
                  <Text style={styles.accountName} numberOfLines={1}>
                    {auth.email ??
                      auth.displayName ??
                      t("settings.account.signedIn")}
                  </Text>
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
                <View style={styles.accountText}>
                  <Text style={styles.accountName} numberOfLines={1}>
                    {t(
                      auth.status === "session_expired"
                        ? "settings.account.sessionExpired"
                        : "settings.account.signIn",
                    )}
                  </Text>
                  {auth.status === "session_expired" ? (
                    <Text style={styles.accountMeta} numberOfLines={2}>
                      {t("settings.account.sessionExpiredBody")}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.authButtons}>
                  {AUTH_PROVIDERS.map(({ id, label, icon, a11yKey }) => (
                    <Button
                      key={id}
                      variant="ghost"
                      size="sm"
                      icon={icon}
                      accessibilityLabel={t(a11yKey)}
                      disabled={authBusy !== null}
                      onPress={() => void handleSignIn(id)}
                    >
                      {label}
                    </Button>
                  ))}
                </View>
              </>
            )}
          </View>

          {/* Sync — one status-led row: label/value carry the state (incl. the
            waiting count, even while paused), and the trailing controls are
            the actions — tap-to-sync-now when there's queued work, and a
            pause/resume toggle (Sentry STASH-3K follow-up: a safety valve for
            right after a large import — while paused, nothing uploads or
            pulls, giving time to delete unwanted rows before they ever reach
            the network; a still-local, never-synced delete drops out of the
            queue for free, see deleteBookmark). */}
          <Row
            styles={styles}
            palette={palette}
            icon={syncPaused ? "pause-circle-outline" : "sync"}
            label={t("settings.sync.label")}
            value={syncSummary}
            last={!showSyncBreakdown}
            right={
              <View style={styles.syncActions}>
                {isSyncing ? (
                  <ActivityIndicator color={palette.textSecondary} />
                ) : canSync ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("settings.sync.label")}
                    hitSlop={8}
                    onPress={() => void syncNow()}
                    style={({ pressed }) => [
                      styles.syncIconButton,
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <Ionicons name="refresh" size={18} color={palette.accent} />
                  </Pressable>
                ) : cloudAvailable && !syncPaused ? (
                  <Ionicons
                    name="checkmark-circle"
                    size={20}
                    color={palette.success}
                  />
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    syncPaused
                      ? t("settings.sync.resumeButton")
                      : t("settings.sync.pauseButton")
                  }
                  disabled={isResettingLibrary}
                  hitSlop={8}
                  onPress={() => setSyncPaused(!syncPaused)}
                  style={({ pressed }) => [
                    styles.syncIconButton,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Ionicons
                    name={syncPaused ? "play-circle" : "pause-circle-outline"}
                    size={20}
                    color={syncPaused ? palette.accent : palette.textSecondary}
                  />
                </Pressable>
              </View>
            }
          />
          {showSyncBreakdown
            ? syncStages.map((stage, index) => {
                const isLastStage = index === syncStages.length - 1;
                if (stage.key === "uploading") {
                  return (
                    <Row
                      key={stage.key}
                      styles={styles}
                      palette={palette}
                      icon="cloud-upload-outline"
                      label={t("settings.syncBreakdown.uploading.label")}
                      value={t("settings.syncBreakdown.uploading.value", {
                        count: stage.count,
                      })}
                      last={isLastStage}
                    />
                  );
                }
                if (stage.key === "fetchingInfo") {
                  return (
                    <Row
                      key={stage.key}
                      styles={styles}
                      palette={palette}
                      icon="document-text-outline"
                      label={t("settings.syncBreakdown.fetchingInfo.label")}
                      value={t("settings.syncBreakdown.fetchingInfo.value", {
                        count: stage.count,
                      })}
                      last={isLastStage}
                    />
                  );
                }
                return (
                  <Row
                    key={stage.key}
                    styles={styles}
                    palette={palette}
                    icon="hourglass-outline"
                    label={t("settings.syncBreakdown.aiSuggestions.label")}
                    value={t(
                      aiQuotaReached
                        ? "settings.syncBreakdown.aiSuggestions.valueQuotaReached"
                        : "settings.syncBreakdown.aiSuggestions.value",
                      { count: stage.count },
                    )}
                    last={isLastStage}
                  />
                );
              })
            : null}
        </Card>
      </View>

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
      <Group styles={styles} title={t("settings.section.preferences")}>
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
        {/* Codex review, PR #655: when AI suggestions are off, neither the
            dispatch interval nor the retry checker process anything, so the
            full backlog count doesn't mean "waiting, resumes on its own" —
            it stays frozen until the user turns AI suggestions back on.
            Codex review, PR #656: that doesn't mean nothing is moving,
            though — the server-side overflow worker keeps draining
            already-confirmed-queued items regardless of this local
            preference, so hiding the row entirely was itself misleading in
            the other direction (suggestions can still arrive with no
            warning). Off mode shows the server-queued subset alone, with
            copy that doesn't promise automatic resumption of the rest. */}
        {aiSuggestionsMode !== "off" ? (
          diagnosticStats.ai.todo > 0 ? (
            <Row
              styles={styles}
              palette={palette}
              icon="hourglass-outline"
              label={t("settings.aiQueueBacklog.label")}
              value={t("settings.aiQueueBacklog.value", {
                count: diagnosticStats.ai.todo,
              })}
            />
          ) : null
        ) : diagnosticStats.ai.serverQueued > 0 ? (
          <Row
            styles={styles}
            palette={palette}
            icon="hourglass-outline"
            label={t("settings.aiQueueBacklog.label")}
            value={t("settings.aiQueueBacklog.offValue", {
              count: diagnosticStats.ai.serverQueued,
            })}
          />
        ) : null}
        {/* STASH-4P follow-up: which limit (hourly vs daily) was hit and
            exactly when it resets, sourced from the server's accurate
            retry_after (see request_ai_enrichment_slot) rather than a guess.
            Shown regardless of aiSuggestionsMode — a manual "Suggest with AI"
            tap can trigger this even in 'off' mode. */}
        {aiQuotaExceeded ? (
          <Row
            styles={styles}
            palette={palette}
            icon="timer-outline"
            label={t("settings.aiQuotaExceeded.label")}
            value={t(
              aiQuotaExceeded.reason === "daily_limit"
                ? "settings.aiQuotaExceeded.daily"
                : aiQuotaExceeded.reason === "hourly_limit"
                  ? "settings.aiQuotaExceeded.hourly"
                  : "settings.aiQuotaExceeded.generic",
              { resetTime: formatQuotaResetTime(aiQuotaExceeded.retryAt, formatDate) },
            )}
          />
        ) : null}
        <Row
          styles={styles}
          palette={palette}
          icon="notifications-outline"
          label={t("settings.pushNotifications.label")}
          value={
            !isAuthenticated
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
            analytics.enabled
              ? t("settings.analytics.enabled")
              : t("settings.analytics.disabled")
          }
          right={
            <Switch
              value={analytics.enabled}
              disabled={!analytics.ready || analyticsBusy}
              onValueChange={handleAnalyticsChange}
              trackColor={{ true: palette.accent, false: palette.border }}
              thumbColor="#ffffff"
            />
          }
        />
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
      </Group>

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
      <Group
        styles={styles}
        title={t("settings.section.data")}
        footnote={t("settings.dataNote")}
      >
        <Row
          styles={styles}
          palette={palette}
          icon="download-outline"
          label={t("settings.export.label")}
          value={
            exporting
              ? t("settings.export.preparing")
              : totalBookmarks === 0
                ? t("settings.export.nothing")
                : t("settings.export.value")
          }
          right={
            exporting ? (
              <ActivityIndicator color={palette.textSecondary} />
            ) : undefined
          }
          onPress={
            exporting || isResettingLibrary || totalBookmarks === 0
              ? undefined
              : () => setExportSheetOpen(true)
          }
        />
        <Row
          styles={styles}
          palette={palette}
          icon="enter-outline"
          label={t("settings.import.label")}
          value={
            importing
              ? t("settings.import.importing")
              : t("settings.import.value")
          }
          right={
            importing ? (
              <ActivityIndicator color={palette.textSecondary} />
            ) : undefined
          }
          onPress={
            importing || isResettingLibrary
              ? undefined
              : () => setImportSheetOpen(true)
          }
        />
        {/* Destructive library reset (issue #600): online-only, type-to-confirm.
            Disabled without a usable session — the wipe is a cloud RPC. */}
        <Row
          styles={styles}
          palette={palette}
          icon="nuclear-outline"
          label={t("settings.reset.label")}
          value={
            isResettingLibrary
              ? t("settings.reset.resetting")
              : auth.isSignedIn
                ? t("settings.reset.value")
                : t("settings.reset.signInRequired")
          }
          last
          disabled={!auth.isSignedIn}
          right={
            isResettingLibrary ? (
              <ActivityIndicator color={palette.textSecondary} />
            ) : undefined
          }
          onPress={
            !auth.isSignedIn || isResettingLibrary || importing || exporting
              ? undefined
              : () => {
                  setResetError(null);
                  setResetDialogOpen(true);
                }
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
          <Group styles={styles} title={t("settings.diagnostics.title")}>
            <InfoRow
              styles={styles}
              label={t("settings.diagnostics.supabaseAuth")}
              value={auth.status}
            />
            <InfoRow
              styles={styles}
              label={t("settings.diagnostics.lastPulled")}
              value={
                lastPulledAt
                  ? formatDate(lastPulledAt)
                  : t("settings.diagnostics.lastPulledNever")
              }
            />
            <InfoRow
              styles={styles}
              label="Pipeline: User Sync (todo / done)"
              value={`${diagnosticStats.sync.todo} / ${diagnosticStats.sync.done} (1x: ${diagnosticStats.sync.syncedOnce}, 2x: ${diagnosticStats.sync.syncingTwice})`}
            />
            <InfoRow
              styles={styles}
              label="Pipeline: Metadata (todo / done)"
              value={`${diagnosticStats.metadata.todo} / ${diagnosticStats.metadata.done}`}
            />
            <InfoRow
              styles={styles}
              label="Pipeline: AI Suggestions (todo / done)"
              value={`${diagnosticStats.ai.todo} / ${diagnosticStats.ai.done}`}
            />
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
              last
              onPress={
                build.commitUrl
                  ? () => void Linking.openURL(build.commitUrl!)
                  : undefined
              }
            />
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

  // The Stack header is hidden for this screen, so Settings supplies its own
  // header row (title + close) for both layouts.
  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.headerTitle}>{t("nav.settings")}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        onPress={() => router.back()}
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
          onPress={() => router.back()}
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

/** Rounded card that groups settings rows with hairline dividers, under an
 *  optional uppercase section header so the screen reads as labelled sections
 *  (iOS-Settings style) rather than a stack of anonymous cards. */
function Group({
  children,
  styles,
  title,
  footnote,
}: {
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
  title?: string;
  /** Caption rendered beneath the card (iOS-style section footer). */
  footnote?: string;
}) {
  return (
    <View style={styles.section}>
      {title ? <Text style={styles.sectionLabel}>{title}</Text> : null}
      <Card style={styles.group} elevated={false}>
        {children}
      </Card>
      {footnote ? <Text style={styles.footnote}>{footnote}</Text> : null}
    </View>
  );
}

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

/** A tappable (or static) settings row: icon · label/value · trailing element. */
function Row({
  styles,
  palette,
  icon,
  label,
  value,
  onPress,
  right,
  badge,
  accent,
  last,
  disabled,
  accessibilityLabel,
}: {
  styles: ReturnType<typeof makeStyles>;
  palette: AppPalette;
  icon: IoniconName;
  label: string;
  value?: string;
  onPress?: () => void;
  right?: React.ReactNode;
  badge?: number;
  accent?: boolean;
  last?: boolean;
  /** A non-pressable row that represents a DISABLED control (vs static info):
   *  dims the row and announces a disabled button to assistive tech. */
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const rowStyle: StyleProp<ViewStyle> = [styles.row, !last && styles.divider];
  const labelColor = accent ? palette.accent : palette.text;

  const content = (
    <>
      <View
        style={[
          styles.iconWrap,
          accent && { backgroundColor: palette.accentSoft },
        ]}
      >
        <Ionicons
          name={icon}
          size={18}
          color={accent ? palette.accentText : palette.text}
        />
      </View>
      <View style={styles.rowText}>
        <Text
          style={[styles.rowLabel, { color: labelColor }]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {value ? (
          <Text style={styles.rowValue} numberOfLines={2}>
            {value}
          </Text>
        ) : null}
      </View>
      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      {right ??
        (onPress ? (
          <Ionicons
            name="chevron-forward"
            size={18}
            color={palette.textSecondary}
          />
        ) : null)}
    </>
  );

  if (!onPress) {
    // A disabled control (e.g. "Clear search history" with no history): dim it so
    // it reads as inert rather than tappable, and announce the disabled state to
    // screen readers (a plain info row stays role-less and full-strength).
    if (disabled) {
      return (
        <View
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={{ disabled: true }}
          style={[rowStyle, { opacity: 0.4 }]}
        >
          {content}
        </View>
      );
    }
    return <View style={rowStyle}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => [rowStyle, pressed && { opacity: 0.6 }]}
    >
      {content}
    </Pressable>
  );
}

/** Compact label/value row used for read-only diagnostics. */
function InfoRow({
  styles,
  label,
  value,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  value: string;
}) {
  return (
    <View style={[styles.infoRow, styles.divider]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (palette: AppPalette) =>
  StyleSheet.create({
    scroll: {
      flex: 1,
      backgroundColor: palette.background,
    },
    fullScreen: {
      flex: 1,
      backgroundColor: palette.background,
    },
    sheetOverlay: {
      flex: 1,
      flexDirection: "row",
    },
    sheetBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
    },
    sheetPanel: {
      width: "100%",
      maxWidth: 460,
      backgroundColor: palette.background,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
      backgroundColor: palette.background,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: "700",
      color: palette.text,
    },
    headerClose: {
      padding: 4,
    },
    container: {
      padding: 16,
      gap: 18,
    },
    account: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: "hidden",
    },
    accountHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    authButtons: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    accountText: {
      flex: 1,
      gap: 2,
    },
    accountName: {
      fontSize: 17,
      fontWeight: "700",
      color: palette.text,
    },
    accountMeta: {
      fontSize: 13,
      color: palette.textSecondary,
    },
    section: {
      gap: 8,
    },
    group: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: "hidden",
    },
    bookmarkletRow: {
      padding: 16,
      alignItems: "flex-start",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 13,
    },
    iconWrap: {
      width: 32,
      height: 32,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.mutedSurface,
    },
    rowText: {
      flex: 1,
      gap: 2,
    },
    rowLabel: {
      fontSize: 15,
      fontWeight: "600",
    },
    rowValue: {
      fontSize: 13,
      color: palette.textSecondary,
    },
    syncActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    syncIconButton: {
      padding: 4,
    },
    divider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    badge: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      paddingHorizontal: 6,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.accent,
    },
    badgeText: {
      color: "#ffffff",
      fontSize: 12,
      fontWeight: "700",
    },
    infoRow: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 3,
    },
    infoLabel: {
      fontSize: 13,
      fontWeight: "600",
      color: palette.text,
    },
    infoValue: {
      fontSize: 13,
      color: palette.textSecondary,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: "600",
      color: palette.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginLeft: 4,
    },
    buildLine: {
      alignItems: "center",
      paddingTop: 4,
      paddingBottom: 2,
    },
    buildLineText: {
      fontSize: 11,
      color: palette.textSecondary,
      opacity: 0.7,
    },
    footnote: {
      fontSize: 13,
      color: palette.textSecondary,
      marginHorizontal: 4,
      lineHeight: 18,
    },
  });
