// ChatProvider backed by the Anthropic Messages API (default model: Claude
// Haiku 4.5 — the cheapest Claude, with strong tool-call reliability and prompt
// caching that matters at scale). Translates the neutral protocol to/from
// Anthropic's tool-use wire format.
//
// Like the ai-enrich providers: dependency-free, runtime-agnostic, `fetch`
// injected — runs unchanged in Deno and is unit-testable under Node with a stub.

import { ProviderError, type Completion, type ChatProvider, type FetchLike } from './chat-provider.ts';
import type { ToolCall, Turn } from './chat-protocol.ts';
import type { ToolSpec } from './chat-tools.ts';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 30_000;
const ANTHROPIC_VERSION = '2023-06-01';

export interface ClaudeChatProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** Map the neutral transcript to Anthropic `messages`. Tool turns become a user
 *  message of tool_result blocks; assistant tool calls become tool_use blocks. */
function toAnthropicMessages(transcript: Turn[]): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = [];
  for (const turn of transcript) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: [{ type: 'text', text: turn.content }] });
    } else if (turn.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (turn.content.trim()) blocks.push({ type: 'text', text: turn.content });
      for (const call of turn.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      // Anthropic rejects empty content; guarantee at least one block.
      if (blocks.length === 0) blocks.push({ type: 'text', text: '(working…)' });
      messages.push({ role: 'assistant', content: blocks });
    } else {
      messages.push({
        role: 'user',
        content: turn.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.call_id,
          content: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
          is_error: r.is_error,
        })),
      });
    }
  }
  return messages;
}

function toAnthropicTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

/** Parse an Anthropic Messages response body into a neutral Completion. */
export function parseAnthropicCompletion(body: unknown): Completion {
  const content = (body as { content?: unknown }).content;
  const blocks = Array.isArray(content) ? content : [];
  let text = '';
  const tool_calls: ToolCall[] = [];
  for (const block of blocks) {
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      text += b.text;
    } else if (b.type === 'tool_use') {
      tool_calls.push({
        id: String(b.id ?? `call_${tool_calls.length}`),
        name: String(b.name ?? ''),
        input: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>,
      });
    }
  }
  return { text, tool_calls };
}

export class ClaudeChatProvider implements ChatProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: ClaudeChatProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async complete(system: string, transcript: Turn[], tools: ToolSpec[]): Promise<Completion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          // System prompt + tool definitions are a stable prefix that is resent
          // on every model round-trip; a cache_control breakpoint on the system
          // block caches tools+system together (tools render first), which is
          // the main cost lever for an agentic loop at scale. (Anthropic only
          // caches prefixes above a per-model minimum — ~4096 tokens on Haiku —
          // so this is a no-op until the tool set / system prompt is large
          // enough, then kicks in automatically.)
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
          // One tool call per turn so the confirm-before-acting pause is always
          // 1:1 — a mutating call never shares a batch with calls left unresolved
          // while we wait on the user (which the next request would reject).
          tool_choice: tools.length > 0 ? { type: 'auto', disable_parallel_tool_use: true } : undefined,
          messages: toAnthropicMessages(transcript),
        }),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new ProviderError(`Anthropic request failed (${res.status}): ${raw.slice(0, 500)}`, res.status);
      }
      return parseAnthropicCompletion(JSON.parse(raw));
    } finally {
      clearTimeout(timer);
    }
  }
}
