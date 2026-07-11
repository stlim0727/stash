import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptSuggestionBundle,
  dismissSuggestionBundle,
  recordFolderSuggestionActedOn,
} from './suggestion-actions.ts';
import type { SuggestedFolder } from './ai-suggestions.ts';
import type { Collection, SuggestedTag } from './types.ts';

const tag: SuggestedTag = { name: 'Design', confidence: 0.91 };
const existingFolder: SuggestedFolder = {
  kind: 'existing',
  id: 'collection-target',
  name: 'Reading',
  from: { id: 'collection-old', name: 'Old' },
};
const createdCollection: Collection = {
  id: 'collection-new',
  user_id: 'user-test',
  name: 'Ideas',
  description: null,
  created_at: '2026-07-06T00:00:00.000Z',
  updated_at: '2026-07-06T00:00:00.000Z',
};

test('acceptSuggestionBundle applies tags before filing into an existing folder', async () => {
  const calls: string[] = [];
  const acceptedFolders: string[] = [];
  const error = await acceptSuggestionBundle(
    {
      acceptSuggestedTags: async (bookmarkId, suggestions) => {
        calls.push(`ai:${bookmarkId}:${suggestions.map((item) => item.name).join(',')}`);
        return null;
      },
      addTagsToBookmark: async (bookmarkId, names) => {
        calls.push(`plain:${bookmarkId}:${names.join(',')}`);
        return null;
      },
      assignCollection: (bookmarkId, collectionId) => {
        calls.push(`assign:${bookmarkId}:${collectionId}`);
      },
      createCollection: async () => {
        throw new Error('should not create');
      },
      dismissFolderSuggestion: (bookmarkId, tokens) => {
        const list = Array.isArray(tokens) ? tokens : [tokens];
        for (const token of list) {
          calls.push(`dismiss-folder:${bookmarkId}:${token}`);
        }
      },
    },
    {
      bookmarkId: 'bookmark-1',
      aiSuggestions: [tag],
      plainTagNames: ['hashtag'],
      folder: existingFolder,
      folderTokens: ['id:collection-target', 'name:reading'],
      createCollectionError: 'Could not create collection.',
      onAcceptedFolder: (folder) => acceptedFolders.push(folder.name),
    },
  );

  assert.equal(error, null);
  assert.deepEqual(calls, [
    'ai:bookmark-1:Design',
    'plain:bookmark-1:hashtag',
    'assign:bookmark-1:collection-target',
    'dismiss-folder:bookmark-1:id:collection-target',
    'dismiss-folder:bookmark-1:name:reading',
  ]);
  assert.deepEqual(acceptedFolders, ['Reading']);
});

test('acceptSuggestionBundle stops before folder work when tag acceptance fails', async () => {
  const calls: string[] = [];
  const error = await acceptSuggestionBundle(
    {
      acceptSuggestedTags: async () => {
        calls.push('ai');
        return 'No network.';
      },
      addTagsToBookmark: async () => {
        calls.push('plain');
        return null;
      },
      assignCollection: () => calls.push('assign'),
      createCollection: async () => {
        calls.push('create');
        return { collection: createdCollection };
      },
      dismissFolderSuggestion: () => calls.push('dismiss-folder'),
    },
    {
      bookmarkId: 'bookmark-1',
      aiSuggestions: [tag],
      plainTagNames: ['hashtag'],
      folder: { kind: 'create', name: 'Ideas', from: null },
      folderTokens: ['name:ideas'],
      createCollectionError: 'Could not create collection.',
    },
  );

  assert.equal(error, 'No network.');
  assert.deepEqual(calls, ['ai']);
});

test('acceptSuggestionBundle creates a proposed folder before assigning it', async () => {
  const calls: string[] = [];
  const error = await acceptSuggestionBundle(
    {
      acceptSuggestedTags: async () => null,
      addTagsToBookmark: async () => null,
      assignCollection: (bookmarkId, collectionId) => {
        calls.push(`assign:${bookmarkId}:${collectionId}`);
      },
      createCollection: async (name) => {
        calls.push(`create:${name}`);
        return { collection: createdCollection };
      },
      dismissFolderSuggestion: (bookmarkId, tokens) => {
        const list = Array.isArray(tokens) ? tokens : [tokens];
        for (const token of list) {
          calls.push(`dismiss-folder:${bookmarkId}:${token}`);
        }
      },
    },
    {
      bookmarkId: 'bookmark-1',
      aiSuggestions: [],
      folder: { kind: 'create', name: 'Ideas', from: null },
      folderTokens: ['name:ideas'],
      createCollectionError: 'Could not create collection.',
    },
  );

  assert.equal(error, null);
  assert.deepEqual(calls, [
    'create:Ideas',
    'assign:bookmark-1:collection-new',
    'dismiss-folder:bookmark-1:name:ideas',
  ]);
});

test('dismissSuggestionBundle marks tag names reviewed and records all folder tokens', () => {
  const calls: string[] = [];
  dismissSuggestionBundle({
    bookmarkId: 'bookmark-1',
    aiSuggestionNames: ['Design', 'Research'],
    folderTokens: ['id:collection-target', 'name:reading'],
    markSuggestionsReviewed: (bookmarkId, names) => {
      calls.push(`reviewed:${bookmarkId}:${names.join(',')}`);
    },
    dismissFolderSuggestion: (bookmarkId, tokens) => {
      const list = Array.isArray(tokens) ? tokens : [tokens];
      for (const token of list) {
        calls.push(`dismiss-folder:${bookmarkId}:${token}`);
      }
    },
  });

  assert.deepEqual(calls, [
    'reviewed:bookmark-1:Design,Research',
    'dismiss-folder:bookmark-1:id:collection-target',
    'dismiss-folder:bookmark-1:name:reading',
  ]);
});

test('recordFolderSuggestionActedOn records each stable folder token', () => {
  const calls: string[] = [];
  recordFolderSuggestionActedOn('bookmark-1', ['a', 'b'], (bookmarkId, tokens) => {
    const list = Array.isArray(tokens) ? tokens : [tokens];
    for (const token of list) {
      calls.push(`${bookmarkId}:${token}`);
    }
  });

  assert.deepEqual(calls, ['bookmark-1:a', 'bookmark-1:b']);
});
