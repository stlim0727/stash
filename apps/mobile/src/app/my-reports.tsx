import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createFeedbackApi } from '@/api/feedback';
import type { TesterReport } from '@/domain/feedback';
import { isClosedStatus } from '@/domain/feedback';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { usePalette } from '@/theme';

const CATEGORY_LABELS: Record<TesterReport['category'], string> = {
  bug: 'Bug',
  idea: 'Idea',
  other: 'Other',
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; reports: TesterReport[] }
  | { status: 'error'; message: string };

/** Allow tests to inject a feedback API factory. */
export interface MyReportsScreenProps {
  createApi?: typeof createFeedbackApi;
}

export default function MyReportsScreen({
  createApi = createFeedbackApi,
}: MyReportsScreenProps = {}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const auth = useSupabaseAuth();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const session = (await auth.ensureAnonymousSession?.()) ?? auth.session;
      if (!session) {
        throw new Error('You need an active session to see your reports.');
      }
      const reports = await createApi(session).listMyReports();
      setState({ status: 'ready', reports });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not load your reports.',
      });
    }
  }, [auth, createApi]);

  useEffect(() => {
    void load();
  }, [load]);

  if (auth.status === 'not_configured') {
    return (
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 16 }]}>
        <View style={[styles.card, { backgroundColor: palette.card }]}>
          <Text style={[styles.cardBody, { color: palette.text }]}>
            Cloud reporting isn’t configured on this build, so there are no synced reports to show.
          </Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 16 }]}>
      {state.status === 'loading' ? (
        <View style={styles.centered} accessibilityLabel="Loading reports">
          <ActivityIndicator color={palette.textSecondary} />
        </View>
      ) : null}

      {state.status === 'error' ? (
        <View style={[styles.card, { backgroundColor: palette.card }]}>
          <Text style={styles.error}>{state.message}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading reports"
            style={[styles.retry, { borderColor: palette.border }]}
            onPress={() => void load()}
          >
            <Text style={[styles.retryLabel, { color: palette.text }]}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {state.status === 'ready' && state.reports.length === 0 ? (
        <View style={[styles.card, { backgroundColor: palette.card }]}>
          <Text style={[styles.cardBody, { color: palette.textSecondary }]}>
            You haven’t sent any reports yet. When you do, you’ll see their status and any replies
            from the team here.
          </Text>
        </View>
      ) : null}

      {state.status === 'ready'
        ? state.reports.map((report) => (
            <View key={report.id} style={[styles.card, { backgroundColor: palette.card }]}>
              <View style={styles.headerRow}>
                <Text style={[styles.category, { color: palette.textSecondary }]}>
                  {CATEGORY_LABELS[report.category]}
                </Text>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: isClosedStatus(report.status)
                        ? palette.accent
                        : palette.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusLabel,
                      { color: isClosedStatus(report.status) ? '#ffffff' : palette.text },
                    ]}
                    accessibilityLabel={`Status ${report.statusLabel}`}
                  >
                    {report.statusLabel}
                  </Text>
                </View>
              </View>

              <Text style={[styles.message, { color: palette.text }]}>{report.message}</Text>

              {report.attachmentCount > 0 ? (
                <Text style={[styles.meta, { color: palette.textSecondary }]}>
                  {`${report.attachmentCount} attachment${report.attachmentCount === 1 ? '' : 's'}`}
                </Text>
              ) : null}

              {report.developerReply ? (
                <View style={[styles.reply, { borderColor: palette.border }]}>
                  <Text style={[styles.replyLabel, { color: palette.textSecondary }]}>
                    Reply from the team
                  </Text>
                  <Text style={[styles.replyBody, { color: palette.text }]}>
                    {report.developerReply}
                  </Text>
                </View>
              ) : null}

              {report.resolution ? (
                <View style={[styles.reply, { borderColor: palette.accent }]}>
                  <Text style={[styles.replyLabel, { color: palette.accent }]}>Resolution</Text>
                  <Text style={[styles.replyBody, { color: palette.text }]}>
                    {report.resolution}
                  </Text>
                </View>
              ) : null}
            </View>
          ))
        : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  centered: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  card: {
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  cardBody: {
    fontSize: 15,
    lineHeight: 21,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  category: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusPill: {
    borderRadius: 12,
    paddingVertical: 3,
    paddingHorizontal: 10,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  message: {
    fontSize: 15,
    lineHeight: 21,
  },
  meta: {
    fontSize: 13,
  },
  reply: {
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingLeft: 12,
    paddingVertical: 4,
    gap: 2,
  },
  replyLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  replyBody: {
    fontSize: 15,
    lineHeight: 21,
  },
  error: {
    color: '#d93636',
    fontSize: 14,
  },
  retry: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
    alignItems: 'center',
  },
  retryLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
});
