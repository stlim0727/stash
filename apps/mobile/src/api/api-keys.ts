import { createSupabaseClient } from '@/supabase/client';
import type { StashSupabaseClient } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

export interface ApiKey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface CreatedApiKey extends ApiKey {
  key: string;
}

export class ApiKeysApi {
  constructor(
    private readonly session: SupabaseAuthSession,
    private readonly client: StashSupabaseClient = createSupabaseClient(),
  ) {}

  async list(): Promise<ApiKey[]> {
    return this.client.request<ApiKey[]>('/functions/v1/api-keys', {
      method: 'GET',
      accessToken: this.session.access_token,
    });
  }

  async create(name: string): Promise<CreatedApiKey> {
    return this.client.request<CreatedApiKey>('/functions/v1/api-keys', {
      method: 'POST',
      accessToken: this.session.access_token,
      body: { name },
    });
  }

  async revoke(id: string): Promise<void> {
    await this.client.request<null>(`/functions/v1/api-keys/${id}`, {
      method: 'DELETE',
      accessToken: this.session.access_token,
    });
  }
}

export function createApiKeysApi(session: SupabaseAuthSession): ApiKeysApi {
  return new ApiKeysApi(session);
}
