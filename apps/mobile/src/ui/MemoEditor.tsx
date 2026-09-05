import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { PostHogMaskView } from 'posthog-react-native';

import type { TextFormat } from '@/domain/types';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { MarkdownBody } from '@/ui/MarkdownBody';

export interface MemoDraft {
  value: string;
  format: TextFormat;
}

interface MemoEditorProps extends MemoDraft {
  label: string;
  accessibilityLabel: string;
  placeholder: string;
  onChange: (draft: MemoDraft) => void;
  onCommit?: (draft: MemoDraft) => void;
  alwaysEditing?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
}

/** Shared source-preserving editor for memo bodies and bookmark notes. */
export function MemoEditor({
  value,
  format,
  label,
  accessibilityLabel,
  placeholder,
  onChange,
  onCommit,
  alwaysEditing = false,
  autoFocus = false,
  maxLength = 10_000,
}: MemoEditorProps) {
  const t = useT();
  const palette = usePalette();
  const [editing, setEditing] = useState(alwaysEditing);
  const [preview, setPreview] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const inputRef = useRef<TextInput | null>(null);
  const inputScrollRef = useRef<number | null>(null);
  const focusRequestedRef = useRef(false);
  const latest = useRef<MemoDraft>({ value, format });
  latest.current = { value, format };
  const showingInput = editing && !(format === 'markdown' && preview);

  useEffect(() => {
    if (Platform.OS !== 'web' || !showingInput) return;
    const node = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!node || !('style' in node)) return;
    const scrollTop = inputScrollRef.current ?? node.scrollTop;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
    node.scrollTop = scrollTop;
    inputScrollRef.current = null;
  }, [value, showingInput]);

  useEffect(() => {
    if (!focusRequestedRef.current || !showingInput || menuOpen) return;
    const node = Platform.OS === 'web'
      ? inputRef.current as unknown as HTMLTextAreaElement | null
      : null;
    const scrollTop = node?.scrollTop;
    inputRef.current?.focus();
    if (node && scrollTop !== undefined) node.scrollTop = scrollTop;
    focusRequestedRef.current = false;
  }, [focusRequest, showingInput, menuOpen]);

  function restoreInputFocus() {
    focusRequestedRef.current = true;
    setFocusRequest((request) => request + 1);
  }

  function beginEditing() {
    setEditing(true);
    setPreview(false);
    setMenuOpen(false);
    restoreInputFocus();
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={[styles.label, { color: palette.textSecondary }]}>{label}</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('memo.formatA11y', { field: label })}
            accessibilityValue={{ text: t(format === 'plain' ? 'memo.plain' : 'memo.markdown') }}
            accessibilityState={{ expanded: menuOpen }}
            onPress={() => setMenuOpen((open) => !open)}
            style={styles.button}
          >
            <Text style={[styles.actionText, { color: palette.textSecondary }]}>
              {t(format === 'plain' ? 'memo.plain' : 'memo.markdown')} ▾
            </Text>
          </Pressable>
          {!alwaysEditing && (editing || value !== '') ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(editing ? 'memo.doneA11y' : 'memo.editA11y', { field: label })}
              onPress={() => {
                if (!editing) {
                  beginEditing();
                  return;
                }
                onCommit?.(latest.current);
                setEditing(false);
                setPreview(false);
                setMenuOpen(false);
              }}
              style={styles.button}
            >
              <Text style={[styles.actionText, { color: palette.accent }]}>
                {t(editing ? 'memo.done' : 'memo.edit')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {menuOpen ? (
        <View style={[styles.formatMenu, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          {(['plain', 'markdown'] as const).map((option) => (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={t(option === 'plain' ? 'memo.plain' : 'memo.markdown')}
              accessibilityState={{ checked: format === option }}
              onPress={() => {
                const next = { value: latest.current.value, format: option };
                latest.current = next;
                onChange(next);
                onCommit?.(next);
                setMenuOpen(false);
                if (option === 'plain') setPreview(false);
                if (editing && (option === 'plain' || !preview)) restoreInputFocus();
              }}
              style={[styles.formatOption, format === option && { backgroundColor: palette.accentSoft }]}
            >
              <Text style={{ color: format === option ? palette.accent : palette.text }}>
                {t(option === 'plain' ? 'memo.plain' : 'memo.markdown')}
              </Text>
              <Text style={[styles.formatHint, { color: palette.textSecondary }]}>
                {t(option === 'plain' ? 'memo.plainHint' : 'memo.markdownHint')}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {editing && format === 'markdown' ? (
        <View accessibilityRole="tablist" style={styles.tabs}>
          {([false, true] as const).map((isPreview) => (
            <Pressable
              key={String(isPreview)}
              accessibilityRole="tab"
              accessibilityState={{ selected: preview === isPreview }}
              onPress={() => {
                if (isPreview && Platform.OS === 'web') {
                  const node = inputRef.current as unknown as HTMLTextAreaElement | null;
                  inputScrollRef.current = node?.scrollTop ?? null;
                }
                setPreview(isPreview);
                if (!isPreview) restoreInputFocus();
              }}
              style={[styles.tab, preview === isPreview && { backgroundColor: palette.accentSoft }]}
            >
              <Text style={[styles.actionText, { color: preview === isPreview ? palette.accent : palette.textSecondary }]}>
                {t(isPreview ? 'memo.preview' : 'memo.write')}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {/* Keep the input mounted across preview/format switches so its native
          selection and scroll state survive. Blur saves without ending editing. */}
      {editing ? (
        <View style={!showingInput ? styles.hidden : undefined}>
          <TextInput
            ref={inputRef}
            accessibilityLabel={accessibilityLabel}
            placeholder={placeholder}
            placeholderTextColor={palette.textSecondary}
            autoFocus={autoFocus || !alwaysEditing}
            autoCapitalize="sentences"
            autoCorrect
            multiline
            maxLength={maxLength}
            scrollEnabled
            value={value}
            onChangeText={(text) => {
              const next = { value: text, format: latest.current.format };
              latest.current = next;
              onChange(next);
            }}
            onBlur={() => onCommit?.(latest.current)}
            style={[styles.input, { backgroundColor: palette.surfaceElevated, borderColor: palette.border, color: palette.text }]}
          />
        </View>
      ) : null}
      {!editing && value === '' ? (
        <Pressable accessibilityRole="button" accessibilityLabel={placeholder} onPress={beginEditing} style={styles.empty}>
          <Text style={{ color: palette.textSecondary }}>{placeholder}</Text>
        </Pressable>
      ) : !showingInput ? (
        <View style={[styles.reading, { backgroundColor: palette.surfaceElevated }]}>
          {format === 'markdown' ? <MarkdownBody markdown={value} /> : (
            <View>
              {/* The mask replaces its wrapper's accessibility label. Keep a
                  sibling that announces the literal source, as MarkdownBody does. */}
              <View accessible accessibilityLabel={value} style={styles.srOnly} />
              <PostHogMaskView>
                <Text selectable style={[styles.body, { color: palette.text }]}>{value}</Text>
              </PostHogMaskView>
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  label: { fontSize: 13, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  actionText: { fontSize: 13, fontWeight: '600' },
  formatMenu: { alignSelf: 'flex-end', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 4, minWidth: 160 },
  formatOption: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 4, borderRadius: 8 },
  formatHint: { fontSize: 12, lineHeight: 18 },
  tabs: { flexDirection: 'row', alignSelf: 'flex-start', gap: 4 },
  tab: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 9 },
  hidden: { display: 'none' },
  input: { minHeight: 120, maxHeight: 420, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, fontSize: 15, lineHeight: 22, textAlignVertical: 'top' },
  reading: { borderRadius: 14, padding: 14 },
  body: { fontSize: 16, lineHeight: 24 },
  empty: { minHeight: 44, justifyContent: 'center' },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
});
