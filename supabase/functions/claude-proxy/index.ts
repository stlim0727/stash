// Supabase Edge Function: claude-proxy
//
// Proxies requests to the Anthropic Messages API so browser clients can call
// Claude without exposing the Anthropic API key client-side.
// Authenticated by the same stash_ API key used for the public-api function.
//
// Route:
//   POST /functions/v1/claude-proxy   — forward a Messages API request to Anthropic

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

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
  const encoded = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function resolveUserIdFromApiKey(authorization: string | null): Promise<string | null> {
  if (!authorization?.startsWith('Bearer stash_')) return null;
  const key = authorization.slice('Bearer '.length);
  const hash = await sha256(key);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${hash}&revoked_at=is.null&select=user_id&limit=1`, {
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
    },
  });
  if (!res.ok) return null;
  const rows: Array<{ user_id: string }> = await res.json();
  return rows[0]?.user_id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const userId = await resolveUserIdFromApiKey(req.headers.get('Authorization'));
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: 'Anthropic API key not configured' }, 500);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await upstream.json();
  return json(data, upstream.status);
});
