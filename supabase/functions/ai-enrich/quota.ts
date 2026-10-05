export interface RateLimitVerdict {
  allowed: boolean;
  reason?: string;
  retry_after?: number;
}

/** A malformed response is an unavailable limiter, never permission to spend. */
export function parseQuotaVerdict(value: unknown): RateLimitVerdict | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.allowed !== 'boolean') return null;
  return {
    allowed: row.allowed,
    reason: typeof row.reason === 'string' ? row.reason : undefined,
    retry_after: typeof row.retry_after === 'number' && Number.isFinite(row.retry_after)
      ? Math.max(1, Math.min(86_400, Math.floor(row.retry_after)))
      : undefined,
  };
}
