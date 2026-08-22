import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { parseCaptureParams } from '@/domain/web-capture';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { KeyboardAvoidingScreen } from '@/ui/KeyboardAvoidingScreen';
import { useCaptureToast } from '@/ui/capture-toast';
import { useBookmarks } from '@/store/bookmarks';

// On wide (desktop-web) viewports, Add docks as a right-side sheet over the
// dimmed Inbox (mirrors Report's right-docked sheet); this caps the panel
// width. No effect on phones (their width is already below the breakpoint).
const SHEET_PANEL_MAX_WIDTH = 480;
const MAX_MEMO_LENGTH = 10_000;

type AddMode = 'link' | 'memo';

export default function AddBookmarkScreen() {
  const palette = usePalette();
  const router = useRouter();
  const t = useT();
  const insets = useSafeAreaInsets();
  // Wide viewports present Add as a right-side sheet over a dimmed Inbox;
  // phones keep the full-screen layout (mirrors Report's sheet).
  const { width, height } = useWindowDimensions();
  const asSheet = width >= 760;
  const { addBookmark, isLoading } = useBookmarks();
  const { show } = useCaptureToast();
  const [mode, setMode] = useState<AddMode>('link');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [memoTitle, setMemoTitle] = useState('');
  const [memoBody, setMemoBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  // A capture intent passed via query params — the web counterpart of the
  // native share handler. The desktop bookmarklet, the PWA Web Share Target,
  // and plain `/add?url=…` deep links all land here. When present we skip the
  // manual editor and save immediately: capture is sacred and fast.
  const params = useLocalSearchParams<{
    url?: string;
    title?: string;
    text?: string;
    note?: string;
  }>();
  const capture = parseCaptureParams(params);
  const captureHandledRef = useRef(false);

  useEffect(() => {
    // Save once the store has loaded so the in-memory dedupe sees existing
    // bookmarks instead of running against an empty set during a cold start
    // (mirrors ShareIntentHandler). Handle exactly once.
    if (!capture || isLoading || captureHandledRef.current) {
      return;
    }
    captureHandledRef.current = true;
    const result = capture.url
      ? addBookmark({
          url: capture.url,
          title: capture.title,
          // Preserve any accompanying text (a PWA Web Share Target's selected
          // quote / description) as the note. A share target that merely echoes
          // the URL back into `text` shouldn't duplicate it as a note.
          notes: capture.text && capture.text !== capture.url ? capture.text : undefined,
        })
      : addBookmark({ shared_text: capture.text, title: capture.title });
    const message =
      result.status === 'invalid'
        ? result.reason === 'too_long'
          ? t('toast.urlTooLong')
          : t('toast.noLink')
        : result.status === 'duplicate'
          ? t('toast.duplicate')
          : t('toast.saved');
    show(message);
    // Land on the Inbox so the freshly stashed item is immediately visible.
    router.replace('/');
  }, [capture, isLoading, addBookmark, router, show, t]);

  // Capture mode: a deep-linked save is in flight — show a calm placeholder
  // instead of flashing the manual editor before the redirect. Add is a
  // `transparentModal`, so (as with the main layout below) the height is
  // pinned explicitly — on web the modal container sizes to content, and a
  // bare `flex: 1` here would collapse and let the Inbox bleed through.
  if (capture) {
    return (
      <View style={[styles.capturing, { backgroundColor: palette.background, height }]}>
        <ActivityIndicator color={palette.accent} />
        <Text style={[styles.capturingLabel, { color: palette.textSecondary }]}>
          {t('add.saving')}
        </Text>
      </View>
    );
  }

  function handleSave() {
    if (mode === 'memo' && !memoBody.trim()) {
      setError(t('add.memoRequired'));
      return;
    }
    const result =
      mode === 'memo'
        ? addBookmark({ title: memoTitle, shared_text: memoBody })
        : addBookmark({ url, notes: note });
    if (result.status === 'invalid') {
      setError(result.error);
      return;
    }
    // Confirm with the same capture toast the share flow uses, so adding a URL
    // that's already saved reads identically however it was captured. The
    // bookmark is already visible in Inbox, so capture stays fast and
    // non-blocking.
    show(result.status === 'duplicate' ? t('toast.duplicate') : t('toast.saved'));
    router.back();
  }

  const content = (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Card elevated={false} style={styles.captureCard}>
        <View
          accessibilityRole="tablist"
          style={[styles.modeSwitch, { backgroundColor: palette.surface, borderColor: palette.border }]}
        >
          {(['link', 'memo'] as const).map((value) => {
            const selected = mode === value;
            return (
              <Pressable
                key={value}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={t(value === 'link' ? 'add.modeLinkA11y' : 'add.modeMemoA11y')}
                onPress={() => {
                  setMode(value);
                  setError(null);
                }}
                style={[
                  styles.modeButton,
                  selected && { backgroundColor: palette.accentSoft },
                ]}
              >
                <Text
                  style={[
                    styles.modeButtonText,
                    { color: selected ? palette.accent : palette.textSecondary },
                  ]}
                >
                  {t(value === 'link' ? 'add.modeLink' : 'add.modeMemo')}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {mode === 'link' ? (
          <>
            <Text style={[styles.label, { color: palette.textSecondary }]}>{t('add.urlLabel')}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: palette.card, color: palette.text }]}
              placeholder={t('add.urlPlaceholder')}
              placeholderTextColor={palette.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              keyboardType="url"
              value={url}
              onChangeText={(value) => {
                setUrl(value);
                if (error) {
                  setError(null);
                }
              }}
              onSubmitEditing={handleSave}
            />
            {error ? <Text style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
            <Text style={[styles.label, { color: palette.textSecondary }]}>{t('add.noteLabel')}</Text>
            <TextInput
              style={[
                styles.input,
                styles.noteInput,
                { backgroundColor: palette.card, color: palette.text },
              ]}
              placeholder={t('add.notePlaceholder')}
              placeholderTextColor={palette.textSecondary}
              multiline
              value={note}
              onChangeText={setNote}
            />
          </>
        ) : (
          <>
            <Text style={[styles.label, { color: palette.textSecondary }]}>{t('add.memoTitleLabel')}</Text>
            <TextInput
              accessibilityLabel={t('add.memoTitleLabel')}
              style={[styles.input, { backgroundColor: palette.card, color: palette.text }]}
              placeholder={t('add.memoTitlePlaceholder')}
              placeholderTextColor={palette.textSecondary}
              value={memoTitle}
              onChangeText={setMemoTitle}
            />
            <Text style={[styles.label, { color: palette.textSecondary }]}>{t('add.memoBodyLabel')}</Text>
            <TextInput
              accessibilityLabel={t('add.memoBodyLabel')}
              style={[
                styles.input,
                styles.memoInput,
                { backgroundColor: palette.card, color: palette.text },
              ]}
              placeholder={t('add.memoBodyPlaceholder')}
              placeholderTextColor={palette.textSecondary}
              autoCapitalize="sentences"
              autoCorrect
              autoFocus
              maxLength={MAX_MEMO_LENGTH}
              multiline
              value={memoBody}
              onChangeText={(value) => {
                setMemoBody(value);
                if (error) {
                  setError(null);
                }
              }}
            />
            {error ? <Text style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
          </>
        )}
      </Card>
      <Button size="lg" onPress={handleSave}>
        {t(mode === 'memo' ? 'add.saveMemo' : 'add.save')}
      </Button>
      <Text style={[styles.hint, { color: palette.textSecondary }]}>
        {t(mode === 'memo' ? 'add.memoHint' : 'add.hint')}
      </Text>
    </ScrollView>
  );

  // The Stack header is hidden for this screen, so Add supplies its own header
  // row (title + close) for both layouts — matching Settings/Report/Review.
  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: palette.border }]}>
      <Text style={[styles.headerTitle, { color: palette.text }]}>{t('nav.addBookmark')}</Text>
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

  // KeyboardAvoidingScreen wraps only `content` (not the pinned-height root
  // above): its `flex: 1` needs to sit *inside* the fixed-height box so its
  // bottom padding actually shrinks the visible form when the keyboard opens.
  // Wrapping the whole root would pin `flex: 1` and an explicit `height` on
  // the same node, so the padding couldn't reduce anything — the note field
  // would end up under the keyboard instead.
  return asSheet ? (
    <View style={[styles.sheetOverlay, { height }]}>
      <Pressable
        testID="add-sheet-backdrop"
        style={styles.sheetBackdrop}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        onPress={() => router.back()}
      />
      <View style={[styles.sheetPanel, { backgroundColor: palette.background }]}>
        {header}
        <KeyboardAvoidingScreen>{content}</KeyboardAvoidingScreen>
      </View>
    </View>
  ) : (
    <View testID="add-fullscreen" style={[styles.fullScreen, { backgroundColor: palette.background, height }]}>
      {header}
      <KeyboardAvoidingScreen>{content}</KeyboardAvoidingScreen>
    </View>
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
    maxWidth: SHEET_PANEL_MAX_WIDTH,
    height: '100%',
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: -4, height: 0 },
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  headerClose: {
    padding: 4,
  },
  container: {
    flexGrow: 1,
    padding: 16,
    gap: 14,
  },
  capturing: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  capturingLabel: {
    fontSize: 15,
  },
  captureCard: {
    borderRadius: 24,
    padding: 18,
    gap: 10,
  },
  modeSwitch: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 3,
    gap: 4,
  },
  modeButton: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    paddingHorizontal: 12,
  },
  modeButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  input: {
    borderRadius: 18,
    padding: 14,
    fontSize: 16,
  },
  noteInput: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  memoInput: {
    minHeight: 180,
    textAlignVertical: 'top',
  },
  error: {
    fontSize: 13,
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
});
