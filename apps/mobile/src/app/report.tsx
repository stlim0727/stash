import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createFeedbackApi } from '@/api/feedback';
import type { FeedbackApi, FeedbackCategory } from '@/api/feedback';
import { buildDiagnosticsContext, formatDiagnosticsReport } from '@/domain/diagnostics';
import type { DiagnosticsContext } from '@/domain/diagnostics';
import { describeBuild, getBuildInfo } from '@/domain/build-info';
import { getLogEntries } from '@/observability/log-buffer';
import { describeRecentSegments } from '@/observability/slow-segment-log';
import {
  clearPendingFeedbackScreenshot,
  getPendingFeedbackSource,
  getPendingFeedbackScreenshot,
} from '@/feedback/screenshot-session';
import { getShareDiagnostics, hydrateNativeShareDebugLog } from '@/share/share-diagnostics';
import { getStorageDiagnostics } from '@/storage/diagnostics';
import { getReconcileDiagnostics } from '@/sync/reconcile-diagnostics';
import { isPermanentlyUnsyncableUrl } from '@/sync/sync-bookmarks';
import { useT } from '@/i18n';
import { Button } from '@/ui/Button';
import { KeyboardAvoidingScreen } from '@/ui/KeyboardAvoidingScreen';
import type { MessageKey } from '@/i18n/messages';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { usePalette } from '@/theme';

const TAIL_WAIT_MS_RE = /^sqlite tail wait (\d+)ms/;
const MAX_TAIL_WAIT_ENTRIES = 5;

/** Most recent log lines, formatted for the diagnostics payload. */
function recentLogLines(limit = 150): string[] {
  const allEntries = getLogEntries();
  // Cap sqlite tail-wait entries at MAX_TAIL_WAIT_ENTRIES so a burst on app
  // foreground doesn't consume the entire window and hide sync/pull/enrich
  // logs — but keep the *most severe* ones, not the first ones seen. A real
  // report showed an early, mild reopen burst (five ~300ms waits right at
  // startup) using up the whole cap before a single much worse wait later in
  // the same session (4061ms) ever got a slot — so the one line that would
  // have explained the report was silently dropped every time. Ranking by
  // wait time keeps the worst stalls regardless of when they happened.
  const tailWaitIndexesBySeverity = allEntries
    .map((entry, index) => ({ index, waitMs: Number(TAIL_WAIT_MS_RE.exec(entry.message)?.[1]) }))
    .filter((item) => !Number.isNaN(item.waitMs))
    .sort((a, b) => b.waitMs - a.waitMs)
    .slice(0, MAX_TAIL_WAIT_ENTRIES)
    .map((item) => item.index);
  const keepTailWaitIndexes = new Set(tailWaitIndexesBySeverity);
  const filtered = allEntries.filter(
    (entry, index) => !entry.message.startsWith('sqlite tail wait') || keepTailWaitIndexes.has(index),
  );
  return filtered
    .slice(-limit)
    .map((entry) => `${entry.t} [${entry.level}] ${entry.message}`);
}

const CATEGORIES: Array<{ value: FeedbackCategory; labelKey: MessageKey }> = [
  { value: 'bug', labelKey: 'report.categoryBug' },
  { value: 'idea', labelKey: 'report.categoryIdea' },
  { value: 'other', labelKey: 'report.categoryOther' },
];

const webOverscrollContain: StyleProp<ViewStyle> =
  Platform.OS === 'web' ? ({ overscrollBehavior: 'contain' } as ViewStyle) : undefined;

function previewContext(context: DiagnosticsContext): string {
  if (!context.screenshot) {
    return JSON.stringify(context, null, 2);
  }
  return JSON.stringify(
    {
      ...context,
      screenshot: {
        ...context.screenshot,
        dataUrl: `[redacted ${context.screenshot.mimeType} screenshot]`,
      },
    },
    null,
    2,
  );
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success' }
  | { status: 'error'; message: string };

/**
 * Allow tests (and future callers) to inject a feedback API factory. Defaults
 * to the real Supabase-backed client.
 */
export interface ReportScreenProps {
  createApi?: typeof createFeedbackApi;
}

export default function ReportScreen({ createApi = createFeedbackApi }: ReportScreenProps = {}) {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const asSheet = width >= 760;
  const auth = useSupabaseAuth();
  const pathname = usePathname();
  const { queue, isSyncing, lastPulledAt, aiQuotaExceeded } = useBookmarks();

  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [message, setMessage] = useState('');
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });
  const [screenshot] = useState(getPendingFeedbackScreenshot);
  const [sourceContext] = useState(getPendingFeedbackSource);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [showContextPreview, setShowContextPreview] = useState(false);

  useEffect(
    () => () => {
      clearPendingFeedbackScreenshot();
    },
    [],
  );

  useEffect(() => {
    if (submit.status === 'success') {
      const timer = setTimeout(() => {
        router.back();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [submit.status, router]);

  // Re-read the native module's durable share-intent breadcrumb (Android,
  // Sentry STASH-2Q) as soon as this screen mounts: the startup-only read in
  // `_layout.tsx` misses a same-session report — the common case, since a
  // user who hits a failed share typically taps "Report a problem" right
  // away, well before any process restart. Bump a tick so the preview below
  // reflects it too, even though handleSubmit/handleShare re-await the read
  // themselves right before collecting, independent of this effect's timing.
  const [nativeDebugTick, setNativeDebugTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void hydrateNativeShareDebugLog().then(() => {
      if (!cancelled) {
        setNativeDebugTick((tick) => tick + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const appVersion = Constants.expoConfig?.version ?? '0.0.0';
  const platform = Platform.OS;

  // A permanently-too-long URL (Sentry STASH-2J) stays 'failed' in the queue
  // forever by design (see settings.tsx's `waiting`) — it must not count here
  // either, or it resurfaces as this report's queueDepth/lastError on every
  // later, unrelated share, making an old dead entry look like today's
  // failure (Sentry STASH-2T/STASH-2V).
  const queueDepth = queue.filter(
    (entry) =>
      (entry.sync_status === 'pending' || entry.sync_status === 'failed') &&
      !isPermanentlyUnsyncableUrl(entry),
  ).length;
  const lastError =
    queue.find((entry) => entry.last_error && !isPermanentlyUnsyncableUrl(entry))?.last_error ??
    undefined;

  const buildLabel = describeBuild(getBuildInfo(Constants.expoConfig?.extra));

  // Build the diagnostics fresh on demand so submit/share capture the latest
  // logs (the storage error is recorded at startup, before this screen mounts).
  const collectContext = useCallback(
    (): DiagnosticsContext =>
      buildDiagnosticsContext({
        appVersion,
        platform,
        osVersion: `Expo SDK ${Constants.expoConfig?.sdkVersion ?? '56'}`,
        route: sourceContext?.route ?? pathname,
        sourceSurface: sourceContext?.surface,
        authStatus: auth.status,
        queueDepth,
        isSyncing,
        lastPulledAt,
        lastError,
        build: buildLabel,
        logs: recentLogLines(),
        recentSlowSegments: describeRecentSegments(),
        storage: getStorageDiagnostics(),
        syncReconcile: getReconcileDiagnostics(),
        shareAttempt: getShareDiagnostics(),
        screenshot: includeScreenshot ? screenshot : null,
        aiQuota: aiQuotaExceeded
          ? {
              reason: aiQuotaExceeded.reason,
              resetAt: new Date(aiQuotaExceeded.retryAt).toISOString(),
            }
          : null,
      }),
    [
      appVersion,
      platform,
      pathname,
      sourceContext,
      auth.status,
      queueDepth,
      isSyncing,
      lastPulledAt,
      lastError,
      buildLabel,
      includeScreenshot,
      screenshot,
      aiQuotaExceeded,
    ],
  );

  const context = useMemo(collectContext, [collectContext, nativeDebugTick]);
  const contextPreview = useMemo(() => previewContext(context), [context]);
  const logCount = context.logs?.length ?? 0;

  const handleShare = async () => {
    try {
      // Re-await the native breadcrumb read here too, independent of the mount
      // effect's timing, so a share triggered right after a failed capture
      // still carries it (Sentry STASH-2Q).
      await hydrateNativeShareDebugLog();
      await Share.share({ message: formatDiagnosticsReport(collectContext()) });
    } catch {
      // User dismissed the share sheet, or it is unavailable — nothing to do.
    }
  };

  const trimmed = message.trim();
  const canSubmit = trimmed.length > 0 && auth.status === 'authenticated' && submit.status !== 'submitting';

  // Once the user starts composing a follow-up report, a prior success/error
  // banner is stale: leaving the "thanks" message up over the form (with the
  // now-empty field disabling Submit) reads as "I can't file another report".
  // Clear it on the first edit so the form is unmistakably ready again.
  const clearStaleBanner = () => {
    setSubmit((prev) =>
      prev.status === 'success' || prev.status === 'error' ? { status: 'idle' } : prev,
    );
  };
  const handleMessageChange = (value: string) => {
    setMessage(value);
    clearStaleBanner();
  };

  const handleSubmit = async () => {
    if (!trimmed) {
      return;
    }

    setSubmit({ status: 'submitting' });
    try {
      // Re-await the native breadcrumb read here too (Sentry STASH-2Q) —
      // guarantees the submitted diagnostics carry it regardless of whether
      // the mount effect above has resolved yet.
      await hydrateNativeShareDebugLog();
      // Re-ensure the session so a token that expired while this screen stayed
      // open is refreshed before we post; otherwise the request is rejected
      // with "JWT expired".
      const session = (await auth.ensureAnonymousSession()) ?? auth.session;
      if (!session) {
        throw new Error(t('report.errorNoSession'));
      }
      const api: FeedbackApi = createApi(session);
      await api.submitReport({
        category,
        message: trimmed,
        context: collectContext(),
        app_version: appVersion,
        platform,
      });
      setSubmit({ status: 'success' });
      setMessage('');
      setIncludeScreenshot(false);
    } catch (error) {
      setSubmit({
        status: 'error',
        message: error instanceof Error ? error.message : t('report.errorSubmit'),
      });
    }
  };

  const content =
    auth.status === 'not_configured' ? (
      <ScrollView
        style={webOverscrollContain}
        contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 16 }]}
      >
        <View style={[styles.field, { backgroundColor: palette.card }]}>
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
            {t('report.cloudUnavailableTitle')}
          </Text>
          <Text style={[styles.fieldValue, { color: palette.text }]}>
            {t('report.cloudUnavailableBody')}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('report.shareDiagnosticsA11y')}
          style={[styles.secondaryButton, { borderColor: palette.border }]}
          onPress={() => void handleShare()}
        >
          <View style={styles.buttonRow}>
            <Ionicons
              testID="share-diagnostics-icon"
              name="share-social-outline"
              size={18}
              color={palette.text}
            />
            <Text style={[styles.secondaryButtonLabel, { color: palette.text }]}>
              {t('report.shareWithCount', { count: logCount })}
            </Text>
          </View>
        </Pressable>
        <Text
          accessibilityLabel={t('report.contextPreviewA11y')}
          style={[styles.code, { color: palette.text, borderColor: palette.border }]}
        >
          {contextPreview}
        </Text>
      </ScrollView>
    ) : auth.status === 'anonymous' ? (
      <ScrollView
        style={webOverscrollContain}
        contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 16 }]}
      >
        <View style={[styles.field, { backgroundColor: palette.card }]}>
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
            {t('report.signInRequiredTitle')}
          </Text>
          <Text style={[styles.fieldValue, { color: palette.text }]}>
            {t('report.signInRequiredBody')}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            style={styles.signInButton}
            onPress={() => router.push('/settings')}
          >
            {t('settings.account.signIn')}
          </Button>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('report.shareDiagnosticsA11y')}
          style={[styles.secondaryButton, { borderColor: palette.border }]}
          onPress={() => void handleShare()}
        >
          <View style={styles.buttonRow}>
            <Ionicons
              testID="share-diagnostics-icon"
              name="share-social-outline"
              size={18}
              color={palette.text}
            />
            <Text style={[styles.secondaryButtonLabel, { color: palette.text }]}>
              {t('report.shareWithCount', { count: logCount })}
            </Text>
          </View>
        </Pressable>
        <Text
          accessibilityLabel={t('report.contextPreviewA11y')}
          style={[styles.code, { color: palette.text, borderColor: palette.border }]}
        >
          {contextPreview}
        </Text>
      </ScrollView>
    ) : (
      <ScrollView
        style={webOverscrollContain}
        contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 16 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.field, { backgroundColor: palette.card }]}>
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>{t('report.categoryLabel')}</Text>
          <View style={styles.chipRow}>
            {CATEGORIES.map((item) => {
              const selected = item.value === category;
              return (
                <Pressable
                  key={item.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={[
                    styles.chip,
                    { borderColor: palette.border },
                    selected && { backgroundColor: palette.accent, borderColor: palette.accent },
                  ]}
                  onPress={() => {
                    setCategory(item.value);
                    clearStaleBanner();
                  }}
                >
                  <Text style={[styles.chipLabel, { color: selected ? palette.accentForeground : palette.text }]}>
                    {t(item.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={[styles.field, { backgroundColor: palette.card }]}>
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>{t('report.whatHappened')}</Text>
          <TextInput
            accessibilityLabel={t('report.descriptionA11y')}
            style={[
              styles.input,
              styles.multiline,
              { color: palette.text, borderColor: palette.border },
            ]}
            placeholder={t('report.descriptionPlaceholder')}
            placeholderTextColor={palette.textSecondary}
            multiline
            value={message}
            onChangeText={handleMessageChange}
          />
        </View>

      <View style={[styles.field, { backgroundColor: palette.card }]}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
          {t('report.diagnosticContext')}
        </Text>
        <Text style={[styles.privacyNote, { color: palette.textSecondary }]}>
          {t('report.privacyNote', { count: logCount })}
        </Text>
        {screenshot ? (
          <View style={styles.screenshotBox}>
            <View style={styles.screenshotHeader}>
              <View style={styles.screenshotCopy}>
                <Text style={[styles.screenshotTitle, { color: palette.text }]}>
                  {t('report.screenshotTitle')}
                </Text>
                <Text style={[styles.privacyNote, { color: palette.textSecondary }]}>
                  {t('report.screenshotNote')}
                </Text>
              </View>
              <Switch
                accessibilityLabel={t('report.screenshotToggleA11y')}
                value={includeScreenshot}
                onValueChange={(value) => {
                  setIncludeScreenshot(value);
                  clearStaleBanner();
                }}
                trackColor={{ true: palette.accent, false: palette.border }}
                thumbColor="#ffffff"
              />
            </View>
            {includeScreenshot ? (
              <Image
                accessibilityLabel={t('report.screenshotPreviewA11y')}
                source={{ uri: screenshot.dataUrl }}
                resizeMode="contain"
                style={[styles.screenshotPreview, { backgroundColor: palette.mutedSurface }]}
              />
            ) : null}
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('report.contextPreviewToggleA11y')}
          accessibilityState={{ expanded: showContextPreview }}
          style={[styles.contextToggle, { borderColor: palette.border }]}
          onPress={() => setShowContextPreview((value) => !value)}
        >
          <View style={styles.buttonRow}>
            <Ionicons
              name={showContextPreview ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={palette.text}
            />
            <Text style={[styles.secondaryButtonLabel, { color: palette.text }]}>
              {showContextPreview ? t('report.hideDiagnostics') : t('report.showDiagnostics')}
            </Text>
          </View>
        </Pressable>
        {showContextPreview ? (
          <Text
            accessibilityLabel={t('report.contextPreviewA11y')}
            style={[styles.code, { color: palette.text, borderColor: palette.border }]}
          >
            {contextPreview}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('report.shareDiagnosticsA11y')}
          style={[styles.secondaryButton, { borderColor: palette.border }]}
          onPress={() => void handleShare()}
        >
          <View style={styles.buttonRow}>
            <Ionicons
              testID="share-diagnostics-icon"
              name="share-social-outline"
              size={18}
              color={palette.text}
            />
            <Text style={[styles.secondaryButtonLabel, { color: palette.text }]}>
              {t('report.share')}
            </Text>
          </View>
        </Pressable>
      </View>

      {submit.status === 'success' ? (
        <Text style={[styles.success, { color: palette.accent }]}>{t('report.success')}</Text>
      ) : null}
      {submit.status === 'error' ? (
        <Text style={[styles.error, { color: palette.danger }]}>{submit.message}</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('report.submitA11y')}
        accessibilityState={{ disabled: !canSubmit }}
        disabled={!canSubmit}
        style={[
          styles.submitButton,
          { backgroundColor: palette.accent },
          !canSubmit && styles.submitButtonDisabled,
        ]}
        onPress={() => void handleSubmit()}
      >
        <View style={styles.buttonRow}>
          <Ionicons testID="submit-report-icon" name="send" size={18} color={palette.accentForeground} />
          <Text style={[styles.submitButtonLabel, { color: palette.accentForeground }]}>
            {submit.status === 'submitting' ? t('report.submitting') : t('report.submit')}
          </Text>
        </View>
      </Pressable>
      </ScrollView>
    );

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
      <Text style={[styles.headerTitle, { color: palette.text }]}>{t('nav.report')}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        onPress={() => router.back()}
        hitSlop={8}
        style={({ pressed }) => [styles.headerClose, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="close" size={24} color={palette.text} />
      </Pressable>
    </View>
  );

  return (
    <KeyboardAvoidingScreen>
      {asSheet ? (
        <View style={[styles.sheetOverlay, { height }]}>
          <Pressable
            testID="report-sheet-backdrop"
            style={styles.sheetBackdrop}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            onPress={() => router.back()}
          />
          <View style={[styles.sheetPanel, { backgroundColor: palette.background }]}>
            {header}
            {content}
          </View>
        </View>
      ) : (
        <View testID="report-fullscreen" style={[styles.fullScreen, { backgroundColor: palette.background, height }]}>
          {header}
          {content}
        </View>
      )}
    </KeyboardAvoidingScreen>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
  },
  sheetOverlay: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.24)',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFill,
  },
  sheetPanel: {
    width: '100%',
    maxWidth: 520,
    height: '100%',
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: -4, height: 0 },
  },
  header: {
    minHeight: 64,
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  headerClose: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  container: {
    padding: 16,
    gap: 12,
  },
  field: {
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    fontSize: 15,
  },
  signInButton: {
    alignSelf: 'flex-start',
  },
  privacyNote: {
    fontSize: 13,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  code: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 12,
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  contextToggle: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  screenshotBox: {
    gap: 10,
  },
  screenshotHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  screenshotCopy: {
    flex: 1,
    gap: 2,
  },
  screenshotTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  screenshotPreview: {
    width: '100%',
    height: 220,
    borderRadius: 10,
  },
  success: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  error: {
    fontSize: 13,
    textAlign: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 13,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
});
