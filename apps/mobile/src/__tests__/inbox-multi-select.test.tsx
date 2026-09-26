import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert, Platform } from 'react-native';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const mockAuthSessionValue = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-test' },
};
let mockAuthSession: typeof mockAuthSessionValue | null = null;
afterEach(() => {
  mockAuthSession = null;
  resetPreviewImageFailuresForTest();
});

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: mockAuthSession ? 'anonymous' : 'not_configured',
    session: mockAuthSession,
    userId: mockAuthSession ? 'user-test' : null,
    message: mockAuthSession ? null : 'not configured',
    ensureAnonymousSession: async () => mockAuthSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

let mockEnrichmentCalls: string[] = [];
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async (bm: { id: string }) => {
    mockEnrichmentCalls.push(bm.id);
    return { patch: {}, metadata_status: 'complete' };
  },
}));

let mockNextCollectionId = 0;
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
      createCollection: async (name: string) => {
        mockNextCollectionId += 1;
        const now = new Date().toISOString();
        return {
          id: `new-col-${mockNextCollectionId}`,
          user_id: 'user-test',
          name,
          description: null,
          created_at: now,
          updated_at: now,
        };
      },
    }),
  };
});

const mockWindowSize = { width: 390, height: 844, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowSize,
}));

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
const mockSetParams = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({
      push: mockPush,
      navigate: jest.fn(),
      replace: jest.fn(),
      back: jest.fn(),
      setParams: mockSetParams,
    }),
    useLocalSearchParams: () => mockParams,
    usePathname: () => '/',
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
  };
});

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import { resetPreviewImageFailuresForTest } from '@/domain/preview-image-cache';
import type { Collection } from '@/domain/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

function makeCollection(id: string, name: string): Collection {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, description: null, created_at: now, updated_at: now };
}

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderInbox() {
  return render(
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
  mockSetParams.mockReset();
  mockEnrichmentCalls = [];
});

test('enters selection mode via the select toggle pill and shows BulkActionBar', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'First bookmark',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'Second bookmark',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('First bookmark')).toBeTruthy());

  // FAB is initially visible
  expect(screen.getByLabelText('Add bookmark')).toBeTruthy();

  // Enter selection mode
  const selectToggle = screen.getByTestId('inbox-select-toggle');
  await fireEvent.press(selectToggle);

  // FAB is hidden, BulkActionBar and selection header are visible
  await waitFor(() => {
    expect(screen.queryByLabelText('Add bookmark')).toBeNull();
    expect(screen.getByText('0 selected')).toBeTruthy();
    expect(screen.getByTestId('inbox-bulk-action-bar')).toBeTruthy();
  });

  // Bulk actions should be disabled with 0 selected
  const refreshBtn = screen.getByTestId('inbox-bulk-refresh');
  const moveBtn = screen.getByTestId('inbox-bulk-move');
  const deleteBtn = screen.getByTestId('inbox-bulk-delete');
  expect(refreshBtn.props.accessibilityState?.disabled).toBe(true);
  expect(moveBtn.props.accessibilityState?.disabled).toBe(true);
  expect(deleteBtn.props.accessibilityState?.disabled).toBe(true);

  // Close selection mode via hero close button
  const closeBtn = screen.getByTestId('inbox-selection-close');
  await fireEvent.press(closeBtn);

  // Exited selection mode: FAB returns, toolbar hides
  await waitFor(() => {
    expect(screen.getByLabelText('Add bookmark')).toBeTruthy();
    expect(screen.queryByTestId('inbox-bulk-action-bar')).toBeNull();
  });
});

test('toggles selection on cards, select all, and deselect all', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'First bookmark',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'Second bookmark',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('First bookmark')).toBeTruthy());

  // Enter selection mode
  await fireEvent.press(screen.getByTestId('inbox-select-toggle'));
  expect(screen.getByText('0 selected')).toBeTruthy();

  // Tap first card checkbox to select
  await fireEvent.press(screen.getByTestId('inbox-select-checkbox-7e64cf1e-0000-4000-8000-000000000001'));
  expect(screen.getByText('1 selected')).toBeTruthy();

  // Bulk action buttons are now enabled
  expect(screen.getByTestId('inbox-bulk-delete').props.accessibilityState?.disabled).toBe(false);

  // Tap select all button
  const selectAllBtn = screen.getByTestId('inbox-selection-select-all');
  expect(within(selectAllBtn).getByText('Select all')).toBeTruthy();
  await fireEvent.press(selectAllBtn);

  // Both selected
  expect(screen.getByText('2 selected')).toBeTruthy();
  expect(within(selectAllBtn).getByText('Deselect all')).toBeTruthy();

  // Tap deselect all
  await fireEvent.press(selectAllBtn);
  expect(screen.getByText('0 selected')).toBeTruthy();
  expect(within(selectAllBtn).getByText('Select all')).toBeTruthy();
});

test('enters selection mode with pre-selected item from single bookmark menu', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'First bookmark',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'Second bookmark',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('First bookmark')).toBeTruthy());

  // Open More actions menu for first bookmark
  await fireEvent.press(screen.getAllByLabelText('More actions')[0]);
  expect(screen.getByText('Select items…')).toBeTruthy();

  // Choose "Select items…"
  await fireEvent.press(screen.getByText('Select items…'));

  // Should enter selection mode with First bookmark already selected (1 selected)
  await waitFor(() => {
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByTestId('inbox-bulk-action-bar')).toBeTruthy();
  });
});

test('long-pressing a card enters selection mode, and subsequent short press selects additional items', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'First bookmark',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'Second bookmark',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000003',
      title: 'Third bookmark',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('First bookmark')).toBeTruthy());

  // Long-press first bookmark directly enters selection mode with 1 selected
  await fireEvent(screen.getByText('First bookmark'), 'longPress');
  await waitFor(() => {
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByTestId('inbox-bulk-action-bar')).toBeTruthy();
  });

  // Subsequent short press on second bookmark selects it (2 selected)
  await fireEvent.press(screen.getByText('Second bookmark'));
  expect(screen.getByText('2 selected')).toBeTruthy();

  // Subsequent short press on third bookmark selects it (3 selected)
  await fireEvent.press(screen.getByText('Third bookmark'));
  expect(screen.getByText('3 selected')).toBeTruthy();

  // Subsequent short press on second bookmark deselects it (2 selected)
  await fireEvent.press(screen.getByText('Second bookmark'));
  expect(screen.getByText('2 selected')).toBeTruthy();
});

test('bulk delete prompts confirmation, moves selected items to trash, and provides undo', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'First bookmark',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'Second bookmark',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000003',
      title: 'Third bookmark',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('First bookmark')).toBeTruthy());

  // Enter selection mode and select first two items
  await fireEvent.press(screen.getByTestId('inbox-select-toggle'));
  await fireEvent.press(screen.getByTestId('inbox-select-checkbox-7e64cf1e-0000-4000-8000-000000000001'));
  await fireEvent.press(screen.getByTestId('inbox-select-checkbox-7e64cf1e-0000-4000-8000-000000000002'));
  expect(screen.getByText('2 selected')).toBeTruthy();

  // Spy on Alert.alert so the destructive button's onPress is triggered
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    const deleteButton = buttons?.find((b) => b.style === 'destructive');
    deleteButton?.onPress?.();
  });

  // Trigger bulk delete
  await fireEvent.press(screen.getByTestId('inbox-bulk-delete'));

  expect(alertSpy).toHaveBeenCalled();
  alertSpy.mockRestore();

  // Items are moved to trash and removed from visible inbox
  await waitFor(() => {
    expect(screen.queryByText('First bookmark')).toBeNull();
    expect(screen.queryByText('Second bookmark')).toBeNull();
    expect(screen.getByText('Third bookmark')).toBeTruthy();
  });

  // Selection mode is exited
  expect(screen.queryByTestId('inbox-bulk-action-bar')).toBeNull();

  // Undo toast is shown
  const undo = await screen.findByText('Undo');
  await act(async () => {
    fireEvent.press(undo);
  });

  // Both bookmarks are restored
  await waitFor(() => {
    expect(screen.getByText('First bookmark')).toBeTruthy();
    expect(screen.getByText('Second bookmark')).toBeTruthy();
  });
});

test('bulk move to collection moves all selected bookmarks', async () => {
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-000000000001',
        title: 'First bookmark',
        collection_id: null,
      }),
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-000000000002',
        title: 'Second bookmark',
        collection_id: null,
      }),
    ],
    {
      tags: [],
      bookmarkTags: [],
      collections: [makeCollection('col-work', 'Work projects')],
    },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('First bookmark')).toBeTruthy());

  // Enter selection mode and select both
  await fireEvent.press(screen.getByTestId('inbox-select-toggle'));
  await fireEvent.press(screen.getByTestId('inbox-selection-select-all'));
  expect(screen.getByText('2 selected')).toBeTruthy();

  // Press Move button to open collection picker ActionSheet
  await fireEvent.press(screen.getByTestId('inbox-bulk-move'));

  // Action sheet displays collections
  await waitFor(() => expect(screen.getByText('Work projects')).toBeTruthy());

  // Tap collection
  await fireEvent.press(screen.getByText('Work projects'));

  // Exits selection mode and updates stored collection_id
  await waitFor(() => {
    expect(screen.queryByTestId('inbox-bulk-action-bar')).toBeNull();
  });

  const stored = fakeRepo.__bookmarks();
  expect(stored.find((b) => b.id === '7e64cf1e-0000-4000-8000-000000000001')?.collection_id).toBe('col-work');
  expect(stored.find((b) => b.id === '7e64cf1e-0000-4000-8000-000000000002')?.collection_id).toBe('col-work');
});

test('bulk move with New Collection dialog creates collection and assigns selected items', async () => {
  mockAuthSession = mockAuthSessionValue;
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'First bookmark',
      collection_id: null,
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'Second bookmark',
      collection_id: null,
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('First bookmark')).toBeTruthy());

  // Enter selection mode and select both
  await fireEvent.press(screen.getByTestId('inbox-select-toggle'));
  await fireEvent.press(screen.getByTestId('inbox-selection-select-all'));
  expect(screen.getByText('2 selected')).toBeTruthy();

  // Open move sheet
  await fireEvent.press(screen.getByTestId('inbox-bulk-move'));
  await waitFor(() => expect(screen.getByText('New collection')).toBeTruthy());

  // Tap "+ New collection"
  await fireEvent.press(screen.getByText('New collection'));

  // New folder dialog opens
  await waitFor(() => expect(screen.getByPlaceholderText('Collection name')).toBeTruthy());
  const input = screen.getByPlaceholderText('Collection name');
  await fireEvent.changeText(input, 'Reading list');

  // Submit dialog
  await fireEvent.press(screen.getByText('Create'));

  // Assigned to the newly created collection and selection mode exited
  await waitFor(() => {
    expect(screen.queryByTestId('inbox-bulk-action-bar')).toBeNull();
  });

  const stored = fakeRepo.__bookmarks();
  const firstCol = stored.find((b) => b.id === '7e64cf1e-0000-4000-8000-000000000001')?.collection_id;
  const secondCol = stored.find((b) => b.id === '7e64cf1e-0000-4000-8000-000000000002')?.collection_id;
  expect(firstCol).toBeTruthy();
  expect(firstCol).toBe(secondCol);
});

test('bulk refresh triggers preview refresh on selected URL items and shows feedback toast', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'URL Bookmark 1',
      url: 'https://example.com/1',
      url_hash: 'https://example.com/1',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'URL Bookmark 2',
      url: 'https://example.com/2',
      url_hash: 'https://example.com/2',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000003',
      title: 'Text Memo Note',
      url: null,
      url_hash: null,
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('URL Bookmark 1')).toBeTruthy());

  // Select all 3 items
  await fireEvent.press(screen.getByTestId('inbox-select-toggle'));
  await fireEvent.press(screen.getByTestId('inbox-selection-select-all'));
  expect(screen.getByText('3 selected')).toBeTruthy();

  // Tap Bulk Refresh
  await act(async () => {
    fireEvent.press(screen.getByTestId('inbox-bulk-refresh'));
  });

  // Exits selection mode and shows feedback toast
  await waitFor(() => {
    expect(screen.queryByTestId('inbox-bulk-action-bar')).toBeNull();
  });

  // Toast announces refreshed previews
  await waitFor(() => {
    expect(screen.getByText('Refreshed 2 previews')).toBeTruthy();
  });
});

test('Escape key on web exits selection mode', async () => {
  const originalOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'web' });
  let keyHandler: ((e: { key: string }) => void) | null = null;
  const originalAdd = window.addEventListener;
  const originalRemove = window.removeEventListener;
  window.addEventListener = jest.fn((event, handler) => {
    if (event === 'keydown') keyHandler = handler as any;
  }) as any;
  window.removeEventListener = jest.fn() as any;

  try {
    fakeRepo.__reset([
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-000000000001',
        title: 'First bookmark',
      }),
    ]);
    const screen = await renderInbox();
    await waitFor(() => expect(screen.getByText('First bookmark')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('inbox-select-toggle'));
    expect(screen.getByText('0 selected')).toBeTruthy();

    expect(keyHandler).toBeTruthy();
    await act(async () => {
      keyHandler?.({ key: 'Escape' });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('inbox-bulk-action-bar')).toBeNull();
    });
  } finally {
    window.addEventListener = originalAdd;
    window.removeEventListener = originalRemove;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalOS });
  }
});

test('supports selecting all items narrowed by search and preserving search query', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'React Native in Action',
      url: 'https://reactnative.dev',
      url_hash: 'https://reactnative.dev',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'React Architecture Guide',
      url: 'https://react.dev',
      url_hash: 'https://react.dev',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000003',
      title: 'Vue Composition Guide',
      url: 'https://vuejs.org',
      url_hash: 'https://vuejs.org',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('React Native in Action')).toBeTruthy());
  expect(screen.getByText('Vue Composition Guide')).toBeTruthy();

  // Open search and query 'React'
  await fireEvent.press(screen.getByTestId('inbox-search-open'));
  const searchInput = screen.getByTestId('inbox-search-input');
  await fireEvent.changeText(searchInput, 'React');
  await fireEvent(searchInput, 'blur');

  // Wait for filtered results: 2 results visible, Vue guide filtered out
  await waitFor(() => expect(screen.getByText('2 results')).toBeTruthy());
  expect(screen.getByText('React Native in Action')).toBeTruthy();
  expect(screen.getByText('React Architecture Guide')).toBeTruthy();
  expect(screen.queryByText('Vue Composition Guide')).toBeNull();

  // Enter selection mode via the search filter bar select toggle
  const filterSelectToggle = screen.getByTestId('inbox-filter-select-toggle');
  await fireEvent.press(filterSelectToggle);

  // BulkActionBar is visible with 0 selected, and search input is non-editable during selection
  await waitFor(() => {
    expect(screen.getByText('0 selected')).toBeTruthy();
    expect(screen.getByTestId('inbox-bulk-action-bar')).toBeTruthy();
  });
  expect(screen.getByTestId('inbox-search-input').props.editable).toBe(false);

  // Press Select all: should only select the 2 visible search results, NOT the 3rd Vue item
  const selectAllBtn = screen.getByTestId('inbox-selection-select-all');
  expect(within(selectAllBtn).getByText('Select all')).toBeTruthy();
  await fireEvent.press(selectAllBtn);

  expect(screen.getByText('2 selected')).toBeTruthy();
  expect(within(selectAllBtn).getByText('Deselect all')).toBeTruthy();

  // Tap Deselect all: should deselect the 2 items
  await fireEvent.press(selectAllBtn);
  expect(screen.getByText('0 selected')).toBeTruthy();
  expect(within(selectAllBtn).getByText('Select all')).toBeTruthy();

  // Re-select all 2 items
  await fireEvent.press(selectAllBtn);
  expect(screen.getByText('2 selected')).toBeTruthy();

  // Exit selection mode: search query 'React' should still be preserved
  await fireEvent.press(screen.getByTestId('inbox-selection-close'));
  await waitFor(() => {
    expect(screen.queryByTestId('inbox-bulk-action-bar')).toBeNull();
  });

  // Search input is still present and editable, with filtered results still displayed
  const restoredSearchInput = screen.getByTestId('inbox-search-input');
  expect(restoredSearchInput.props.editable).toBe(true);
  expect(screen.getByText('React Native in Action')).toBeTruthy();
  expect(screen.getByText('React Architecture Guide')).toBeTruthy();
  expect(screen.queryByText('Vue Composition Guide')).toBeNull();
});

test('entering selection mode from single bookmark menu during search preserves search filter', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'React Native in Action',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'React Architecture Guide',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000003',
      title: 'Vue Composition Guide',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('React Native in Action')).toBeTruthy());

  // Search 'React'
  await fireEvent.press(screen.getByTestId('inbox-search-open'));
  const searchInput = screen.getByTestId('inbox-search-input');
  await fireEvent.changeText(searchInput, 'React');
  await fireEvent(searchInput, 'blur');
  await waitFor(() => expect(screen.getByText('2 results')).toBeTruthy());

  // Open More actions menu for first card to select it via menu
  await fireEvent.press(screen.getAllByLabelText('More actions')[0]);
  expect(screen.getByText('Select items…')).toBeTruthy();
  await fireEvent.press(screen.getByText('Select items…'));

  // Entered selection mode with 1 selected
  await waitFor(() => {
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByTestId('inbox-bulk-action-bar')).toBeTruthy();
  });

  // Vue guide is still filtered out
  expect(screen.queryByText('Vue Composition Guide')).toBeNull();

  // Select all selects the remaining matching result (total 2)
  await fireEvent.press(screen.getByTestId('inbox-selection-select-all'));
  expect(screen.getByText('2 selected')).toBeTruthy();
});

test('long-pressing a card during search directly enters selection mode and subsequent short press selects additional matches', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'React Native in Action',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000002',
      title: 'React Architecture Guide',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000003',
      title: 'Vue Composition Guide',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('React Native in Action')).toBeTruthy());

  // Search 'React'
  await fireEvent.press(screen.getByTestId('inbox-search-open'));
  const searchInput = screen.getByTestId('inbox-search-input');
  await fireEvent.changeText(searchInput, 'React');
  await fireEvent(searchInput, 'blur');
  await waitFor(() => expect(screen.getByText('2 results')).toBeTruthy());

  // Long-press first card directly enters selection mode with 1 selected
  await fireEvent(screen.getByText('React Native in Action'), 'longPress');
  await waitFor(() => {
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByTestId('inbox-bulk-action-bar')).toBeTruthy();
  });

  // Subsequent short press on second card selects it (now 2 selected)
  await fireEvent.press(screen.getByText('React Architecture Guide'));
  expect(screen.getByText('2 selected')).toBeTruthy();

  // Vue guide is still filtered out
  expect(screen.queryByText('Vue Composition Guide')).toBeNull();
});

test('places selection mark at top-left of bookmark in card view', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-000000000001',
      title: 'Top Left Selection Card',
      url: 'https://example.com/card',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Top Left Selection Card')).toBeTruthy());

  // Enter selection mode via select pill
  await fireEvent.press(screen.getByTestId('inbox-select-toggle'));

  const checkbox = screen.getByTestId('inbox-select-checkbox-7e64cf1e-0000-4000-8000-000000000001');
  expect(checkbox).toBeTruthy();
  expect(checkbox.props.style).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        position: 'absolute',
        top: 10,
        left: 10,
      }),
    ]),
  );
});
