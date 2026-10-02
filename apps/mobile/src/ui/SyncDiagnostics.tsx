import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PullAttemptDiagnostics } from '@/domain/pull-diagnostics';
import { useI18n } from '@/i18n';
import { usePalette } from '@/theme';
import { Card } from '@/ui/Card';

/** Current sync observation and historical pulls deliberately remain separate. */
export function SyncDiagnostics({ status, lastPulledAt, remaining, recentPulls, onReport, reporting, attention = false }: {
  status: string;
  lastPulledAt: string | null;
  remaining: number;
  recentPulls: PullAttemptDiagnostics[];
  onReport: () => void;
  reporting: boolean;
  attention?: boolean;
}) {
  const { t, formatDate } = useI18n();
  const palette = usePalette();
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const pulls = showAll ? recentPulls : recentPulls.slice(0, 3);
  const border = { borderColor: palette.border };
  const text = { color: palette.text };
  const secondary = { color: palette.textSecondary };
  return (
    <View style={styles.groups}>
      <Text style={[styles.section, secondary]}>{t('settings.diagnostics.current')}</Text>
      <Card>
        <View style={styles.block}>
          <View style={styles.heading}>
            <Ionicons name={attention ? 'warning-outline' : 'cloud-outline'} size={22} color={attention ? palette.danger : palette.textSecondary} />
            <Text testID="diagnostics-current-status" style={[styles.status, { flex: 1, color: attention ? palette.danger : palette.text }]} accessibilityLiveRegion="polite">{status}</Text>
          </View>
          <Text style={[styles.value, secondary]}>{t('settings.diagnostics.cloudRemaining', { count: remaining })}</Text>
          {attention ? <Pressable accessibilityRole="button" disabled={reporting} onPress={onReport} style={styles.action}><Text style={{ color: palette.accent }}>{t('settings.report.label')}</Text></Pressable> : null}
        </View>
        <View style={[styles.block, styles.divider, border]}>
          <Text style={[styles.label, secondary]}>{t('settings.diagnostics.lastPulled')}</Text>
          <Text style={[styles.value, text]}>{lastPulledAt ? formatDate(lastPulledAt) : t('settings.diagnostics.lastPulledNever')}</Text>
        </View>
      </Card>
      <Text style={[styles.section, secondary]}>{t('settings.diagnostics.recentPulls.label')}</Text>
      <Card>
        {pulls.length === 0 ? <Text style={[styles.block, styles.value, text]}>{t('settings.diagnostics.recentPulls.none')}</Text> : pulls.map((attempt, index) => {
          const key = `${attempt.timestamp}:${index}`;
          const open = expanded === key;
          const failure = attempt.outcome === 'failure';
          // The history is device-wide: later success is evidence about a pull,
          // never proof that this account's current uploads or errors recovered.
          const laterSuccess = failure && recentPulls.slice(0, index).some(item => item.outcome === 'success');
          return (
            <View key={key} style={[index > 0 && styles.divider, border]}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }}
                accessibilityLabel={`${t(failure ? 'settings.diagnostics.pullFailed' : 'settings.diagnostics.pullSucceeded')} · ${formatDate(attempt.timestamp)}`}
                onPress={() => setExpanded(open ? null : key)} style={styles.block}>
                <View style={styles.heading}>
                  <Ionicons name={failure ? 'alert-circle-outline' : 'checkmark-circle-outline'} size={20} color={failure ? palette.danger : palette.success} />
                  <Text style={[styles.outcome, text]}>{t(failure ? 'settings.diagnostics.pullFailed' : 'settings.diagnostics.pullSucceeded')}</Text>
                  <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={palette.textSecondary} />
                </View>
                <Text style={[styles.value, secondary]}>{formatDate(attempt.timestamp)}</Text>
                <Text style={[styles.value, text]}>{failure ? t(laterSuccess ? 'settings.diagnostics.laterPullSucceeded' : 'settings.diagnostics.pullErrorHint') : t('settings.diagnostics.recentPulls.rows', { count: attempt.remoteRowCount })}</Text>
              </Pressable>
              {open ? (
                <View style={[styles.block, { paddingTop: 0 }]}>
                  {failure ? <Text selectable testID="pull-error-full" style={[styles.error, text]}>{attempt.errorMessage || t('settings.diagnostics.errorUnavailable')}</Text> : null}
                  <Text selectable style={[styles.value, secondary]}>{t('settings.diagnostics.pullDuration', { count: attempt.durationMs })}</Text>
                  <Text selectable style={[styles.value, secondary]}>{t('settings.diagnostics.pullSince', { since: attempt.since ? formatDate(attempt.since) : t('settings.diagnostics.fullPull') })}</Text>
                  {failure ? (
                    <View style={styles.actions}>
                      <Pressable accessibilityRole="button" onPress={() => {
                        void Clipboard.setStringAsync(attempt.errorMessage || t('settings.diagnostics.errorUnavailable')).then(() => setCopied(key)).catch(() => setCopied(null));
                      }} style={styles.action}><Text style={{ color: palette.accent }}>{t(copied === key ? 'settings.diagnostics.copied' : 'settings.diagnostics.copyError')}</Text></Pressable>
                      <Pressable accessibilityRole="button" disabled={reporting} onPress={onReport} style={styles.action}><Text style={{ color: palette.accent }}>{t('settings.report.label')}</Text></Pressable>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
        {recentPulls.length > 3 ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAll }} onPress={() => setShowAll(!showAll)} style={[styles.block, styles.divider, border]}>
          <Text style={{ color: palette.accent }}>{t(showAll ? 'settings.diagnostics.showLess' : 'settings.diagnostics.showAll', { count: recentPulls.length })}</Text>
        </Pressable> : null}
      </Card>
      <Text style={[styles.caption, secondary]}>{t('settings.diagnostics.historyScope')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  groups: { gap: 12 },
  section: { fontSize: 14, fontWeight: '600', marginLeft: 4 },
  block: { padding: 16, gap: 8 },
  status: { fontSize: 18, lineHeight: 26, fontWeight: '700' },
  label: { fontSize: 14, lineHeight: 20 },
  value: { fontSize: 15, lineHeight: 22 },
  outcome: { flex: 1, fontSize: 16, lineHeight: 24, fontWeight: '600' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  error: { fontSize: 15, lineHeight: 23 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  action: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 4 },
  caption: { fontSize: 13, lineHeight: 20, marginHorizontal: 4 },
});
