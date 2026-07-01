import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePalette } from '@/theme';
import { BookmarkletButton } from '@/ui/BookmarkletButton';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { ActionSheet } from '@/ui/ActionSheet';
import { describeBuild, getBuildInfo } from '@/domain/build-info';
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
import {
  RECENT_SEARCHES_PREF_KEY,
  parseRecents,
  serializeRecents,
} from '@/domain/recent-searches';
import { useI18n, SUPPORTED_LOCALES, type LocalePreference } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import { getPreference, setPreference } from '@/storage/preferences';
import { deliverExport } from '@/share/export-data';
import { pickImportFile } from '@/share/import-data';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import type { OAuthProvider } from '@/supabase/types';

const DEVELOPER_MODE_PREF_KEY = 'settings.developer-mode';

type AppPalette = ReturnType<typeof usePalette>;

/** Sign-in providers, in display order (Google first), with logo + a11y keys. */
const AUTH_PROVIDERS: {
  id: OAuthProvider;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  a11yKey: MessageKey;
}[] = [
  { id: 'google', label: 'Google', icon: 'logo-google', a11yKey: 'account.signInGoogle' },
  { id: 'apple', label: 'Apple', icon: 'logo-apple', a11yKey: 'account.signInApple' },
];

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
    trash,
    lastPulledAt,
    collections,
    getTagsForBookmark,
    getEnrichment,
    importBookmarks,
  } = useBookmarks();
  const auth = useSupabaseAuth();

  // Sign in / out happens inline in the account card (no separate screen).
  // `authBusy` disables the auth buttons while a provider flow or sign-out runs.
  const [authBusy, setAuthBusy] = useState<OAuthProvider | 'signout' | null>(null);
  const handleSignIn = async (provider: OAuthProvider) => {
    setAuthBusy(provider);
    try {
      await auth.signIn(provider);
    } catch (error) {
      Alert.alert(
        t('account.signInFailedTitle'),
        error instanceof Error ? error.message : t('account.signInFailedBody'),
      );
    } finally {
      setAuthBusy(null);
    }
  };
  // Sign-out is confirmed first: logging out hides the whole library from view,
  // so we reassure that the data is safe in the account before proceeding. Only
  // the destructive confirm actually calls `auth.signOut()`.
  const runSignOut = async () => {
    setAuthBusy('signout');
    try {
      await auth.signOut();
    } finally {
      setAuthBusy(null);
    }
  };
  const handleSignOut = () => {
    Alert.alert(
      t('settings.account.signOutConfirmTitle'),
      t('settings.account.signOutConfirmBody'),
      [
        { text: t('settings.account.signOutCancel'), style: 'cancel' },
        {
          text: t('settings.account.signOutConfirm'),
          style: 'destructive',
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
  const [exporting, setExporting] = useState(false);
  const [languageSheetOpen, setLanguageSheetOpen] = useState(false);
  const totalBookmarks = inbox.length;

  const runExport = async (kind: 'html' | 'json' | 'csv') => {
    setExportSheetOpen(false);
    if (exporting) {
      return;
    }
    setExporting(true);
    try {
      const bookmarks = [...inbox];
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

  const runImport = async (kind: 'json' | 'html' | 'csv') => {
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
    void setPreference(RECENT_SEARCHES_PREF_KEY, serializeRecents([])).catch(() => {});
  };
  const confirmClearRecents = () => {
    if (Platform.OS === 'web') {
      if (typeof confirm === 'undefined' || confirm(t('settings.search.clearConfirmTitle'))) {
        clearRecentSearches();
      }
      return;
    }
    Alert.alert(
      t('settings.search.clearConfirmTitle'),
      t('settings.search.clearConfirmBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.search.clearConfirm'),
          style: 'destructive',
          onPress: clearRecentSearches,
        },
      ],
    );
  };

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

  const insets = useSafeAreaInsets();
  const isAuthenticated = auth.status === 'authenticated';

  // Sync row is status-led: the right-hand glyph is the action/state.
  //  - cloud reachable + something queued → tappable refresh (upload-then-pull)
  //  - syncing → spinner
  //  - cloud reachable + nothing queued → a static "all backed up" checkmark
  //  - no cloud session (anonymous works, only "not configured" lacks one) →
  //    "local only", no glyph. Pulls still happen automatically (on sign-in /
  //    account switch / when work is queued), so there is no manual-pull button.
  const waiting = queue.filter((entry) => entry.sync_status !== 'synced').length;
  const cloudAvailable = auth.isSignedIn; // anonymous OR authenticated session
  const hasPending = waiting > 0;
  const canSync = cloudAvailable && hasPending && !isSyncing;

  const syncSummary = isSyncing
    ? t('settings.sync.syncing', { count: waiting })
    : !cloudAvailable
      ? t('settings.sync.localOnly')
      : hasPending
        ? t('settings.sync.waiting', { count: waiting })
        : t('settings.sync.allBackedUp');

  const build = getBuildInfo(Constants.expoConfig?.extra);
  const appVersion = `${Constants.expoConfig?.version ?? '0.0.0'} (Expo SDK ${
    Constants.expoConfig?.sdkVersion ?? '56'
  })`;

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 24 }]}
    >
      {/* Account & sync — identity, sign in/out, and sync status in one card.
          The auth control sits beside the identity (sign in with a provider, or
          log out); the sync row below shows backup status. All inline — no
          separate screen. */}
      <View style={styles.section}>
      <Text style={styles.sectionLabel}>{t('settings.section.account')}</Text>
      <Card style={styles.account} elevated={false}>
        <View style={styles.accountHeader}>
          {isAuthenticated ? (
            <>
              <View style={styles.accountText}>
                <Text style={styles.accountMeta}>{t('settings.account.signedIn')}</Text>
                <Text style={styles.accountName} numberOfLines={1}>
                  {auth.email ?? auth.displayName ?? t('settings.account.signedIn')}
                </Text>
              </View>
              <Button
                variant="ghost"
                size="sm"
                disabled={authBusy !== null}
                onPress={handleSignOut}
              >
                {t('settings.account.signOut')}
              </Button>
            </>
          ) : auth.status === 'not_configured' ? (
            <View style={styles.accountText}>
              <Text style={styles.accountName} numberOfLines={1}>
                {t('settings.account.cloudUnavailable')}
              </Text>
              <Text style={styles.accountMeta} numberOfLines={1}>
                {t('settings.account.worksOffline')}
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.accountText}>
                <Text style={styles.accountName} numberOfLines={1}>
                  {t('settings.account.signIn')}
                </Text>
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

        {/* Sync — status-led: the right glyph is the state. Tappable only when
            there is queued work to upload; otherwise a static checkmark. */}
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
            ) : cloudAvailable ? (
              <Ionicons name="checkmark-circle" size={20} color={palette.success} />
            ) : undefined
          }
        />
      </Card>
      </View>

      {/* Library — navigation into the user's own content. Reviewing AI
          suggestions now lives on the Inbox (the persistent review banner), not
          here — Settings is for configuration, not a recurring workflow. */}
      <Group styles={styles} title={t('settings.section.library')}>
        <Row
          styles={styles}
          palette={palette}
          icon="trash-outline"
          label={t('settings.trash.label')}
          value={t('settings.trash.value', { count: trash.length })}
          last
          onPress={() => router.push('/trash')}
        />
      </Group>

      {/* Preferences — everyday app behaviour: language, share landing, and the
          search-history privacy control. */}
      <Group styles={styles} title={t('settings.section.preferences')}>
        <Row
          styles={styles}
          palette={palette}
          icon="language-outline"
          label={t('settings.language.label')}
          value={t(
            LANGUAGE_OPTIONS.find((option) => option.value === languagePref)?.labelKey ??
              'settings.language.system',
          )}
          onPress={() => setLanguageSheetOpen(true)}
        />
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
          right={
            <Switch
              value={shareBehavior === 'inbox'}
              onValueChange={(on) => setShareBehavior(on ? 'inbox' : 'toast')}
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
          label={t('settings.search.clearLabel')}
          value={
            recentCount > 0
              ? t('settings.search.clearValue', { count: recentCount })
              : t('settings.search.clearEmpty')
          }
          accessibilityLabel={t('search.clearRecentsA11y')}
          last
          disabled={recentCount === 0}
          onPress={recentCount > 0 ? confirmClearRecents : undefined}
        />
      </Group>

      {/* Save from your browser — the desktop bookmarklet (web only). Native
          apps capture via the OS share sheet, so this is meaningless there. */}
      {Platform.OS === 'web' ? (
        <Group
          styles={styles}
          title={t('settings.section.browser')}
          footnote={t('settings.bookmarklet.note')}
        >
          <View style={styles.bookmarkletRow}>
            <BookmarkletButton
              label={t('settings.bookmarklet.button')}
              copiedLabel={t('settings.bookmarklet.copied')}
              accent={palette.accent}
            />
          </View>
        </Group>
      ) : null}

      {/* Your data — export / import / portability. */}
      <Group
        styles={styles}
        title={t('settings.section.data')}
        footnote={t('settings.dataNote')}
      >
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

      {/* Advanced — developer mode toggle, and the diagnostics it reveals. */}
      <Group styles={styles} title={t('settings.section.advanced')}>
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
          <Group styles={styles} title={t('settings.diagnostics.title')}>
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

          {queue.length === 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{t('settings.queue.title')}</Text>
              <Text style={styles.emptyQueue}>{t('settings.queue.empty')}</Text>
            </View>
          ) : (
            <Group styles={styles} title={t('settings.queue.title')}>
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

      <Pressable
        onPress={() => router.push('/report')}
        style={styles.reportLink}
        accessibilityRole="link"
        accessibilityLabel={t('settings.report.label')}
      >
        <Text style={styles.reportLinkText}>{t('settings.report.label')}</Text>
      </Pressable>

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
          {
            key: 'csv',
            label: t('settings.importSheet.pocket'),
            icon: 'bookmark-outline',
            onPress: () => void runImport('csv'),
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
    container: {
      padding: 16,
      gap: 18,
    },
    account: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: 'hidden',
    },
    accountHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    authButtons: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
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
    section: {
      gap: 8,
    },
    group: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: 'hidden',
    },
    bookmarkletRow: {
      padding: 16,
      alignItems: 'flex-start',
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
    reportLink: {
      alignItems: 'center',
      paddingVertical: 8,
    },
    reportLinkText: {
      fontSize: 13,
      color: palette.textSecondary,
      textDecorationLine: 'underline',
    },
    emptyQueue: {
      fontSize: 14,
      color: palette.textSecondary,
      marginLeft: 4,
    },
    footnote: {
      fontSize: 13,
      color: palette.textSecondary,
      marginHorizontal: 4,
      lineHeight: 18,
    },
  });
