import type { AIEnrichment, Bookmark, BookmarkTag, Collection, Tag } from '@/domain/types';

/**
 * Representative sample data used until durable local persistence
 * (Milestone 4) and Supabase sync (Milestones 5-7) exist.
 */

export const mockUserId = 'mock-user-1';

// Seeded bookmarks that represent already-synced cloud rows use real-looking
// UUIDs, so the app treats them as having a remote identity: tags and AI
// suggestions are editable, with no "once this bookmark has synced" gating
// (see hasRemoteIdentity in sync/sync-bookmarks). Pending/never-synced samples
// keep readable non-UUID IDs on purpose, to exercise the not-yet-synced state.
const syncedLocalFirstId = '0a1b2c3d-4e5f-4a6b-8c7d-000000000001';
const syncedExpoRouterId = '0a1b2c3d-4e5f-4a6b-8c7d-000000000002';

export const mockCollections: Collection[] = [
  {
    id: 'collection-research',
    user_id: mockUserId,
    name: 'Research',
    description: 'Long-form reading for product research.',
    created_at: '2026-06-01T09:00:00.000Z',
    updated_at: '2026-06-01T09:00:00.000Z',
  },
];

export const mockTags: Tag[] = [
  {
    id: 'tag-design',
    user_id: mockUserId,
    name: 'design',
    slug: 'design',
    source: 'user',
    created_at: '2026-06-01T09:05:00.000Z',
  },
  {
    id: 'tag-read-later',
    user_id: mockUserId,
    name: 'read-later',
    slug: 'read-later',
    source: 'user',
    created_at: '2026-06-01T09:06:00.000Z',
  },
  {
    id: 'tag-local-first',
    user_id: mockUserId,
    name: 'local-first',
    slug: 'local-first',
    source: 'ai',
    created_at: '2026-06-02T18:30:00.000Z',
  },
];

export const mockBookmarks: Bookmark[] = [
  {
    id: syncedLocalFirstId,
    user_id: mockUserId,
    url: 'https://www.inkandswitch.com/local-first/',
    canonical_url: 'https://www.inkandswitch.com/local-first/',
    url_hash: 'https://www.inkandswitch.com/local-first/',
    title: 'Local-first software',
    description: 'You own your data, in spite of the cloud.',
    notes: 'Reference for the offline queue design.',
    source_app: 'Safari',
    content_type: 'article',
    preview_image_url: null,
    favicon_url: 'https://www.inkandswitch.com/favicon.ico',
    site_name: 'Ink & Switch',
    collection_id: 'collection-research',
    is_archived: false,
    created_at: '2026-06-02T18:24:00.000Z',
    updated_at: '2026-06-02T18:30:00.000Z',
    last_saved_at: '2026-06-02T18:24:00.000Z',
    metadata_status: 'complete',
    sync_status: 'synced',
  },
  {
    id: 'bookmark-raindrop',
    user_id: mockUserId,
    url: 'https://raindrop.io',
    canonical_url: 'https://raindrop.io/',
    url_hash: 'https://raindrop.io/',
    title: 'Raindrop.io — all-in-one bookmark manager',
    description: null,
    notes: 'Competitor reference. Stash should stay simpler and inbox-first.',
    source_app: 'Chrome',
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    created_at: '2026-06-05T11:12:00.000Z',
    updated_at: '2026-06-05T11:12:00.000Z',
    last_saved_at: '2026-06-05T11:12:00.000Z',
    metadata_status: 'pending',
    sync_status: 'pending',
  },
  {
    id: syncedExpoRouterId,
    user_id: mockUserId,
    url: 'https://docs.expo.dev/router/introduction/',
    canonical_url: 'https://docs.expo.dev/router/introduction/',
    url_hash: 'https://docs.expo.dev/router/introduction/',
    title: 'Introduction to Expo Router',
    description: 'File-based routing for React Native and web.',
    notes: null,
    source_app: null,
    content_type: 'article',
    preview_image_url: null,
    favicon_url: 'https://docs.expo.dev/favicon.ico',
    site_name: 'Expo Documentation',
    collection_id: null,
    is_archived: true,
    created_at: '2026-05-28T08:45:00.000Z',
    updated_at: '2026-06-03T10:00:00.000Z',
    last_saved_at: '2026-05-28T08:45:00.000Z',
    metadata_status: 'complete',
    sync_status: 'synced',
  },
];

export const mockBookmarkTags: BookmarkTag[] = [
  {
    bookmark_id: syncedLocalFirstId,
    tag_id: 'tag-read-later',
    source: 'user',
    confidence: null,
    created_at: '2026-06-02T18:25:00.000Z',
  },
  {
    bookmark_id: syncedLocalFirstId,
    tag_id: 'tag-local-first',
    source: 'ai',
    confidence: 0.93,
    created_at: '2026-06-02T18:30:00.000Z',
  },
  {
    bookmark_id: 'bookmark-raindrop',
    tag_id: 'tag-design',
    source: 'user',
    confidence: null,
    created_at: '2026-06-05T11:13:00.000Z',
  },
];

export const mockEnrichments: AIEnrichment[] = [
  {
    id: 'enrichment-local-first',
    bookmark_id: syncedLocalFirstId,
    user_id: mockUserId,
    summary:
      'Argues for software that keeps data on-device while still supporting collaboration and sync.',
    topics: ['local-first', 'sync', 'software architecture'],
    suggested_tags: [{ name: 'local-first', confidence: 0.93 }],
    suggested_collection_id: 'collection-research',
    suggested_collection_name: null,
    model: 'future-ai-pipeline',
    status: 'complete',
    confidence: 0.9,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-02T18:30:00.000Z',
    updated_at: '2026-06-02T18:30:00.000Z',
  },
];
