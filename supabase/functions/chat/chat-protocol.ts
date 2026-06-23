// Provider-neutral chat protocol.
//
// These are the shapes the agent loop (chat-loop.ts) and every model adapter
// (gemini-chat-provider.ts, claude-chat-provider.ts) agree on. Keeping them
// separate from any provider's wire format is what makes the model swappable:
// adapters translate to/from their own API here, and the loop only ever sees
// these types.
//
// Like the ai-enrich provider seam, this module is dependency-free and
// runtime-agnostic (no Deno/Node/React Native imports) so it is unit-testable
// under Node and imported unchanged by the Deno edge function.

export type Role = 'user' | 'assistant' | 'system';

/** A model's request to call one tool. `id` lets a later tool result refer back
 *  to it (and lets the confirm flow name a specific pending action). */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The outcome of executing one tool call, fed back to the model next turn. */
export interface ToolResult {
  call_id: string;
  /** JSON-serializable. For reads, the data; for a declined mutation, a note. */
  output: unknown;
  is_error?: boolean;
}

/** One entry in the running transcript. The client stores these between turns
 *  (the edge function is stateless) and resends them on every request. */
export type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

/** A mutating action the model proposed and that is waiting on the user's OK.
 *  `summary` is human-readable confirm copy the client shows verbatim. */
export interface PendingAction {
  call_id: string;
  name: string;
  input: Record<string, unknown>;
  summary: string;
}

/** The user's verdict on a `PendingAction`, sent back on the next request. */
export interface Decision {
  call_id: string;
  decision: 'approved' | 'rejected';
}

/** What `runChatTurn` returns to the edge function (and ultimately the client).
 *  - `message`: the assistant has a final answer; `transcript` is the full
 *    updated history to persist.
 *  - `confirmation_required`: the model wants to perform a mutating action;
 *    nothing was executed. Show `pending` to the user; on approval, resend
 *    `transcript` plus a matching `Decision`. */
export type ChatTurnResult =
  | { status: 'message'; text: string; transcript: Turn[] }
  | { status: 'confirmation_required'; text: string; pending: PendingAction[]; transcript: Turn[] };
