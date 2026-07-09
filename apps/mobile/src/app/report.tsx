import Constants from 'expo-constants';
import { usePathname } from 'expo-router';
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
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createFeedbackApi } from '@/api/feedback';
import type { FeedbackApi, FeedbackCategory } from '@/api/feedback';
import { buildDiagnosticsContext, formatDiagnosticsReport } from '@/domain/diagnostics';
import type { DiagnosticsContext } from '@/domain/diagnostics';
import { describeBuild, getBuildInfo } from '@/domain/build-info';
import { getLogEntries } from '@/observability/log-buffer';
import {
  clearPendingFeedbackScreenshot,
  getPendingFeedbackSource,
  getPendingFeedbackScreenshot,
} from '@/feedback/screenshot-session';
import { useT } from '@/i18n';
import { KeyboardAvoidingScreen } from '@/ui/KeyboardAvoidingScreen';
import type { MessageKey } from '@/i18n/messages';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { usePalette } from '@/theme';

/** Most recent log lines, formatted for the diagnostics payload. */
function recentLogLines(limit = 80): string[] {
  return getLogEntries()
    .slice(-limit)
    .map((entry) => `${entry.t} [${entry.level}] ${entry.message}`);
}

const CATEGORIES: Array<{ value: FeedbackCategory; labelKey: MessageKey }> = [
  { value: 'bug', labelKey: 'report.categoryBug' },
  { value: 'idea', labelKey: 'report.categoryIdea' },
  { value: 'other', labelKey: 'report.categoryOther' },
];

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
  const insets = useSafeAreaInsets();
  const auth = useSupabaseAuth();
  const pathname = usePathname();
  const { queue, isSyncing, lastPulledAt } = useBookmarks();

  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [message, setMessage] = useState('');
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });
  const [screenshot, setScreenshot] = useState(getPendingFeedbackScreenshot);
  const [sourceContext] = useState(getPendingFeedbackSource);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);

  useEffect(
    () => () => {
      clearPendingFeedbackScreenshot();
    },
    [],
  );

  const appVersion = Constants.expoConfig?.version ?? '0.0.0';
  const platform = Platform.OS;

  const queueDepth = queue.filter(
    (entry) => entry.sync_status === 'pending' || entry.sync_status === 'failed',
  ).length;
  const lastError =
    queue.find((entry) => entry.last_error)?.last_error ?? undefined;

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
        screenshot: includeScreenshot ? screenshot : null,
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
    ],
  );

  const context = useMemo(collectContext, [collectContext]);
  const contextPreview = useMemo(() => previewContext(context), [context]);
  const logCount = context.logs?.length ?? 0;

  const handleShare = async () => {
    try {
      await Share.share({ message: formatDiagnosticsReport(collectContext()) });
    } catch {
      // User dismissed the share sheet, or it is unavailable — nothing to do.
    }
  };

  const trimmed = message.trim();
  const canSubmit = trimmed.length > 0 && auth.isSignedIn && submit.status !== 'submitting';

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
      setScreenshot(null);
      setIncludeScreenshot(false);
      clearPendingFeedbackScreenshot();
    } catch (error) {
      setSubmit({
        status: 'error',
        message: error instanceof Error ? error.message : t('report.errorSubmit'),
      });
    }
  };

  if (auth.status === 'not_configured') {
    return (
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 16 }]}>
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
          <Text style={[styles.secondaryButtonLabel, { color: palette.text }]}>
            {t('report.shareWithCount', { count: logCount })}
          </Text>
        </Pressable>
        <Text
          accessibilityLabel={t('report.contextPreviewA11y')}
          style={[styles.code, { color: palette.text, borderColor: palette.border }]}
        >
          {contextPreview}
        </Text>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingScreen>
    <ScrollView
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
        <Text
          accessibilityLabel={t('report.contextPreviewA11y')}
          style={[styles.code, { color: palette.text, borderColor: palette.border }]}
        >
          {contextPreview}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('report.shareDiagnosticsA11y')}
          style={[styles.secondaryButton, { borderColor: palette.border }]}
          onPress={() => void handleShare()}
        >
          <Text style={[styles.secondaryButtonLabel, { color: palette.text }]}>
            {t('report.share')}
          </Text>
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
        <Text style={[styles.submitButtonLabel, { color: palette.accentForeground }]}>
          {submit.status === 'submitting' ? t('report.submitting') : t('report.submit')}
        </Text>
      </Pressable>
    </ScrollView>
    </KeyboardAvoidingScreen>
  );
}

const styles = StyleSheet.create({
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
