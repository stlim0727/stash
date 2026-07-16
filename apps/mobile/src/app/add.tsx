import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
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
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
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
  // instead of flashing the manual editor before the redirect.
  if (capture) {
    return (
      <View style={[styles.capturing, { backgroundColor: palette.background }]}>
        <ActivityIndicator color={palette.accent} />
        <Text style={[styles.capturingLabel, { color: palette.textSecondary }]}>
          {t('add.saving')}
        </Text>
      </View>
    );
  }

  function handleSave() {
    const result = addBookmark({ url, notes: note });
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
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <Card elevated={false} style={styles.captureCard}>
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
      </Card>
      <Button size="lg" onPress={handleSave}>{t('add.save')}</Button>
      <Text style={[styles.hint, { color: palette.textSecondary }]}>{t('add.hint')}</Text>
    </View>
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

  return (
    <KeyboardAvoidingScreen>
      {asSheet ? (
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
            {content}
          </View>
        </View>
      ) : (
        <View testID="add-fullscreen" style={[styles.fullScreen, { backgroundColor: palette.background, height }]}>
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
    flex: 1,
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
  error: {
    fontSize: 13,
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
});
