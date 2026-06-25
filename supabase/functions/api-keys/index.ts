// Supabase Edge Function: api-keys
//
// Manages API keys for external AI client integration (e.g. ChatGPT Custom GPT).
// The plaintext key is generated and returned exactly once at creation time;
// only its SHA-256 hash is persisted.
//
// Routes (all require a valid Supabase JWT):
//   GET    /functions/v1/api-keys         — list the caller's keys (no plaintext)
//   POST   /functions/v1/api-keys         — create a new key; returns plaintext once
//   DELETE /functions/v1/api-keys/:id     — revoke (soft-delete) a key

import { isIssuanceEnabled } from './issuance.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Minting new keys is OFF by default. The public-API surface is "built but not
// exposed" for the stable cut (docs/api/public-api.md): a one-time revocation
// cannot hold the posture on its own because this issuer would otherwise let any
// signed-in user mint a fresh key immediately. Issuance stays denied server-side
// until the hardening track lands (ownership guard, per-key rate limit, CORS),
// at which point set ENABLE_API_KEY_ISSUANCE=true on the function. List and
// revoke remain available so existing key holders can still manage/revoke.
const API_KEY_ISSUANCE_ENABLED = isIssuanceEnabled(
  Deno.env.get('ENABLE_API_KEY_ISSUANCE'),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function resolveUserId(authorization: string | null): Promise<string | null> {
  if (!authorization) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: authorization,
      apikey: SERVICE_ROLE_KEY,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ?? null;
}

async function db(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `stash_${hex}`;
}

async function sha256(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function listKeys(userId: string): Promise<Response> {
  const res = await db(
    'GET',
    `api_keys?user_id=eq.${userId}&revoked_at=is.null&select=id,name,created_at,last_used_at&order=created_at.desc`,
  );
  if (!res.ok) return json({ error: 'Failed to fetch keys' }, 500);
  return json(await res.json());
}

async function createKey(userId: string, name: string): Promise<Response> {
  if (!API_KEY_ISSUANCE_ENABLED) {
    return json({ error: 'API key issuance is disabled' }, 403);
  }
  if (!name?.trim()) return json({ error: 'name is required' }, 400);

  const plaintext = generateKey();
  const hash = await sha256(plaintext);

  const res = await db('POST', 'api_keys', {
    user_id: userId,
    name: name.trim(),
    key_hash: hash,
  });
  if (!res.ok) return json({ error: 'Failed to create key' }, 500);

  const [row] = await res.json();
  return json({ id: row.id, name: row.name, key: plaintext, created_at: row.created_at }, 201);
}

async function revokeKey(userId: string, keyId: string): Promise<Response> {
  const res = await db(
    'PATCH',
    `api_keys?id=eq.${keyId}&user_id=eq.${userId}&revoked_at=is.null`,
    { revoked_at: new Date().toISOString() },
  );
  if (!res.ok) return json({ error: 'Failed to revoke key' }, 500);
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);

  const userId = await resolveUserId(req.headers.get('Authorization'));
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  // DELETE /functions/v1/api-keys/:id
  const pathParts = url.pathname.split('/').filter(Boolean);
  const keyId = pathParts[pathParts.length - 1];
  const isSubPath = keyId && keyId !== 'api-keys';

  if (req.method === 'GET' && !isSubPath) return listKeys(userId);
  if (req.method === 'POST' && !isSubPath) {
    const body = await req.json().catch(() => ({}));
    return createKey(userId, body.name);
  }
  if (req.method === 'DELETE' && isSubPath) return revokeKey(userId, keyId);

  return json({ error: 'Not found' }, 404);
});
