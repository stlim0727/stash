import { createSupabaseClient } from '@/supabase/client';
import type { StashSupabaseClient } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

// Client mirror of the `chat` edge function's protocol
// (supabase/functions/chat/chat-protocol.ts). The app can't import across the
// Deno/RN boundary, so the transcript shape is duplicated here — like
// RemoteBookmark mirrors the DB row.

export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatToolResult {
  call_id: string;
  output: unknown;
  is_error?: boolean;
}

export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; results: ChatToolResult[] };

/** A mutating action the assistant proposed, awaiting the user's approval. */
export interface ChatPendingAction {
  call_id: string;
  name: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface ChatDecision {
  call_id: string;
  decision: 'approved' | 'rejected';
}

export type ChatTurnResult =
  | { status: 'message'; text: string; transcript: ChatTurn[] }
  | {
      status: 'confirmation_required';
      text: string;
      pending: ChatPendingAction[];
      transcript: ChatTurn[];
    };

export class ChatApi {
  constructor(
    private readonly session: SupabaseAuthSession,
    private readonly client: StashSupabaseClient = createSupabaseClient(),
  ) {}

  /**
   * Send the running transcript (and optionally a decision resolving the last
   * proposed action) and get the assistant's next turn. The edge function is
   * stateless, so the returned `transcript` is the new source of truth to keep.
   */
  async send(messages: ChatTurn[], decision?: ChatDecision): Promise<ChatTurnResult> {
    return this.client.request<ChatTurnResult>('/functions/v1/chat', {
      method: 'POST',
      accessToken: this.session.access_token,
      body: { messages, ...(decision ? { decision } : {}) },
    });
  }
}

export function createChatApi(session: SupabaseAuthSession): ChatApi {
  return new ChatApi(session);
}
