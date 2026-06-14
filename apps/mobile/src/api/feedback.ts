import type { DiagnosticsContext } from '@/domain/diagnostics';
import { createSupabaseClient } from '@/supabase/client';
import type { StashSupabaseClient } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

export type FeedbackCategory = 'bug' | 'idea' | 'other';

export interface SubmitReportInput {
  category: FeedbackCategory;
  message: string;
  context: DiagnosticsContext;
  app_version?: string | null;
  platform?: string | null;
}

export interface FeedbackApi {
  submitReport(input: SubmitReportInput): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SupabaseFeedbackApi implements FeedbackApi {
  constructor(
    private readonly session: SupabaseAuthSession,
    private readonly client: StashSupabaseClient = createSupabaseClient(),
  ) {}

  async submitReport(input: SubmitReportInput): Promise<void> {
    const message = input.message.trim();
    if (!message) {
      throw new Error('A description is required to submit a report.');
    }

    await this.client.request('/rest/v1/feedback_reports', {
      method: 'POST',
      accessToken: this.session.access_token,
      body: {
        user_id: this.session.user.id,
        category: input.category,
        message,
        context: input.context,
        app_version: input.app_version?.trim() || null,
        platform: input.platform?.trim() || null,
        created_at: nowIso(),
      },
    });
  }
}

export function createFeedbackApi(session: SupabaseAuthSession): FeedbackApi {
  return new SupabaseFeedbackApi(session);
}
