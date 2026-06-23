// The provider-agnostic agent loop.
//
// One call to `runChatTurn` drives the model until it either produces a final
// answer or proposes a mutating action that needs the user's approval. It is
// pure orchestration: the model (ChatProvider) and the tool executor are both
// injected, so this is unit-testable under Node with fakes and reused unchanged
// by the Deno edge function.
//
// Confirm-before-acting:
//   - READ tools run automatically; their results are fed back to the model.
//   - MUTATING tools are NEVER run here. When the model calls one, the loop
//     stops and returns `confirmation_required` with the proposed action(s).
//     The client shows them; on approval it resends the transcript plus a
//     Decision, and a fresh `runChatTurn` resolves the pending call (executing
//     it on 'approved', or recording the refusal on 'rejected') before
//     continuing.
//
// The edge function is stateless: the full `transcript` round-trips with the
// client every turn.

import type {
  ChatTurnResult,
  Decision,
  Turn,
  ToolCall,
  ToolResult,
} from './chat-protocol.ts';
import type { ChatProvider } from './chat-provider.ts';
import { CHAT_TOOLS, describeAction, isMutating, type ToolSpec } from './chat-tools.ts';

/** Runs a single tool call against the user's data and returns its output.
 *  Supplied by the edge function (scoped to the authenticated user); the loop
 *  treats it as an opaque, already-authorized executor. */
export type ToolExecutor = (call: ToolCall) => Promise<ToolResult>;

export interface RunChatTurnOptions {
  provider: ChatProvider;
  system: string;
  transcript: Turn[];
  execute: ToolExecutor;
  /** Resolves the pending mutating action from the previous turn, if any. */
  decision?: Decision;
  /** Tools exposed to the model. Defaults to the full Stash tool registry. */
  tools?: ToolSpec[];
  /** Safety cap on model↔tool round-trips in one turn. Default 8. */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 8;

/** Find the most recent assistant turn's tool_calls that have no matching
 *  tool result yet — i.e. a mutating call awaiting the user's decision. */
function unresolvedToolCalls(transcript: Turn[]): ToolCall[] {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const turn = transcript[i];
    if (turn.role === 'tool') return []; // calls already resolved
    if (turn.role === 'assistant' && turn.tool_calls && turn.tool_calls.length > 0) {
      return turn.tool_calls;
    }
  }
  return [];
}

export async function runChatTurn(options: RunChatTurnOptions): Promise<ChatTurnResult> {
  const { provider, system, execute, decision } = options;
  const tools = options.tools ?? CHAT_TOOLS;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  // Work on a copy; the returned transcript is what the client should persist.
  const transcript: Turn[] = [...options.transcript];

  // 1. Resolve a pending confirmation from the prior turn, if the client sent one.
  if (decision) {
    const pending = unresolvedToolCalls(transcript).find((c) => c.id === decision.call_id);
    if (pending) {
      const result =
        decision.decision === 'approved'
          ? await execute(pending)
          : {
              call_id: pending.id,
              output: 'The user declined this action. Do not perform it; acknowledge and continue.',
            };
      transcript.push({ role: 'tool', results: [result] });
    }
  }

  // 2. Drive the model until it answers or asks to mutate.
  for (let step = 0; step < maxSteps; step++) {
    const completion = await provider.complete(system, transcript, tools);

    if (completion.tool_calls.length === 0) {
      transcript.push({ role: 'assistant', content: completion.text });
      return { status: 'message', text: completion.text, transcript };
    }

    const mutating = completion.tool_calls.filter((c) => isMutating(c.name));
    if (mutating.length > 0) {
      // Stop and ask. Record the assistant turn (with its calls) so the client
      // can resend it alongside the user's decision; execute nothing.
      transcript.push({ role: 'assistant', content: completion.text, tool_calls: completion.tool_calls });
      return {
        status: 'confirmation_required',
        text: completion.text,
        pending: mutating.map((c) => ({
          call_id: c.id,
          name: c.name,
          input: c.input,
          summary: describeAction(c.name, c.input),
        })),
        transcript,
      };
    }

    // All read tools: run them and feed results back.
    transcript.push({ role: 'assistant', content: completion.text, tool_calls: completion.tool_calls });
    const results: ToolResult[] = [];
    for (const call of completion.tool_calls) {
      results.push(await execute(call));
    }
    transcript.push({ role: 'tool', results });
  }

  // Ran out of steps — return what we have rather than loop forever.
  const text = 'I wasn’t able to finish that — could you narrow it down?';
  transcript.push({ role: 'assistant', content: text });
  return { status: 'message', text, transcript };
}
