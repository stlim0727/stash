export interface SupabaseAuthUser {
  id: string;
  aud?: string;
  role?: string;
  is_anonymous?: boolean;
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
