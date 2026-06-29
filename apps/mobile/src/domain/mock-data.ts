/**
 * Local/offline owner id used for rows created before an anonymous Supabase
 * session exists. Saves are local-first, so a bookmark can be created while
 * `auth.userId` is still null; the real user id is adopted on sync. Kept as a
 * stable constant (not sample content) — the app no longer seeds any sample
 * bookmarks/tags/collections; a fresh install starts empty.
 */
export const mockUserId = 'mock-user-1';
