import assert from "node:assert/strict";
import test from "node:test";

import { buildProcessingStats, type AiServerQueueSnapshot } from "./processing-status.ts";
import type { AIEnrichment, Bookmark, LocalPendingBookmark } from "./types.ts";

const NOW = "2026-08-05T00:00:00.000Z";

function bookmark(id: string, metadata_status: Bookmark["metadata_status"] = "complete"): Bookmark {
  return {
    id,
    user_id: "user-1",
    url: `https://example.com/${id}`,
    canonical_url: null,
    url_hash: null,
    title: id,
    description: null,
    notes: null,
    source_app: null,
    content_type: "url",
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    last_saved_at: NOW,
    metadata_status,
    sync_status: "synced",
  };
}

function queued(
  id: string,
  sync_status: LocalPendingBookmark["sync_status"] = "pending",
): LocalPendingBookmark {
  return {
    local_id: id,
    remote_id: null,
    operation: "create",
    payload: { id, url: `https://example.com/${id}` },
    sync_status,
    retry_count: sync_status === "failed" ? 3 : 0,
    last_error: sync_status === "failed" ? "network" : null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function serverRow(
  bookmark_id: string,
  status: AiServerQueueSnapshot["status"],
): AiServerQueueSnapshot {
  return { bookmark_id, status, attempts: 0, created_at: NOW, updated_at: NOW };
}

function stats(overrides: Partial<Parameters<typeof buildProcessingStats>[0]> = {}) {
  return buildProcessingStats({
    bookmarks: [],
    queue: [],
    enrichments: [],
    pendingAiTriggerIds: new Set(),
    aiDispatchIds: new Set(),
    aiRetryIds: new Set(),
    aiInFlightIds: new Set(),
    locallyConfirmedServerAiIds: new Set(),
    serverAiQueue: [],
    ...overrides,
  });
}

test("assigns an overlapping bookmark to exactly one highest-priority stage", () => {
  const result = stats({
    bookmarks: [bookmark("same", "pending")],
    queue: [queued("same")],
    pendingAiTriggerIds: new Set(["same"]),
    aiRetryIds: new Set(["same"]),
    serverAiQueue: [serverRow("same", "pending")],
  });

  assert.deepEqual(result.stages, { cloud: 1, metadata: 0, ai: 0, attention: 0 });
  assert.equal(result.remaining, 1);
});

test("the four exclusive stage counts always add up to remaining", () => {
  const result = stats({
    bookmarks: [bookmark("cloud", "pending"), bookmark("metadata", "pending")],
    queue: [queued("cloud"), queued("failed", "failed")],
    pendingAiTriggerIds: new Set(["ai", "cloud"]),
    serverAiQueue: [serverRow("server-ai", "processing"), serverRow("server-failed", "failed")],
  });

  assert.deepEqual(result.stages, { cloud: 1, metadata: 1, ai: 2, attention: 2 });
  assert.equal(result.remaining, 6);
  assert.equal(
    Object.values(result.stages).reduce((sum, count) => sum + count, 0),
    result.remaining,
  );
});

test("a terminal server failure is not actionable after a result already exists", () => {
  const enrichment = {
    bookmark_id: "already-done",
    degraded: false,
    degraded_reason: null,
  } as AIEnrichment;
  const result = stats({
    enrichments: [enrichment],
    serverAiQueue: [serverRow("already-done", "failed")],
  });

  assert.equal(result.stages.attention, 0);
  assert.equal(result.details.ai.serverFailed, 1);
});

test("diagnostic counters preserve raw overlapping causes", () => {
  const result = stats({
    bookmarks: [bookmark("same", "pending"), bookmark("metadata-failed", "failed")],
    queue: [queued("same")],
    pendingAiTriggerIds: new Set(["same"]),
    aiDispatchIds: new Set(["same"]),
    aiRetryIds: new Set(["same"]),
    aiInFlightIds: new Set(["same"]),
    serverAiQueue: [serverRow("same", "processing")],
  });

  assert.equal(result.remaining, 1);
  assert.deepEqual(result.details.metadata, { pending: 1, failed: 1, skipped: 0 });
  assert.deepEqual(
    {
      trigger: result.details.ai.trigger,
      dispatch: result.details.ai.dispatch,
      retry: result.details.ai.retry,
      inFlight: result.details.ai.inFlight,
      serverProcessing: result.details.ai.serverProcessing,
    },
    { trigger: 1, dispatch: 1, retry: 1, inFlight: 1, serverProcessing: 1 },
  );
});
