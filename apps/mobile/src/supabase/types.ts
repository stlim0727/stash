/** OAuth identity providers wired up for account sign-in / linking. */
export type OAuthProvider = 'apple' | 'google';

export interface SupabaseAuthUser {
  id: string;
  aud?: string;
  role?: string;
  email?: string | null;
  is_anonymous?: boolean;
  /** Linked identity providers, e.g. `[{ provider: 'google' }]`. */
  app_metadata?: { provider?: string; providers?: string[] };
  created_at?: string;
}

export interface SupabaseAuthSession {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
  user: SupabaseAuthUser;
}

export interface SupabaseAuthResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  user?: SupabaseAuthUser;
}
