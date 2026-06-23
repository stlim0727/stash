import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { createChatApi } from '@/api/chat';
import type { ChatDecision, ChatPendingAction, ChatTurn } from '@/api/chat';
import { useI18n } from '@/i18n';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { useSupabaseAuth } from '@/supabase/auth-provider';

interface Bubble {
  key: string;
  role: 'user' | 'assistant';
  text: string;
}

/** Render only the user prompts and the assistant's spoken text. Tool turns and
 *  tool-call-only assistant turns are internal plumbing and stay hidden. */
function toBubbles(transcript: ChatTurn[]): Bubble[] {
  const bubbles: Bubble[] = [];
  transcript.forEach((turn, i) => {
    if (turn.role === 'user') {
      bubbles.push({ key: `u${i}`, role: 'user', text: turn.content });
    } else if (turn.role === 'assistant' && turn.content.trim()) {
      bubbles.push({ key: `a${i}`, role: 'assistant', text: turn.content });
    }
  });
  return bubbles;
}

interface ChatScreenProps {
  /** Injectable for tests; defaults to the real chat client. */
  createApi?: typeof createChatApi;
}

export default function ChatScreen({ createApi = createChatApi }: ChatScreenProps = {}) {
  const palette = usePalette();
  const styles = makeStyles(palette);
  const { t } = useI18n();
  const auth = useSupabaseAuth();

  const [transcript, setTranscript] = useState<ChatTurn[]>([]);
  const [pending, setPending] = useState<ChatPendingAction[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const scrollToEnd = () => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  };

  // One round-trip: send the transcript (+ optional decision), adopt the
  // returned transcript, and surface any action that needs confirmation.
  const exchange = async (next: ChatTurn[], decision?: ChatDecision) => {
    setBusy(true);
    setError(null);
    try {
      const session = await auth.ensureAnonymousSession();
      if (!session) throw new Error('no session');
      const result = await createApi(session).send(next, decision);
      setTranscript(result.transcript);
      setPending(result.status === 'confirmation_required' ? result.pending : []);
    } catch {
      setError(t('chat.error'));
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || busy || pending.length > 0) return;
    const next: ChatTurn[] = [...transcript, { role: 'user', content: text }];
    setTranscript(next);
    setInput('');
    void exchange(next);
  };

  const handleDecision = (action: ChatPendingAction, decision: 'approved' | 'rejected') => {
    if (busy) return;
    void exchange(transcript, { call_id: action.call_id, decision });
  };

  const bubbles = toBubbles(transcript);
  const canSend = input.trim().length > 0 && !busy && pending.length === 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={scrollToEnd}
      >
        {bubbles.length === 0 && pending.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="chatbubbles-outline" size={40} color={palette.textSecondary} />
            <Text style={styles.emptyText}>{t('chat.empty')}</Text>
          </View>
        ) : null}

        {bubbles.map((b) => (
          <View
            key={b.key}
            style={[styles.bubble, b.role === 'user' ? styles.userBubble : styles.assistantBubble]}
          >
            <Text style={b.role === 'user' ? styles.userText : styles.assistantText}>{b.text}</Text>
          </View>
        ))}

        {/* Confirm-before-acting: nothing has run yet — the user decides. */}
        {pending.map((action) => (
          <Card key={action.call_id} style={styles.confirmCard} elevated={false}>
            <View style={styles.confirmHeader}>
              <Ionicons name="alert-circle-outline" size={18} color={palette.accent} />
              <Text style={styles.confirmTitle}>{t('chat.confirm.title')}</Text>
            </View>
            <Text style={styles.confirmSummary}>{action.summary}</Text>
            <View style={styles.confirmActions}>
              <Button
                variant="ghost"
                size="sm"
                onPress={() => handleDecision(action, 'rejected')}
                disabled={busy}
              >
                {t('chat.confirm.reject')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onPress={() => handleDecision(action, 'approved')}
                disabled={busy}
              >
                {t('chat.confirm.approve')}
              </Button>
            </View>
          </Card>
        ))}

        {busy ? (
          <View style={styles.thinking}>
            <ActivityIndicator color={palette.accent} size="small" />
            <Text style={styles.thinkingText}>{t('chat.thinking')}</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={[styles.inputBar, { borderTopColor: palette.border }]}>
        <TextInput
          style={[styles.input, { color: palette.text, borderColor: palette.border }]}
          placeholder={t('chat.placeholder')}
          placeholderTextColor={palette.textSecondary}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          editable={pending.length === 0}
          returnKeyType="send"
          multiline
        />
        <Pressable
          onPress={handleSend}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel={t('chat.sendA11y')}
          style={({ pressed }) => [
            styles.sendBtn,
            { backgroundColor: canSend ? palette.accent : palette.border },
            pressed && canSend && { opacity: 0.7 },
          ]}
        >
          <Ionicons name="arrow-up" size={20} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (palette: ReturnType<typeof usePalette>) =>
  StyleSheet.create({
    scroll: {
      padding: 16,
      gap: 10,
      flexGrow: 1,
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      paddingVertical: 64,
    },
    emptyText: {
      fontSize: 15,
      color: palette.textSecondary,
      textAlign: 'center',
      lineHeight: 21,
      maxWidth: 260,
    },
    bubble: {
      maxWidth: '85%',
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    userBubble: {
      alignSelf: 'flex-end',
      backgroundColor: palette.accent,
      borderBottomRightRadius: 4,
    },
    assistantBubble: {
      alignSelf: 'flex-start',
      backgroundColor: palette.card,
      borderBottomLeftRadius: 4,
    },
    userText: {
      fontSize: 15,
      color: '#fff',
      lineHeight: 21,
    },
    assistantText: {
      fontSize: 15,
      color: palette.text,
      lineHeight: 21,
    },
    confirmCard: {
      alignSelf: 'stretch',
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    confirmHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    confirmTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.text,
    },
    confirmSummary: {
      fontSize: 15,
      color: palette.text,
      lineHeight: 21,
    },
    confirmActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
    },
    thinking: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'flex-start',
      paddingHorizontal: 4,
    },
    thinkingText: {
      fontSize: 14,
      color: palette.textSecondary,
    },
    error: {
      fontSize: 14,
      color: palette.danger,
      textAlign: 'center',
      marginTop: 4,
    },
    inputBar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    input: {
      flex: 1,
      fontSize: 15,
      maxHeight: 120,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 18,
    },
    sendBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
