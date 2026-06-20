import type { DiagnosticsContext } from '@/domain/diagnostics';
import {
  attachmentObjectPath,
  summarizeReportForTester,
  type FeedbackCategory,
  type FeedbackReportRow,
  type TesterReport,
} from '@/domain/feedback';
import { createSupabaseClient } from '@/supabase/client';
import type { StashSupabaseClient } from '@/supabase/client';
import { getSupabaseConfigState } from '@/supabase/config';
import type { SupabaseAuthSession } from '@/supabase/types';

export type { FeedbackCategory } from '@/domain/feedback';

const ATTACHMENT_BUCKET = 'feedback-attachments';

/** A file the tester picked to attach (local uri from the document picker). */
export interface SelectedAttachment {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
}

/** Attachment metadata stored on the report row after a successful upload. */
export interface StoredAttachment {
  path: string;
  name: string;
  mime_type: string | null;
  size: number | null;
}

export interface SubmitReportInput {
  category: FeedbackCategory;
  message: string;
  context: DiagnosticsContext;
  app_version?: string | null;
  platform?: string | null;
  /** Files the tester chose to attach. Uploaded best-effort before insert. */
  attachments?: SelectedAttachment[];
}

export interface FeedbackApi {
  submitReport(input: SubmitReportInput): Promise<void>;
  /** The signed-in tester's own reports, newest first, projected to the
   *  tester-safe view (no internal fields). */
  listMyReports(): Promise<TesterReport[]>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A v4-ish UUID. Uses crypto.randomUUID where available, else a fallback so
 *  capture never fails just because a uuid could not be minted. */
function randomId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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

    // Mint the id up front so attachments can be namespaced under it and stored
    // on the row at insert time (testers cannot UPDATE the row afterwards).
    const reportId = randomId();
    const attachments = await this.uploadAttachments(reportId, input.attachments ?? []);

    await this.client.request('/rest/v1/feedback_reports', {
      method: 'POST',
      accessToken: this.session.access_token,
      body: {
        id: reportId,
        user_id: this.session.user.id,
        category: input.category,
        message,
        context: input.context,
        attachments,
        app_version: input.app_version?.trim() || null,
        platform: input.platform?.trim() || null,
        created_at: nowIso(),
      },
    });
  }

  async listMyReports(): Promise<TesterReport[]> {
    const rows = await this.client.request<FeedbackReportRow[]>(
      `/rest/v1/feedback_reports?user_id=eq.${this.session.user.id}&order=created_at.desc`,
      { accessToken: this.session.access_token },
    );
    return (rows ?? []).map(summarizeReportForTester);
  }

  /**
   * Upload picked files to the private attachments bucket. Best-effort: any file
   * that fails to upload is skipped (capture must never be broken by an upload
   * error), and the report still records the ones that succeeded.
   */
  private async uploadAttachments(
    reportId: string,
    files: SelectedAttachment[],
  ): Promise<StoredAttachment[]> {
    if (files.length === 0) {
      return [];
    }

    const config = getSupabaseConfigState();
    if (config.status === 'missing') {
      return [];
    }

    // Lazily load expo-file-system's legacy upload API so module load stays free
    // of native imports (keeps the pure Node test lane and SSR happy). The
    // binary file upload helpers live under the `/legacy` entrypoint in SDK 56.
    let uploadAsync: typeof import('expo-file-system/legacy').uploadAsync;
    let FileSystemUploadType: typeof import('expo-file-system/legacy').FileSystemUploadType;
    try {
      const fs = await import('expo-file-system/legacy');
      uploadAsync = fs.uploadAsync;
      FileSystemUploadType = fs.FileSystemUploadType;
    } catch {
      return [];
    }

    const stored: StoredAttachment[] = [];
    let index = 0;
    for (const file of files) {
      const path = attachmentObjectPath({
        userId: this.session.user.id,
        reportId,
        index,
        filename: file.name,
      });
      index += 1;
      try {
        const result = await uploadAsync(
          `${config.config.url}/storage/v1/object/${ATTACHMENT_BUCKET}/${path}`,
          file.uri,
          {
            httpMethod: 'POST',
            uploadType: FileSystemUploadType.BINARY_CONTENT,
            headers: {
              apikey: config.config.anonKey,
              Authorization: `Bearer ${this.session.access_token}`,
              'Content-Type': file.mimeType || 'application/octet-stream',
              'x-upsert': 'true',
            },
          },
        );
        if (result.status >= 200 && result.status < 300) {
          stored.push({
            path,
            name: file.name,
            mime_type: file.mimeType ?? null,
            size: file.size ?? null,
          });
        }
      } catch {
        // Skip this file; the report is still worth submitting without it.
      }
    }
    return stored;
  }
}

export function createFeedbackApi(session: SupabaseAuthSession): FeedbackApi {
  return new SupabaseFeedbackApi(session);
}
