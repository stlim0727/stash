// Supabase Edge Function: chat
//
// A "chat with your bookmarks" assistant that can also ACT (create / tag /
// file / trash) on the user's library. Authenticated by the same stash_ API key
// as public-api. The model is swappable (Gemini Flash or Claude Haiku, chosen
// by CHAT_MODEL_PROVIDER) behind the ChatProvider seam; the agent loop, tools,
// and confirm-before-acting policy are provider-agnostic (see chat-loop.ts).
//
// Stateless: the client sends the full transcript each turn and persists the
// updated transcript the function returns.
//
// Request body:
//   { messages: Turn[], decision?: { call_id, decision: 'approved'|'rejected' } }
// Response: a ChatTurnResult — either { status:'message', text, transcript } or
//   { status:'confirmation_required', text, pending[], transcript }.

import { runChatTurn, type ToolExecutor } from './chat-loop.ts';
import type { Decision, ToolCall, ToolResult, Turn } from './chat-protocol.ts';
import type { ChatProvider } from './chat-provider.ts';
import { ClaudeChatProvider } from './claude-chat-provider.ts';
import { GeminiChatProvider } from './gemini-chat-provider.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PROVIDER = (Deno.env.get('CHAT_MODEL_PROVIDER') ?? 'gemini').toLowerCase();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function resolveUserIdFromApiKey(authorization: string | null): Promise<string | null> {
  if (!authorization?.startsWith('Bearer stash_')) return null;
  const hash = await sha256(authorization.slice('Bearer '.length));
  const res = await db('GET', `api_keys?key_hash=eq.${hash}&revoked_at=is.null&select=user_id&limit=1`);
  if (!res.ok) return null;
  const rows: Array<{ user_id: string }> = await res.json();
  return rows[0]?.user_id ?? null;
}

function db(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' || method === 'PATCH' ? 'return=representation' : 'return=minimal',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildSystemPrompt(): string {
  return [
    'You are Stash, a helpful assistant for the user\'s personal bookmark library.',
    'Answer questions about what they have saved, help them find things, and — when asked —',
    'organize their library (save, tag, file into collections, or trash bookmarks).',
    'Use the provided tools to look things up rather than guessing; never invent bookmark ids,',
    'tags, or collection names — read them with the list/search tools first.',
    'For any action that changes the library, the system will ask the user to confirm before it',
    'runs, so propose the action plainly and let the confirmation happen.',
    'Be concise. When you have enough information to answer, answer.',
  ].join(' ');
}

function selectProvider(): ChatProvider {
  if (PROVIDER === 'claude' || PROVIDER === 'anthropic') {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    return new ClaudeChatProvider({ apiKey, model: Deno.env.get('CHAT_MODEL') ?? undefined });
  }
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  return new GeminiChatProvider({ apiKey, model: Deno.env.get('CHAT_MODEL') ?? undefined });
}

// --- Tool execution (scoped to the authenticated user) ----------------------

function ok(call: ToolCall, output: unknown): ToolResult {
  return { call_id: call.id, output };
}
function err(call: ToolCall, message: string): ToolResult {
  return { call_id: call.id, output: { error: message }, is_error: true };
}

function str(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function makeExecutor(userId: string): ToolExecutor {
  return async (call: ToolCall): Promise<ToolResult> => {
    try {
      switch (call.name) {
        case 'search_bookmarks': {
          const limit = Math.min(Number(call.input.limit) || 20, 50);
          const qs = new URLSearchParams({
            user_id: `eq.${userId}`,
            is_archived: 'eq.false',
            select: 'id,title,url,notes,collection_id',
            order: 'created_at.desc',
            limit: String(limit),
          });
          const query = str(call.input, 'query');
          if (query) {
            const term = query.replace(/[%*,()]/g, '');
            qs.set('or', `(title.ilike.*${term}*,url.ilike.*${term}*,notes.ilike.*${term}*,description.ilike.*${term}*)`);
          }
          const collectionId = str(call.input, 'collection_id');
          if (collectionId) qs.set('collection_id', `eq.${collectionId}`);
          const res = await db('GET', `bookmarks?${qs}`);
          if (!res.ok) return err(call, 'search failed');
          return ok(call, { bookmarks: await res.json() });
        }
        case 'get_bookmark': {
          const id = str(call.input, 'id');
          if (!id) return err(call, 'id is required');
          const res = await db('GET', `bookmarks?id=eq.${id}&user_id=eq.${userId}&limit=1`);
          if (!res.ok) return err(call, 'lookup failed');
          const rows = await res.json();
          return rows[0] ? ok(call, rows[0]) : err(call, 'not found');
        }
        case 'list_collections': {
          const res = await db('GET', `collections?user_id=eq.${userId}&select=id,name&order=name.asc`);
          if (!res.ok) return err(call, 'list failed');
          return ok(call, { collections: await res.json() });
        }
        case 'list_tags': {
          const res = await db('GET', `tags?user_id=eq.${userId}&select=id,name&order=name.asc`);
          if (!res.ok) return err(call, 'list failed');
          return ok(call, { tags: await res.json() });
        }
        case 'create_bookmark': {
          const url = str(call.input, 'url');
          const sharedText = str(call.input, 'shared_text');
          if (!url && !sharedText) return err(call, 'url or shared_text is required');
          const ts = nowIso();
          const res = await db('POST', 'bookmarks', {
            user_id: userId,
            url,
            url_hash: url, // NOTE: should canonicalize to match public-api dedup — see README.
            title: str(call.input, 'title'),
            notes: str(call.input, 'notes'),
            description: sharedText,
            content_type: url ? 'url' : 'text',
            collection_id: str(call.input, 'collection_id'),
            source_app: 'chat',
            is_archived: false,
            created_at: ts,
            updated_at: ts,
            last_saved_at: ts,
            metadata_status: 'pending',
          });
          if (!res.ok) return err(call, 'create failed');
          const rows = await res.json();
          return ok(call, { bookmark_id: rows[0]?.id, status: 'created' });
        }
        case 'add_tags':
          return ok(call, { applied: 'add_tags not yet wired — see README TODO' });
        case 'set_collection': {
          const bookmarkId = str(call.input, 'bookmark_id');
          if (!bookmarkId) return err(call, 'bookmark_id is required');
          const res = await db('PATCH', `bookmarks?id=eq.${bookmarkId}&user_id=eq.${userId}`, {
            collection_id: call.input.collection_id ?? null,
            updated_at: nowIso(),
          });
          return res.ok ? ok(call, { filed: true }) : err(call, 'update failed');
        }
        case 'trash_bookmark': {
          const bookmarkId = str(call.input, 'bookmark_id');
          if (!bookmarkId) return err(call, 'bookmark_id is required');
          const res = await db('PATCH', `bookmarks?id=eq.${bookmarkId}&user_id=eq.${userId}`, {
            is_archived: true,
            updated_at: nowIso(),
          });
          return res.ok ? ok(call, { trashed: true }) : err(call, 'update failed');
        }
        default:
          return err(call, `unknown tool: ${call.name}`);
      }
    } catch (e) {
      return err(call, e instanceof Error ? e.message : 'tool error');
    }
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const userId = await resolveUserIdFromApiKey(req.headers.get('Authorization'));
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  let body: { messages?: Turn[]; decision?: Decision };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!Array.isArray(body.messages)) return json({ error: 'messages[] is required' }, 400);

  let provider: ChatProvider;
  try {
    provider = selectProvider();
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'provider not configured' }, 500);
  }

  try {
    const result = await runChatTurn({
      provider,
      system: buildSystemPrompt(),
      transcript: body.messages,
      decision: body.decision,
      execute: makeExecutor(userId),
    });
    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'chat failed' }, 500);
  }
});
