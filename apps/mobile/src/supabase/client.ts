import { getSupabaseConfigState } from '@/supabase/config';
import type { SupabaseConfig } from '@/supabase/config';
import {
  clearSupabaseSession,
  hadRealSupabaseSession,
  readSupabaseSession,
  writeSupabaseSession,
} from '@/supabase/session-storage';
import { buildAuthorizeQuery } from '@/supabase/oauth';
import type {
  OAuthProvider,
  SupabaseAuthResponse,
  SupabaseAuthSession,
  SupabaseAuthUser,
} from '@/supabase/types';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  accessToken?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class SupabaseConfigurationError extends Error {
  constructor(message = 'Supabase is not configured. Add Expo public Supabase env values.') {
    super(message);
    this.name = 'SupabaseConfigurationError';
  }
}

export class SupabaseRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'SupabaseRequestError';
  }
}

function requireConfig(): SupabaseConfig {
  const state = getSupabaseConfigState();
  if (state.status === 'missing') {
    throw new SupabaseConfigurationError();
  }

  return state.config;
}

function toSession(response: SupabaseAuthResponse): SupabaseAuthSession {
  if (
    !response.access_token ||
    !response.refresh_token ||
    !response.token_type ||
    !response.expires_in ||
    !response.user
  ) {
    throw new SupabaseRequestError(
      'Supabase auth response did not include a complete session.',
      200,
    );
  }

  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token,
    token_type: response.token_type,
    expires_in: response.expires_in,
    // Always know when the token dies so restoreSession can refresh in time.
    expires_at: response.expires_at ?? Math.floor(Date.now() / 1000) + response.expires_in,
    user: response.user,
  };
}

/**
 * Outcome of restoring a persisted session:
 *  - `active`: a usable session (the stored one, or a freshly refreshed one).
 *  - `none`: no stored session at all (fresh install / signed out) — mint anew.
 *  - `expired`: a stored session's refresh token was rejected. `wasAnonymous`
 *    lets the caller decide what to do: an anonymous session is safely replaced
 *    by a fresh one (its data carries over on the next sync), but a REAL account
 *    must NOT be silently swapped for an anonymous user — that logs the user out
 *    AND makes the sync account-transition drop their local cache. The caller
 *    surfaces a re-sign-in prompt for that case instead of minting.
 */
export type SessionRestoreResult =
  | { outcome: 'active'; session: SupabaseAuthSession }
  | { outcome: 'none' }
  | { outcome: 'expired'; wasAnonymous: boolean };

const EXPIRY_MARGIN_SECONDS = 60;

function isSessionExpired(session: SupabaseAuthSession): boolean {
  if (!session.expires_at) {
    return true;
  }
  return session.expires_at <= Math.floor(Date.now() / 1000) + EXPIRY_MARGIN_SECONDS;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    // Proxies and gateways can answer with plain text or HTML; surface it
    // as the error message instead of crashing on invalid JSON.
    return text;
  }
}

export function errorMessageFrom(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    // GoTrue uses msg/error_description; PostgREST uses message; our edge
    // functions (ai-enrich, feedback-bridge) return { error: '…' }. Without
    // `error` here every edge-function failure collapsed to the opaque
    // "…HTTP <status>" fallback, hiding the real reason from the UI and the
    // diagnostics buffer (e.g. an ai-enrich save failure read as a bare 400).
    // error_description stays ahead of error so GoTrue's human-readable text
    // wins over its machine code (`{ error: 'invalid_grant', error_description }`).
    for (const key of ['msg', 'message', 'error_description', 'error'] as const) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) {
        return value;
      }
    }
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim().slice(0, 200);
  }
  return `Supabase request failed with HTTP ${status}`;
}

export class StashSupabaseClient {
  constructor(private readonly config: SupabaseConfig = requireConfig()) {}

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await fetch(`${this.config.url}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        apikey: this.config.anonKey,
        Authorization: `Bearer ${options.accessToken ?? this.config.anonKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new SupabaseRequestError(errorMessageFrom(payload, response.status), response.status);
    }

    return payload as T;
  }

  async signInAnonymously(): Promise<SupabaseAuthSession> {
    const payload = (await this.request('/auth/v1/signup', {
      method: 'POST',
      body: {},
    })) as SupabaseAuthResponse;
    const session = toSession(payload);
    await writeSupabaseSession(session);
    return session;
  }

  /**
   * Ask GoTrue for a hosted authorize URL while authenticated as the current
   * (anonymous) user, so the OAuth identity is LINKED to that user instead of
   * creating a separate account — existing bookmarks carry over. Returns the
   * URL to open in the browser. Requires manual linking enabled on the project.
   */
  async requestOAuthLinkUrl(params: {
    provider: OAuthProvider;
    redirectTo: string;
    codeChallenge: string;
    accessToken: string;
  }): Promise<string> {
    const query = buildAuthorizeQuery({
      provider: params.provider,
      redirectTo: params.redirectTo,
      codeChallenge: params.codeChallenge,
      skipHttpRedirect: true,
    });
    const payload = await this.request<{ url?: string }>(`/auth/v1/authorize?${query}`, {
      accessToken: params.accessToken,
    });
    if (!payload?.url) {
      throw new SupabaseRequestError('Supabase did not return an OAuth URL for linking.', 200);
    }
    return payload.url;
  }

  /**
   * Trade a PKCE authorization code (with its verifier) for a real session and
   * persist it. Used to complete an OAuth sign-in after the browser redirect.
   */
  async exchangeCodeForSession(
    authCode: string,
    codeVerifier: string,
  ): Promise<SupabaseAuthSession> {
    const payload = (await this.request('/auth/v1/token?grant_type=pkce', {
      method: 'POST',
      body: { auth_code: authCode, code_verifier: codeVerifier },
    })) as SupabaseAuthResponse;
    const session = toSession(payload);
    await writeSupabaseSession(session);
    return session;
  }

  /**
   * Merge `data` into the authenticated user's GoTrue `user_metadata` and return
   * the updated user. GoTrue's user-update route is `PUT /user` (PATCH is only
   * enabled at the CORS layer, not routed — a PATCH is rejected), so we must use
   * PUT, the same verb supabase-js's `updateUser` issues. GoTrue does a shallow
   * top-level merge of `data`, so only the keys we send are touched — unrelated
   * OAuth profile fields (full_name, avatar_url) are preserved. Works for
   * anonymous users too (they update their own record).
   */
  async updateUserMetadata(
    accessToken: string,
    data: Record<string, unknown>,
  ): Promise<SupabaseAuthUser> {
    return this.request<SupabaseAuthUser>('/auth/v1/user', {
      method: 'PUT',
      accessToken,
      body: { data },
    });
  }

  /**
   * Persist a session to local secure storage without going through the network.
   * Used to write back an in-memory mutation (e.g. a freshly stamped
   * `user_metadata`) so a cold restart restores the updated copy instead of the
   * stale one — otherwise the change-only guards re-run the same write each launch.
   */
  async persistSession(session: SupabaseAuthSession): Promise<void> {
    await writeSupabaseSession(session);
  }

  /** Revoke the current session server-side (best-effort) and clear it locally. */
  async signOut(accessToken: string): Promise<void> {
    try {
      await this.request('/auth/v1/logout', { method: 'POST', accessToken, body: {} });
    } catch {
      // Best-effort: the local session is cleared regardless so the user is
      // signed out on this device even if the network call fails.
    }
    await clearSupabaseSession();
  }

  async refreshSession(refreshToken: string): Promise<SupabaseAuthSession> {
    const payload = (await this.request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    })) as SupabaseAuthResponse;
    const session = toSession(payload);
    await writeSupabaseSession(session);
    return session;
  }

  /**
   * Returns a usable session (the stored one while its access token is still
   * valid, or a refreshed one when it is about to expire), or reports why none
   * is available — see {@link SessionRestoreResult}. Network/server failures
   * during refresh are rethrown so callers do not silently mint a second
   * anonymous user (which would orphan the original user's data).
   *
   * Pass `forceRefresh` to refresh even when the stored token still looks valid
   * — useful after the server rejects a token we believed current (clock skew
   * or rotation), so a retry uses a genuinely fresh one.
   */
  async restoreSession(forceRefresh = false): Promise<SessionRestoreResult> {
    const stored = await readSupabaseSession();
    if (!stored) {
      // A null read is ambiguous: either a genuine first run (no session was
      // ever stored) OR a real account whose persisted session was unreadable
      // this launch — a missing/torn secure-store chunk or a transient
      // Keychain/Keystore error. Minting an anonymous user for the LATTER is the
      // data-loss trigger: it silently signs the user out and makes the sync
      // account-transition treat it as a switch. Consult the standalone
      // real-account breadcrumb: if a real account was ever durably persisted
      // here, surface an expired real session (→ `session_expired`, local data
      // preserved, re-sign-in prompt) instead of `none` (which mints anon).
      if (await hadRealSupabaseSession()) {
        return { outcome: 'expired', wasAnonymous: false };
      }
      return { outcome: 'none' };
    }
    if (!forceRefresh && !isSessionExpired(stored)) {
      return { outcome: 'active', session: stored };
    }

    const wasAnonymous = stored.user.is_anonymous !== false;
    try {
      const session = await this.refreshSession(stored.refresh_token);
      return { outcome: 'active', session };
    } catch (error) {
      if (error instanceof SupabaseRequestError && error.status >= 400 && error.status < 500) {
        // The refresh token was rejected — this session is unrecoverable.
        // Clear ONLY an anonymous session: a fresh anonymous user is minted next
        // and its data carries over safely. A REAL account's dead session is
        // deliberately LEFT in place so the auth provider keeps re-deriving the
        // `session_expired` state (and never silently mints an anonymous
        // replacement, which would drop the local cache) until the user signs
        // back in — at which point the OAuth flow overwrites it.
        if (wasAnonymous) {
          await clearSupabaseSession();
        }
        return { outcome: 'expired', wasAnonymous };
      }
      throw error;
    }
  }

  async clearSession(): Promise<void> {
    await clearSupabaseSession();
  }
}

export function createSupabaseClient(): StashSupabaseClient {
  return new StashSupabaseClient();
}
