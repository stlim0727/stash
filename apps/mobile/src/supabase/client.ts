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
    expires_at: response.expires_at,
    user: response.user,
  };
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  return JSON.parse(text);
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
      const message =
        typeof payload === 'object' && payload !== null && 'msg' in payload
          ? String(payload.msg)
          : `Supabase request failed with HTTP ${response.status}`;
      throw new SupabaseRequestError(message, response.status);
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

  async restoreSession(): Promise<SupabaseAuthSession | null> {
    return readSupabaseSession();
  }

  async clearSession(): Promise<void> {
    await clearSupabaseSession();
  }
}

export function createSupabaseClient(): StashSupabaseClient {
  return new StashSupabaseClient();
}
