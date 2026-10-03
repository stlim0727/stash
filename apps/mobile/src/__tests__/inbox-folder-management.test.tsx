import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const mockAuthSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-test' },
};

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'anonymous',
    session: mockAuthSession,
    userId: 'user-test',
    message: null,
    ensureAnonymousSession: async () => mockAuthSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  return {
    createBookmarkApi: () => ({
      requestEnrichment: async () => null,
      addTags: async () => [],
      bulkAttachTagsAndCollections: async (items: Array<{ bookmark_id: string }>) =>
        items.map((item) => ({
          bookmark_id: item.bookmark_id,
          tags: [],
          collection: null,
          collection_attached: false,
          bookmark_updated_at: null,
        })),
      createBookmark: async () => ({ bookmark_id: 'unused' }),
      listBookmarksUpdatedSince: empty,
      listBookmarkIds: empty,
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
      createCollection: async (name: string) => ({
        id: 'new-col-1',
        user_id: 'user-test',
        name,
        description: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      updateCollection: async (id: string, updates: any) => ({
        id,
        user_id: 'user-test',
        name: updates.name,
        description: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      deleteCollection: async () => ({ success: true }),
      deleteCollections: async () => ({ success: true }),
      mergeCollections: async () => ({ success: true }),
    }),
  };
});

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({
      push: mockPush,
      navigate: jest.fn(),
      replace: jest.fn(),
      back: jest.fn(),
      setParams: jest.fn(),
    }),
    useLocalSearchParams: () => mockParams,
    usePathname: () => '/',
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
  };
});

import InboxScreen from '@/app/index';
import type { Collection } from '@/domain/types';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

function makeCollection(id: string, name: string): Collection {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, description: null, created_at: now, updated_at: now };
}

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

async function renderInbox() {
  return await render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <InboxScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockParams = {};
  mockPush.mockReset();
});

describe('Folder View & Collection Management', () => {
  test('switches to folder view and supports selecting collections', async () => {
    const colA = makeCollection('col-a', 'Engineering');
    const colB = makeCollection('col-b', 'Design');

    fakeRepo.__reset(
      [
        makeStoredBookmark({
          id: '7e64cf1e-0000-4000-8000-000000000001',
          title: 'React Native Docs',
          collection_id: 'col-a',
        }),
      ],
      { tags: [], bookmarkTags: [], collections: [colA, colB] },
    );

    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('React Native Docs')).toBeTruthy());

    // Switch to Folder (Collections) view via View Options
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-view-options'));
    });

    await waitFor(() => expect(screen.getByTestId('inbox-view-folder')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-view-folder'));
    });

    // In folder view: Collections heading and Select button appear
    await waitFor(() => {
      expect(screen.getByTestId('inbox-collections-heading')).toBeTruthy();
      expect(screen.getByTestId('folder-select-button')).toBeTruthy();
      expect(screen.getByText('Engineering')).toBeTruthy();
      expect(screen.getByText('Design')).toBeTruthy();
    });

    // Enter folder selection mode via "Select" button
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-select-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('folder-selection-count')).toBeTruthy();
      expect(screen.getByText('0 collections selected')).toBeTruthy();
      expect(screen.getByTestId('folder-bulk-action-bar')).toBeTruthy();
    });

    // Tap Engineering tile to select it
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-tile-__folder-c:col-a'));
    });
    expect(screen.getByText('1 collection selected')).toBeTruthy();
    // With 1 item selected, Rename button is visible
    expect(screen.getByTestId('folder-bulk-rename')).toBeTruthy();

    // Tap Design tile to select it too
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-tile-__folder-c:col-b'));
    });
    expect(screen.getByText('2 collections selected')).toBeTruthy();
    // With 2 items selected, Merge is enabled and Rename is hidden
    expect(screen.queryByTestId('folder-bulk-rename')).toBeNull();
    expect(screen.getByTestId('folder-bulk-merge')).toBeTruthy();

    // Select all / Deselect all
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-selection-select-all'));
    });
    expect(screen.getByText('0 collections selected')).toBeTruthy();

    // Close selection mode
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-selection-close'));
    });
    expect(screen.queryByTestId('folder-bulk-action-bar')).toBeNull();
  });

  test('opens collection options sheet via tile more button and triggers rename dialog', async () => {
    const colA = makeCollection('col-a', 'Research');

    fakeRepo.__reset(
      [
        makeStoredBookmark({
          id: '7e64cf1e-0000-4000-8000-000000000001',
          title: 'Paper',
          collection_id: 'col-a',
        }),
      ],
      { tags: [], bookmarkTags: [], collections: [colA] },
    );

    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('Paper')).toBeTruthy());

    // Switch to folder view
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-view-options'));
    });
    await waitFor(() => expect(screen.getByTestId('inbox-view-folder')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-view-folder'));
    });

    await waitFor(() => expect(screen.getByTestId('folder-more-__folder-c:col-a')).toBeTruthy());

    // Tap more options on the folder tile
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-more-__folder-c:col-a'));
    });

    // ActionSheet should show Rename collection option
    await waitFor(() => expect(screen.getByText('Rename collection')).toBeTruthy());

    // Tap Rename collection
    await act(async () => {
      fireEvent.press(screen.getByText('Rename collection'));
    });

    // Rename dialog appears
    await waitFor(() => expect(screen.getByTestId('rename-collection-input')).toBeTruthy());
    expect(screen.getByTestId('rename-collection-input').props.value).toBe('Research');
  });

  test('shows collection options button in active filter bar when viewing a collection', async () => {
    const colA = makeCollection('col-a', 'Reading List');

    fakeRepo.__reset(
      [
        makeStoredBookmark({
          id: '7e64cf1e-0000-4000-8000-000000000001',
          title: 'Article',
          collection_id: 'col-a',
        }),
      ],
      { tags: [], bookmarkTags: [], collections: [colA] },
    );

    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('Article')).toBeTruthy());

    // Switch to folder view
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-view-options'));
    });
    await waitFor(() => expect(screen.getByTestId('inbox-view-folder')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-view-folder'));
    });

    // Tap on the Reading List collection tile to filter by it
    await waitFor(() => expect(screen.getByTestId('folder-tile-__folder-c:col-a')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-tile-__folder-c:col-a'));
    });

    // Filter bar should appear
    await waitFor(() => expect(screen.getByTestId('inbox-filter-bar')).toBeTruthy());

    // Options button should be present in the filter bar
    expect(screen.getByTestId('inbox-filter-collection-menu')).toBeTruthy();

    // Tap options button in filter bar
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-filter-collection-menu'));
    });

    // Sheet appears with collection options
    await waitFor(() => {
      expect(screen.getByText('Delete collection')).toBeTruthy();
      expect(screen.getByText('Rename collection')).toBeTruthy();
    });
  });

  test('restricts merge target choices strictly to selected collections in bulk merge dialog', async () => {
    const colA = makeCollection('col-a', 'Engineering');
    const colB = makeCollection('col-b', 'Design');
    const colC = makeCollection('col-c', 'Marketing');

    fakeRepo.__reset(
      [
        makeStoredBookmark({
          id: '7e64cf1e-0000-4000-8000-000000000001',
          title: 'React Native Docs',
          collection_id: 'col-a',
        }),
      ],
      { tags: [], bookmarkTags: [], collections: [colA, colB, colC] },
    );

    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('React Native Docs')).toBeTruthy());

    // Switch to folder view
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-view-options'));
    });
    await waitFor(() => expect(screen.getByTestId('inbox-view-folder')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-view-folder'));
    });

    // Enter selection mode
    await waitFor(() => expect(screen.getByTestId('folder-select-button')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-select-button'));
    });

    // Select Engineering (col-a) and Design (col-b), leave Marketing (col-c) unselected
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-tile-__folder-c:col-a'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('folder-tile-__folder-c:col-b'));
    });

    expect(screen.getByText('2 collections selected')).toBeTruthy();
    const mergeBtn = screen.getByTestId('folder-bulk-merge');
    expect(mergeBtn).toBeTruthy();

    // Trigger merge dialog from bulk action bar
    await act(async () => {
      fireEvent.press(mergeBtn);
    });

    // MergeCollectionsDialog is visible
    await waitFor(() => {
      expect(screen.getByTestId('merge-target-col-a')).toBeTruthy();
      expect(screen.getByTestId('merge-target-col-b')).toBeTruthy();
    });

    // Marketing (col-c) was NOT selected, so it MUST NOT be an available target
    expect(screen.queryByTestId('merge-target-col-c')).toBeNull();

    // Multi-source prompt is present, initially no target is selected and submit is disabled
    expect(screen.getByText('Which collection should hold everything?')).toBeTruthy();
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByTestId('merge-collections-notice')).toBeNull();

    // Select Design as target
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-target-col-b'));
    });

    // Now submit is enabled and notice is present
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('merge-collections-notice')).toBeTruthy();

    // Submit merge
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-collections-submit'));
    });

    // Dialog closes and selection mode exits
    await waitFor(() => {
      expect(screen.queryByTestId('folder-bulk-action-bar')).toBeNull();
    });
  });
});
