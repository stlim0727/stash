import { resolveAliasedId } from "@/domain/bookmark-id-swap";
import { mockUserId } from "@/domain/mock-data";
import {
  applyTagOp,
  enqueueTagOp,
  type PendingTagOp
} from "@/domain/pending-tags";
import type {
  Bookmark,
  SuggestedTag
} from "@/domain/types";
import { makeUuid } from "@/domain/uuid";
import { repository } from "@/storage/repository";
import type {
  TagData
} from "@/storage/types";
import { PENDING_TAG_OPS_KEY } from '@/store/bookmarks/constants';
import { logStorageError } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import type { SupabaseAuthSession } from "@/supabase/types";
import {
  hasRemoteIdentity
} from "@/sync/sync-bookmarks";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  serializeTagWork: <T>(work: () => Promise<T>) => Promise<T>;
  idAliases: RefObject<Map<string, string>>;
  bookmarksRef: RefObject<Bookmark[] | null>;
  authRef: RefObject<ReturnType<typeof useSupabaseAuth>>;
  tagDataRef: RefObject<TagData>;
  pendingTagOpsRef: RefObject<PendingTagOp[]>;
  tagJournalHealthyRef: RefObject<boolean>;
  tagJournalRetryAtRef: RefObject<number>;
  setTagJournalRetryAt: Dispatch<SetStateAction<number>>;
  applyTagOps: (next: PendingTagOp[], options?: { persist?: boolean; }) => Promise<boolean>;
  applyTagData: (next: TagData, options?: { persist?: boolean; }) => void;
  syncTagOps: (force?: boolean, session?: SupabaseAuthSession | null, recoverAuth?: boolean) => Promise<boolean>;
}

export function useTagCommands({
  serializeTagWork,
  idAliases,
  bookmarksRef,
  authRef,
  tagDataRef,
  pendingTagOpsRef,
  tagJournalHealthyRef,
  tagJournalRetryAtRef,
  setTagJournalRetryAt,
  applyTagOps,
  applyTagData,
  syncTagOps,
}: Dependencies) {

  // Serialize the whole local edit: compute against the latest identity and
  // journal first, then publish/persist its derived snapshot. A failed journal
  // changes neither memory nor the cache, and overlapping edits cannot clobber.
  const commitBatchTagEdit = useCallback(
    (bookmarkIds: string[], names: Array<string | SuggestedTag>, operation: "add" | "remove"): Promise<string | null> => {
      return serializeTagWork(async () => {
        if (bookmarkIds.length === 0) return null;
        const cleaned = names.map((value) => typeof value === "string"
          ? { name: value.trim(), source: "user" as const, confidence: null }
          : { name: value.name.trim(), source: "ai" as const, confidence: value.confidence }
        ).filter((value) => value.name.length > 0);
        if (cleaned.length === 0) return "Enter a tag name.";

        try {
          await ensureRepositoryReady();
        } catch (error) {
          logStorageError("tag edit bookmark", error);
          return "Could not save tags on this device. Please retry.";
        }

        const validIds: string[] = [];
        for (const rawId of bookmarkIds) {
          const resolvedId = resolveAliasedId(rawId, idAliases.current);
          if (
            hasRemoteIdentity(resolvedId) &&
            bookmarksRef.current?.some(
              (bookmark) => resolveAliasedId(bookmark.id, idAliases.current) === resolvedId,
            )
          ) {
            validIds.push(resolvedId);
          }
        }

        if (validIds.length === 0) {
          return "This bookmark cannot be tagged.";
        }

        const savedIds: string[] = [];
        try {
          await ensureRepositoryReady();
          for (const id of validIds) {
            if (await repository.getBookmark(id)) {
              savedIds.push(id);
            }
          }
        } catch (error) {
          logStorageError("tag edit bookmark", error);
          return "Could not save tags on this device. Please retry.";
        }

        if (savedIds.length === 0) {
          return "This bookmark is still being saved. Please retry.";
        }

        const userId = authRef.current.userId ?? mockUserId;
        const now = new Date().toISOString();
        let nextData = tagDataRef.current;
        let nextOps = pendingTagOpsRef.current;
        for (const bookmarkId of savedIds) {
          for (const { name, source, confidence } of cleaned) {
            const op: PendingTagOp = {
              id: makeUuid(), bookmark_id: bookmarkId, tag_name: name,
              op: operation, source, confidence, created_at: now,
            };
            nextData = applyTagOp(nextData, op, userId);
            nextOps = enqueueTagOp(nextOps, op);
          }
        }
        try {
          await repository.setMeta(PENDING_TAG_OPS_KEY, JSON.stringify(nextOps));
          tagJournalHealthyRef.current = true;
          tagJournalRetryAtRef.current = 0;
          setTagJournalRetryAt(0);
        } catch (error) {
          logStorageError("tag edit journal", error);
          return "Could not save tags on this device. Please retry.";
        }
        applyTagOps(nextOps, { persist: false });
        applyTagData(nextData);
        return null;
      });
    },
    [serializeTagWork, applyTagOps, applyTagData],
  );

  const commitTagEdit = useCallback(
    (bookmarkId: string, names: Array<string | SuggestedTag>, operation: "add" | "remove"): Promise<string | null> => {
      return commitBatchTagEdit([bookmarkId], names, operation);
    },
    [commitBatchTagEdit],
  );

  const addTagsToBookmarks = useCallback(
    async (bookmarkIds: string[], names: string[]): Promise<string | null> => {
      const error = await commitBatchTagEdit(bookmarkIds, names, "add");
      if (!error) void syncTagOps();
      return error;
    },
    [commitBatchTagEdit, syncTagOps],
  );

  const addTagsToBookmark = useCallback(
    async (bookmarkId: string, names: string[]): Promise<string | null> => {
      return addTagsToBookmarks([bookmarkId], names);
    },
    [addTagsToBookmarks],
  );

  const removeTagFromBookmark = useCallback(
    async (bookmarkId: string, tagName: string): Promise<string | null> => {
      const error = await commitTagEdit(bookmarkId, [tagName], "remove");
      if (!error) void syncTagOps();
      return error;
    },
    [commitTagEdit, syncTagOps],
  );
  return { commitTagEdit, addTagsToBookmarks, addTagsToBookmark, removeTagFromBookmark };
}
