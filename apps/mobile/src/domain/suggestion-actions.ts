import type { SuggestedFolder } from './ai-suggestions';
import type { Collection, SuggestedTag } from './types';

export interface SuggestionActionDeps {
  acceptSuggestedTags: (bookmarkId: string, suggestions: SuggestedTag[]) => Promise<string | null>;
  addTagsToBookmark: (bookmarkId: string, names: string[]) => Promise<string | null>;
  assignCollection: (bookmarkId: string, collectionId: string | null) => void;
  createCollection: (name: string) => Promise<{ collection?: Collection; error?: string }>;
  dismissFolderSuggestion: (bookmarkId: string, token: string) => void;
}

export interface AcceptSuggestionBundleInput {
  bookmarkId: string;
  aiSuggestions: SuggestedTag[];
  folder: SuggestedFolder | null;
  folderTokens: string[];
  createCollectionError: string;
  plainTagNames?: string[];
  onAcceptedFolder?: (folder: SuggestedFolder) => void;
}

export interface DismissSuggestionBundleInput {
  bookmarkId: string;
  aiSuggestionNames: string[];
  folderTokens: string[];
  markSuggestionsReviewed: (bookmarkId: string, names: string[]) => void;
  dismissFolderSuggestion: (bookmarkId: string, token: string) => void;
}

export function recordFolderSuggestionActedOn(
  bookmarkId: string,
  folderTokens: string[],
  dismissFolderSuggestion: (bookmarkId: string, token: string) => void,
): void {
  for (const token of folderTokens) {
    dismissFolderSuggestion(bookmarkId, token);
  }
}

export async function acceptSuggestionBundle(
  deps: SuggestionActionDeps,
  input: AcceptSuggestionBundleInput,
): Promise<string | null> {
  const { bookmarkId, aiSuggestions, folder, plainTagNames = [] } = input;
  if (aiSuggestions.length > 0) {
    const error = await deps.acceptSuggestedTags(bookmarkId, aiSuggestions);
    if (error) {
      return error;
    }
  }
  if (plainTagNames.length > 0) {
    const error = await deps.addTagsToBookmark(bookmarkId, plainTagNames);
    if (error) {
      return error;
    }
  }
  if (!folder) {
    return null;
  }
  if (folder.kind === 'existing') {
    deps.assignCollection(bookmarkId, folder.id);
    recordFolderSuggestionActedOn(bookmarkId, input.folderTokens, deps.dismissFolderSuggestion);
    input.onAcceptedFolder?.(folder);
    return null;
  }

  const result = await deps.createCollection(folder.name);
  if (!result.collection) {
    return result.error ?? input.createCollectionError;
  }
  deps.assignCollection(bookmarkId, result.collection.id);
  recordFolderSuggestionActedOn(bookmarkId, input.folderTokens, deps.dismissFolderSuggestion);
  input.onAcceptedFolder?.(folder);
  return null;
}

export function dismissSuggestionBundle(input: DismissSuggestionBundleInput): void {
  if (input.aiSuggestionNames.length > 0) {
    input.markSuggestionsReviewed(input.bookmarkId, input.aiSuggestionNames);
  }
  recordFolderSuggestionActedOn(
    input.bookmarkId,
    input.folderTokens,
    input.dismissFolderSuggestion,
  );
}
