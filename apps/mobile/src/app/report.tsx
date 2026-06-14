import Constants from 'expo-constants';
import { usePathname } from 'expo-router';
import { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { createFeedbackApi } from '@/api/feedback';
import type { FeedbackApi, FeedbackCategory } from '@/api/feedback';
import { buildDiagnosticsContext } from '@/domain/diagnostics';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { usePalette } from '@/theme';

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

  const context = useMemo(
    () =>
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
      }),
    // capturedAt changes on every render otherwise; recompute only on inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appVersion, platform, pathname, auth.status, queueDepth, isSyncing, lastPulledAt, lastError],
  );

  const contextPreview = useMemo(() => JSON.stringify(context, null, 2), [context]);

  const trimmed = message.trim();
  const canSubmit =
    trimmed.length > 0 && auth.status === 'anonymous' && submit.status !== 'submitting';

  const handleSubmit = async () => {
    if (!trimmed || auth.status !== 'anonymous' || !auth.session) {
      return;
    }

    setSubmit({ status: 'submitting' });
    try {
      const api: FeedbackApi = createApi(auth.session);
      await api.submitReport({
        category,
        message: trimmed,
        context,
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
            Reporting unavailable
          </Text>
          <Text style={[styles.fieldValue, { color: palette.text }]}>
            Problem reports are sent to the cloud, which is not configured on this build. You can
            still use Stash fully offline.
          </Text>
        </View>
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
          No bookmark contents are included.
        </Text>
        <Text
          accessibilityLabel="Diagnostic context preview"
          style={[styles.code, { color: palette.text, borderColor: palette.border }]}
        >
          {contextPreview}
        </Text>
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
});
