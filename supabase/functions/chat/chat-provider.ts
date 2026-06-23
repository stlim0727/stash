// The model seam. Every model the chatbot can run behind — Gemini Flash,
// Claude Haiku, anything added later — implements ChatProvider. The agent loop
// (chat-loop.ts) depends only on this interface, so swapping or A/B-testing
// models is a constructor change in index.ts; the loop, the tool registry, and
// the mobile/web clients don't change.
//
// Dependency-free and runtime-agnostic, like the ai-enrich provider seam.

import type { ToolCall, Turn } from './chat-protocol.ts';
import type { ToolSpec } from './chat-tools.ts';

/** One model completion: free-text and/or a batch of tool calls. A turn with
 *  `tool_calls` non-empty means the model wants tools run before it continues;
 *  an empty `tool_calls` with `text` means it has a final answer. */
export interface Completion {
  text: string;
  tool_calls: ToolCall[];
}

export interface ChatProvider {
  /** Stored/loggable model id (e.g. 'gemini-2.5-flash-lite', 'claude-haiku-4-5'). */
  readonly model: string;
  /** Run one model step over the transcript with the given tools available.
   *  `system` is the system instruction (persona + rules). */
  complete(system: string, transcript: Turn[], tools: ToolSpec[]): Promise<Completion>;
}

/** Minimal slice of `fetch` the HTTP-backed adapters rely on, so tests can
 *  supply a stub without DOM/Deno lib types (mirrors ai-enrich's FetchLike). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
