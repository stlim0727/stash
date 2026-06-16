import Constants from 'expo-constants';
import { usePathname } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { createFeedbackApi } from '@/api/feedback';
import type { FeedbackApi, FeedbackCategory } from '@/api/feedback';
import { buildDiagnosticsContext, formatDiagnosticsReport } from '@/domain/diagnostics';
import type { DiagnosticsContext } from '@/domain/diagnostics';
import { describeBuild, getBuildInfo } from '@/domain/build-info';
import { getLogEntries } from '@/observability/log-buffer';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { usePalette } from '@/theme';

/** Most recent log lines, formatted for the diagnostics payload. */
function recentLogLines(limit = 80): string[] {
  return getLogEntries()
    .slice(-limit)
    .map((entry) => `${entry.t} [${entry.level}] ${entry.message}`);
}

const CATEGORIES: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'other', label: 'Other' },
];

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
  const auth = useSupabaseAuth();
  const pathname = usePathname();
  const { queue, isSyncing, lastPulledAt } = useBookmarks();

  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [message, setMessage] = useState('');
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });

  const appVersion = Constants.expoConfig?.version ?? '0.0.0';
  const platform = Platform.OS;

  const queueDepth = queue.filter(
    (entry) => entry.sync_status === 'pending' || entry.sync_status === 'failed',
  ).length;
  const lastError =
    queue.find((entry) => entry.last_error)?.last_error ?? undefined;

  const buildLabel = describeBuild(getBuildInfo());

  // Build the diagnostics fresh on demand so submit/share capture the latest
  // logs (the storage error is recorded at startup, before this screen mounts).
  const collectContext = useCallback(
    (): DiagnosticsContext =>
      buildDiagnosticsContext({
        appVersion,
        platform,
        osVersion: `Expo SDK ${Constants.expoConfig?.sdkVersion ?? '56'}`,
        route: pathname,
        authStatus: auth.status,
        queueDepth,
        isSyncing,
        lastPulledAt,
        lastError,
        build: buildLabel,
        logs: recentLogLines(),
      }),
    [
      appVersion,
      platform,
      pathname,
      auth.status,
      queueDepth,
      isSyncing,
      lastPulledAt,
      lastError,
      buildLabel,
    ],
  );

  const context = useMemo(collectContext, [collectContext]);
  const contextPreview = useMemo(() => JSON.stringify(context, null, 2), [context]);
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

  const handleSubmit = async () => {
    if (!trimmed || !auth.session) {
      return;
    }

    setSubmit({ status: 'submitting' });
    try {
      const api: FeedbackApi = createApi(auth.session);
      await api.submitReport({
        category,
        message: trimmed,
        context: collectContext(),
        app_version: appVersion,
        platform,
      });
      setSubmit({ status: 'success' });
      setMessage('');
    } catch (error) {
      setSubmit({
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not submit your report.',
      });
    }
  };

  if (auth.status === 'not_configured') {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <View style={[styles.field, { backgroundColor: palette.card }]}>
          <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
            Cloud reporting unavailable
          </Text>
          <Text style={[styles.fieldValue, { color: palette.text }]}>
            Submitting to the cloud isn’t configured on this build, but you can still share a
            diagnostics report (including recent logs) to send manually.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Share diagnostics"
          style={[styles.secondaryButton, { borderColor: palette.border }]}
          onPress={() => void handleShare()}
        >
          <Text style={[styles.secondaryButtonLabel, { color: palette.text }]}>
            {`Share diagnostics & logs (${logCount})`}
          </Text>
        </Pressable>
        <Text
          accessibilityLabel="Diagnostic context preview"
          style={[styles.code, { color: palette.text, borderColor: palette.border }]}
        >
          {contextPreview}
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={[styles.field, { backgroundColor: palette.card }]}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>Category</Text>
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
                onPress={() => setCategory(item.value)}
              >
                <Text style={[styles.chipLabel, { color: selected ? '#ffffff' : palette.text }]}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={[styles.field, { backgroundColor: palette.card }]}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>What happened?</Text>
        <TextInput
          accessibilityLabel="Problem description"
          style={[
            styles.input,
            styles.multiline,
            { color: palette.text, borderColor: palette.border },
          ]}
          placeholder="Describe the problem or idea"
          placeholderTextColor={palette.textSecondary}
          multiline
          value={message}
          onChangeText={setMessage}
        />
      </View>

      <View style={[styles.field, { backgroundColor: palette.card }]}>
        <Text style={[styles.fieldLabel, { color: palette.textSecondary }]}>
          Diagnostic context
        </Text>
        <Text style={[styles.privacyNote, { color: palette.textSecondary }]}>
          {`Includes app diagnostics and ${logCount} recent log line(s) to aid debugging — not your bookmark list.`}
        </Text>
        <Text
          accessibilityLabel="Diagnostic context preview"
          style={[styles.code, { color: palette.text, borderColor: palette.border }]}
        >
          {contextPreview}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Share diagnostics"
          style={[styles.secondaryButton, { borderColor: palette.border }]}
          onPress={() => void handleShare()}
        >
          <Text style={[styles.secondaryButtonLabel, { color: palette.text }]}>
            Share diagnostics &amp; logs
          </Text>
        </Pressable>
      </View>

      {submit.status === 'success' ? (
        <Text style={[styles.success, { color: palette.accent }]}>
          Thanks — your report was sent.
        </Text>
      ) : null}
      {submit.status === 'error' ? <Text style={styles.error}>{submit.message}</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Submit report"
        accessibilityState={{ disabled: !canSubmit }}
        disabled={!canSubmit}
        style={[
          styles.submitButton,
          { backgroundColor: palette.accent },
          !canSubmit && styles.submitButtonDisabled,
        ]}
        onPress={() => void handleSubmit()}
      >
        <Text style={styles.submitButtonLabel}>
          {submit.status === 'submitting' ? 'Sending…' : 'Submit report'}
        </Text>
      </Pressable>
    </ScrollView>
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
  success: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  error: {
    color: '#d93636',
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
    color: '#ffffff',
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
