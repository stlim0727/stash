// ChatProvider backed by the Google Gemini API (default model: Flash-Lite —
// the cheapest tier, and the same provider Stash already uses for ai-enrich, so
// it reuses the existing GEMINI_API_KEY). Translates the neutral protocol
// to/from Gemini's function-calling wire format.
//
// Dependency-free, runtime-agnostic, `fetch` injected — mirrors the ai-enrich
// Gemini provider so it runs in Deno and is unit-testable under Node.

import { ProviderError, type Completion, type ChatProvider, type FetchLike } from './chat-provider.ts';
import type { ToolCall, Turn } from './chat-protocol.ts';
import type { ToolSpec } from './chat-tools.ts';

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GeminiChatProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

/** Map the neutral transcript to Gemini `contents`. Assistant→'model'; tool
 *  results become a 'user' turn of functionResponse parts (keyed by name, since
 *  Gemini matches responses to calls by function name within the turn). */
function toGeminiContents(transcript: Turn[]): Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> {
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];
  // call_id → function name, so a later tool result names the right function.
  const callName = new Map<string, string>();
  for (const turn of transcript) {
    if (turn.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: turn.content }] });
    } else if (turn.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (turn.content.trim()) parts.push({ text: turn.content });
      for (const call of turn.tool_calls ?? []) {
        callName.set(call.id, call.name);
        parts.push({ functionCall: { name: call.name, args: call.input } });
      }
      if (parts.length === 0) parts.push({ text: '(working…)' });
      contents.push({ role: 'model', parts });
    } else {
      contents.push({
        role: 'user',
        parts: turn.results.map((r) => ({
          functionResponse: {
            name: callName.get(r.call_id) ?? r.call_id,
            response: { result: r.output },
          },
        })),
      });
    }
  }
  return contents;
}

/** Gemini function declarations take the same JSON-schema-ish parameter shape. */
function toGeminiTools(tools: ToolSpec[]): unknown {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

/** Parse a Gemini generateContent response into a neutral Completion. */
export function parseGeminiCompletion(body: unknown): Completion {
  const candidates = (body as { candidates?: unknown }).candidates;
  const first = Array.isArray(candidates) ? (candidates[0] as Record<string, unknown>) : undefined;
  const content = first?.content as { parts?: GeminiPart[] } | undefined;
  const parts = content?.parts ?? [];
  let text = '';
  const tool_calls: ToolCall[] = [];
  for (const part of parts) {
    if (typeof part.text === 'string') {
      text += part.text;
    } else if (part.functionCall) {
      tool_calls.push({
        // Gemini doesn't supply a call id — synthesize a stable one for the turn.
        id: `${part.functionCall.name}_${tool_calls.length}`,
        name: part.functionCall.name,
        input: (part.functionCall.args ?? {}) as Record<string, unknown>,
      });
    }
  }
  return { text, tool_calls };
}

export class GeminiChatProvider implements ChatProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: GeminiChatProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async complete(system: string, transcript: Turn[], tools: ToolSpec[]): Promise<Completion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: toGeminiContents(transcript),
          tools: tools.length > 0 ? toGeminiTools(tools) : undefined,
        }),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new ProviderError(`Gemini request failed (${res.status}): ${raw.slice(0, 500)}`, res.status);
      }
      return parseGeminiCompletion(JSON.parse(raw));
    } finally {
      clearTimeout(timer);
    }
  }
}
