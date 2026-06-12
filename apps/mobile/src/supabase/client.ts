import { getSupabaseConfigState } from '@/supabase/config';
import type { SupabaseConfig } from '@/supabase/config';
import {
  clearSupabaseSession,
  readSupabaseSession,
  writeSupabaseSession,
} from '@/supabase/session-storage';
import type { SupabaseAuthResponse, SupabaseAuthSession } from '@/supabase/types';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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

function errorMessageFrom(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    for (const key of ['msg', 'message', 'error_description'] as const) {
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
   * Returns a usable session: the stored one while its access token is still
   * valid, a refreshed one when it is about to expire, or null when no
   * recoverable session exists. Network/server failures during refresh are
   * rethrown so callers do not silently mint a second anonymous user (which
   * would orphan the original user's data).
   */
  async restoreSession(): Promise<SupabaseAuthSession | null> {
    const stored = await readSupabaseSession();
    if (!stored) {
      return null;
    }
    if (!isSessionExpired(stored)) {
      return stored;
    }

    try {
      return await this.refreshSession(stored.refresh_token);
    } catch (error) {
      if (error instanceof SupabaseRequestError && error.status >= 400 && error.status < 500) {
        // The refresh token was rejected — this session is unrecoverable.
        await clearSupabaseSession();
        return null;
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
