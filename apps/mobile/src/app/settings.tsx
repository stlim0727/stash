import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { usePalette } from '@/theme';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { ActionSheet } from '@/ui/ActionSheet';
import { describeBuild, getBuildInfo } from '@/domain/build-info';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import {
  DEFAULT_SHARE_BEHAVIOR,
  parseShareBehavior,
  serializeShareBehavior,
  SHARE_BEHAVIOR_PREF_KEY,
  type ShareBehavior,
} from '@/domain/share-behavior';
import {
  exportFilename,
  toCsv,
  toJsonBackup,
  toNetscapeHtml,
  type ExportInput,
} from '@/domain/export';
import { parseImport } from '@/domain/import';
import { useI18n, SUPPORTED_LOCALES, type LocalePreference } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import { getPreference, setPreference } from '@/storage/preferences';
import { deliverExport } from '@/share/export-data';
import { pickImportFile } from '@/share/import-data';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';

const DEVELOPER_MODE_PREF_KEY = 'settings.developer-mode';

type AppPalette = ReturnType<typeof usePalette>;

/** The language-preference options, in display order, with their label keys. */
const LANGUAGE_OPTIONS: { value: LocalePreference; labelKey: MessageKey }[] = [
  { value: 'system', labelKey: 'settings.language.system' },
  ...SUPPORTED_LOCALES.map((code) => ({
    value: code,
    labelKey: `settings.language.${code}` as MessageKey,
  })),
];

export default function SettingsScreen() {
  const palette = usePalette();
  const styles = makeStyles(palette);
  const router = useRouter();
  const { t, preference: languagePref, setLocalePreference, formatDate } = useI18n();
  const {
    queue,
    isSyncing,
    syncNow,
    inbox,
    archived,
    lastPulledAt,
    collections,
    getTagsForBookmark,
    getEnrichment,
    importBookmarks,
  } = useBookmarks();
  const auth = useSupabaseAuth();

  // Data export: build a portable file from the on-device library and hand it
  // to the platform delivery shim (browser download on web, share sheet on
  // native). This is the user's "your data is yours" escape hatch — it works
  // offline and produces formats other apps can import.
  const [exportSheetOpen, setExportSheetOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [languageSheetOpen, setLanguageSheetOpen] = useState(false);
  const totalBookmarks = inbox.length + archived.length;

  const runExport = async (kind: 'html' | 'json' | 'csv') => {
    setExportSheetOpen(false);
    if (exporting) {
      return;
    }
    setExporting(true);
    try {
      const bookmarks = [...inbox, ...archived];
      const tagsByBookmark: ExportInput['tagsByBookmark'] = {};
      const enrichmentByBookmark: NonNullable<ExportInput['enrichmentByBookmark']> = {};
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
        kind === 'html'
          ? {
              filename: exportFilename('html', input.exportedAt),
              mimeType: 'text/html',
              contents: toNetscapeHtml(input),
            }
          : kind === 'csv'
            ? {
                filename: exportFilename('csv', input.exportedAt),
                mimeType: 'text/csv',
                contents: toCsv(input),
              }
            : {
                filename: exportFilename('json', input.exportedAt),
                mimeType: 'application/json',
                contents: toJsonBackup(input),
              };
      await deliverExport(file);
    } catch (error) {
      Alert.alert(
        t('settings.export.failedTitle'),
        error instanceof Error ? error.message : t('settings.export.failedBody'),
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

  const runImport = async (kind: 'json' | 'html') => {
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

      if (summary.imported === 0 && summary.duplicates === 0 && summary.skipped === 0) {
        Alert.alert(t('settings.import.nothingTitle'), t('settings.import.nothingBody', { name: picked.name }));
        return;
      }
      const parts = [t('settings.import.added', { count: summary.imported })];
      if (summary.duplicates > 0) {
        parts.push(t('settings.import.duplicates', { count: summary.duplicates }));
      }
      if (summary.skipped > 0) {
        parts.push(t('settings.import.skipped', { count: summary.skipped }));
      }
      Alert.alert(t('settings.import.completeTitle'), parts.join('\n'));
    } catch (error) {
      Alert.alert(
        t('settings.import.failedTitle'),
        error instanceof Error ? error.message : t('settings.import.failedBody'),
      );
    } finally {
      setImporting(false);
    }
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
          setDeveloperMode(raw === 'true');
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
    void setPreference(DEVELOPER_MODE_PREF_KEY, developerMode ? 'true' : 'false').catch(() => {});
  }, [developerMode]);

  // What happens after a URL is shared in from another app. Default is a
  // modeless toast (no navigation); opting in lands on the Inbox instead.
  const [shareBehavior, setShareBehavior] = useState<ShareBehavior>(DEFAULT_SHARE_BEHAVIOR);
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
    void setPreference(SHARE_BEHAVIOR_PREF_KEY, serializeShareBehavior(shareBehavior)).catch(
      () => {},
    );
  }, [shareBehavior]);

  // Total high-confidence, un-applied suggestions waiting in the review queue.
  const pendingSuggestionCount = inbox.reduce((total, bookmark) => {
    const applied = new Set(getTagsForBookmark(bookmark.id).map((tag) => tag.name.toLowerCase()));
    return total + pendingSuggestions(getEnrichment(bookmark.id), applied).length;
  }, 0);

  const waiting = queue.filter((entry) => entry.sync_status !== 'synced').length;
  // Sync is upload-then-pull, so it is useful even with nothing to upload
  // (another device or cloud AI enrichment may have changed data).
  const canSync = auth.isSignedIn && !isSyncing;

  const isAuthenticated = auth.status === 'authenticated';

  const syncSummary = isSyncing
    ? t('settings.sync.syncing', { count: waiting })
    : waiting === 0
      ? auth.isSignedIn
        ? t('settings.sync.upToDate')
        : t('settings.sync.localOnly')
      : auth.isSignedIn
        ? t('settings.sync.waiting', { count: waiting })
        : t('settings.sync.queuedOffline', { count: waiting });

  const build = getBuildInfo();
  const appVersion = `${Constants.expoConfig?.version ?? '0.0.0'} (Expo SDK ${
    Constants.expoConfig?.sdkVersion ?? '56'
  })`;

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={styles.container}
    >
      {/* Account header */}
      <Card style={styles.accountCard}>
        <Avatar size={56} uri={auth.avatarUrl} email={auth.email} authed={isAuthenticated} />
        <View style={styles.accountText}>
          <Text style={styles.accountName} numberOfLines={1}>
            {isAuthenticated
              ? (auth.displayName ?? auth.email ?? t('settings.account.signedIn'))
              : auth.status === 'not_configured'
                ? t('settings.account.cloudUnavailable')
                : t('settings.account.notSignedIn')}
          </Text>
          <Text style={styles.accountMeta} numberOfLines={1}>
            {isAuthenticated
              ? (auth.displayName && auth.email ? auth.email : t('settings.account.syncedAcrossDevices'))
              : auth.status === 'not_configured'
                ? t('settings.account.worksOffline')
                : t('settings.account.signInToBackup')}
          </Text>
        </View>
        {auth.status !== 'not_configured' ? (
          <Button
            variant={isAuthenticated ? 'ghost' : 'primary'}
            size="sm"
            onPress={() => router.push('/account')}
          >
            {isAuthenticated ? t('common.manage') : t('common.signIn')}
          </Button>
        ) : null}
      </Card>

      {/* Sync — status and the sync action are one row: the summary is the
          value and tapping the row syncs (upload-then-pull). A trailing refresh
          glyph signals it's tappable; it spins to a spinner while syncing. */}
      <Group styles={styles}>
        <Row
          styles={styles}
          palette={palette}
          icon="sync"
          label={t('settings.sync.label')}
          value={syncSummary}
          last
          onPress={canSync ? () => void syncNow() : undefined}
          right={
            isSyncing ? (
              <ActivityIndicator color={palette.textSecondary} />
            ) : canSync ? (
              <Ionicons name="refresh" size={18} color={palette.accent} />
            ) : undefined
          }
        />
      </Group>

      {/* Library & tools */}
      <Group styles={styles}>
        <Row
          styles={styles}
          palette={palette}
          icon="sparkles-outline"
          label={t('settings.review.label')}
          value={
            pendingSuggestionCount > 0
              ? t('settings.review.toReview', { count: pendingSuggestionCount })
              : t('settings.review.nothing')
          }
          badge={pendingSuggestionCount > 0 ? pendingSuggestionCount : undefined}
          onPress={() => router.push('/review')}
        />
        <Row
          styles={styles}
          palette={palette}
          icon="library-outline"
          label={t('settings.library.label')}
          value={t('settings.library.value', { inbox: inbox.length, archived: archived.length })}
          onPress={() => router.push('/archived')}
        />
        <Row
          styles={styles}
          palette={palette}
          icon="chatbubble-ellipses-outline"
          label={t('settings.report.label')}
          value={t('settings.report.value')}
          last
          onPress={() => router.push('/report')}
        />
      </Group>

      {/* Your data — export / portability */}
      <Group styles={styles}>
        <Row
          styles={styles}
          palette={palette}
          icon="download-outline"
          label={t('settings.export.label')}
          value={
            exporting
              ? t('settings.export.preparing')
              : totalBookmarks === 0
                ? t('settings.export.nothing')
                : t('settings.export.value')
          }
          right={exporting ? <ActivityIndicator color={palette.textSecondary} /> : undefined}
          onPress={
            exporting || totalBookmarks === 0 ? undefined : () => setExportSheetOpen(true)
          }
        />
        <Row
          styles={styles}
          palette={palette}
          icon="enter-outline"
          label={t('settings.import.label')}
          value={importing ? t('settings.import.importing') : t('settings.import.value')}
          last
          right={importing ? <ActivityIndicator color={palette.textSecondary} /> : undefined}
          onPress={importing ? undefined : () => setImportSheetOpen(true)}
        />
      </Group>
      <Text style={styles.exportNote}>{t('settings.dataNote')}</Text>

      {/* Sharing behavior */}
      <Group styles={styles}>
        <Row
          styles={styles}
          palette={palette}
          icon="share-outline"
          label={t('settings.share.label')}
          value={
            shareBehavior === 'inbox'
              ? t('settings.share.inbox')
              : t('settings.share.toast')
          }
          last
          right={
            <Switch
              value={shareBehavior === 'inbox'}
              onValueChange={(on) => setShareBehavior(on ? 'inbox' : 'toast')}
              trackColor={{ true: palette.accent, false: palette.border }}
              thumbColor="#ffffff"
            />
          }
        />
      </Group>

      {/* App language — follows the device by default, with a manual override. */}
      <Group styles={styles}>
        <Row
          styles={styles}
          palette={palette}
          icon="language-outline"
          label={t('settings.language.label')}
          value={t(
            LANGUAGE_OPTIONS.find((option) => option.value === languagePref)?.labelKey ??
              'settings.language.system',
          )}
          last
          onPress={() => setLanguageSheetOpen(true)}
        />
      </Group>

      {/* Developer mode toggle */}
      <Group styles={styles}>
        <Row
          styles={styles}
          palette={palette}
          icon="construct-outline"
          label={t('settings.developer.label')}
          value={t('settings.developer.value')}
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
          <Text style={styles.sectionLabel}>{t('settings.diagnostics.title')}</Text>
          <Group styles={styles}>
            <InfoRow styles={styles} label={t('settings.diagnostics.supabaseAuth')} value={auth.status} />
            <InfoRow
              styles={styles}
              label={t('settings.diagnostics.lastPulled')}
              value={
                lastPulledAt
                  ? formatDate(lastPulledAt)
                  : t('settings.diagnostics.lastPulledNever')
              }
            />
            <InfoRow styles={styles} label={t('settings.diagnostics.appVersion')} value={appVersion} />
            <Row
              styles={styles}
              palette={palette}
              icon="git-commit-outline"
              label={t('settings.diagnostics.build')}
              value={describeBuild(build)}
              last
              onPress={
                build.commitUrl ? () => void Linking.openURL(build.commitUrl!) : undefined
              }
            />
          </Group>

          <Text style={styles.sectionLabel}>{t('settings.queue.title')}</Text>
          {queue.length === 0 ? (
            <Text style={styles.emptyQueue}>{t('settings.queue.empty')}</Text>
          ) : (
            <Group styles={styles}>
              {queue.map((entry, index) => (
                <View
                  key={entry.local_id}
                  style={[styles.queueRow, index < queue.length - 1 && styles.divider]}
                >
                  <Text style={styles.queueTitle} numberOfLines={1}>
                    {entry.payload.url ?? entry.payload.shared_text ?? entry.local_id}
                  </Text>
                  <Text style={styles.queueMeta}>
                    {t('settings.queue.meta', {
                      operation: entry.operation,
                      status: entry.sync_status,
                      retries: entry.retry_count,
                    })}
                    {entry.last_error
                      ? `\n${t('settings.queue.lastError', { error: entry.last_error })}`
                      : ''}
                  </Text>
                </View>
              ))}
            </Group>
          )}
        </>
      ) : null}

      <ActionSheet
        visible={exportSheetOpen}
        title={t('settings.exportSheet.title')}
        onClose={() => setExportSheetOpen(false)}
        actions={[
          {
            key: 'html',
            label: t('settings.exportSheet.html'),
            icon: 'globe-outline',
            onPress: () => void runExport('html'),
          },
          {
            key: 'csv',
            label: t('settings.exportSheet.csv'),
            icon: 'grid-outline',
            onPress: () => void runExport('csv'),
          },
          {
            key: 'json',
            label: t('settings.exportSheet.json'),
            icon: 'code-slash-outline',
            onPress: () => void runExport('json'),
          },
        ]}
      />

      <ActionSheet
        visible={importSheetOpen}
        title={t('settings.importSheet.title')}
        onClose={() => setImportSheetOpen(false)}
        actions={[
          {
            key: 'html',
            label: t('settings.importSheet.html'),
            icon: 'globe-outline',
            onPress: () => void runImport('html'),
          },
          {
            key: 'json',
            label: t('settings.importSheet.json'),
            icon: 'code-slash-outline',
            onPress: () => void runImport('json'),
          },
        ]}
      />

      <ActionSheet
        visible={languageSheetOpen}
        title={t('settings.language.sheetTitle')}
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
    </ScrollView>
  );
}

/** Rounded card that groups settings rows with hairline dividers. */
function Group({
  children,
  styles,
}: {
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Card style={styles.group} elevated={false}>
      {children}
    </Card>
  );
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

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
}) {
  const rowStyle: StyleProp<ViewStyle> = [styles.row, !last && styles.divider];
  const labelColor = accent ? palette.accent : palette.text;

  const content = (
    <>
      <View style={[styles.iconWrap, accent && { backgroundColor: palette.accentSoft }]}>
        <Ionicons name={icon} size={18} color={accent ? palette.accentText : palette.text} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: labelColor }]} numberOfLines={1}>
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
      {right ?? (onPress ? (
        <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
      ) : null)}
    </>
  );

  if (!onPress) {
    return <View style={rowStyle}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
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
    container: {
      padding: 16,
      gap: 18,
    },
    accountCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      padding: 16,
    },
    accountText: {
      flex: 1,
      gap: 2,
    },
    accountName: {
      fontSize: 17,
      fontWeight: '700',
      color: palette.text,
    },
    accountMeta: {
      fontSize: 13,
      color: palette.textSecondary,
    },
    group: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 13,
    },
    iconWrap: {
      width: 32,
      height: 32,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.mutedSurface,
    },
    rowText: {
      flex: 1,
      gap: 2,
    },
    rowLabel: {
      fontSize: 15,
      fontWeight: '600',
    },
    rowValue: {
      fontSize: 13,
      color: palette.textSecondary,
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
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.accent,
    },
    badgeText: {
      color: '#ffffff',
      fontSize: 12,
      fontWeight: '700',
    },
    infoRow: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 3,
    },
    infoLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.text,
    },
    infoValue: {
      fontSize: 13,
      color: palette.textSecondary,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: -8,
      marginLeft: 4,
    },
    queueRow: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 3,
    },
    queueTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.text,
    },
    queueMeta: {
      fontSize: 12,
      color: palette.textSecondary,
    },
    emptyQueue: {
      fontSize: 14,
      color: palette.textSecondary,
      marginLeft: 4,
    },
    exportNote: {
      fontSize: 13,
      color: palette.textSecondary,
      marginTop: -10,
      marginHorizontal: 4,
      lineHeight: 18,
    },
  });
