import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// The automatic-retry skeleton-suppression rule (hadPriorEnrichmentAttempt +
// isEnriching) needs an in-flight enrichment request, which the real store
// only produces via a live auth session + network round trip. Driving that
// for every case here would mean wiring session/network mocks into the full
// integration test file (bookmark-detail-screen.test.tsx) and risks changing
// behavior for its ~40 other tests, so — same rationale as
// inbox-syncing-state.test.tsx — we stub the store to isolate this one UI
// branch instead.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({
    navigate: jest.fn(),
    dismissTo: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
  }),
  useLocalSearchParams: () => ({ id: BOOKMARK_ID }),
}));

const BOOKMARK_ID = '7e64cf1e-0000-4000-8000-000000000001';

let mockStoreOverrides: Record<string, unknown> = {};
jest.mock('@/store/bookmarks', () => {
  const actual = jest.requireActual('@/store/bookmarks');
  return {
    ...actual,
    useBookmarks: () => ({
      getBookmark: () => mockBookmark,
      getTagsForBookmark: () => [],
      getCollection: () => undefined,
      getEnrichment: () => undefined,
      trashBookmark: () => {},
      restoreBookmark: () => {},
      updateBookmarkFields: () => {},
      markBookmarkAccessed: () => {},
      deleteBookmark: () => {},
      collections: [],
      addTagsToBookmark: async () => null,
      removeTagFromBookmark: async () => null,
      requestAiEnrichment: async () => null,
      refreshBookmarkPreview: async () => null,
      isRefreshingPreview: () => false,
      isEnriching: () => false,
      isManuallyEnriching: () => false,
      isAiSuggestionPostponed: () => false,
      isAiSuggestionServerQueued: () => false,
      hadPriorEnrichmentAttempt: () => false,
      acceptSuggestedTags: async () => null,
      getReviewedSuggestions: () => new Set(),
      markSuggestionsReviewed: () => {},
      clearReviewedSuggestions: () => {},
      getDismissedFolderSuggestions: () => new Set(),
      dismissFolderSuggestion: () => {},
      clearDismissedFolderSuggestions: () => {},
      getReviewedSummary: () => new Set(),
      markSummaryReviewed: () => {},
      clearReviewedSummary: () => {},
      markSuggestionsSeen: () => {},
      assignCollection: async () => null,
      createCollection: async () => null,
      ...mockStoreOverrides,
    }),
  };
});

import BookmarkDetailScreen from '@/app/bookmark/[id]';
import { CaptureToastProvider } from '@/ui/capture-toast';
import { makeStoredBookmark } from './helpers/fake-repository';

const mockBookmark = makeStoredBookmark({ id: BOOKMARK_ID, title: 'A synced bookmark' });

function renderDetail() {
  return render(
    <CaptureToastProvider>
      <BookmarkDetailScreen />
    </CaptureToastProvider>,
  );
}

afterEach(() => {
  mockStoreOverrides = {};
});

test('shows the ambient skeleton on a bookmark\'s very first enrichment attempt', async () => {
  mockStoreOverrides = { isEnriching: () => true, hadPriorEnrichmentAttempt: () => false };
  const screen = await renderDetail();

  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());
  expect(screen.getByLabelText('Working…')).toBeTruthy();
});

test('suppresses the skeleton on an automatic retry (a prior attempt already failed)', async () => {
  // isEnriching is still true (the retry is in flight), but a prior attempt
  // already failed — showing the shimmer again would read as a repeated
  // "results any second now" flash followed by another letdown.
  mockStoreOverrides = { isEnriching: () => true, hadPriorEnrichmentAttempt: () => true };
  const screen = await renderDetail();

  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());
  expect(screen.queryByLabelText('Working…')).toBeNull();
});

test('a manual "Suggest with AI" tap still shows its own generating label regardless of prior attempts', async () => {
  // The manual-only feedback (isManuallyEnriching) must stay exactly as today
  // regardless of hadPriorEnrichmentAttempt — the skeleton-suppression rule
  // only applies to the automatic-retry ambient placeholder above.
  mockStoreOverrides = {
    isEnriching: () => true,
    isManuallyEnriching: () => true,
    hadPriorEnrichmentAttempt: () => true,
  };
  const screen = await renderDetail();

  await waitFor(() => expect(screen.getByText('A synced bookmark')).toBeTruthy());
  expect(screen.getByText('Generating suggestions…')).toBeTruthy();
  // The ambient skeleton is still suppressed on this retry — the button's own
  // label is the only "in progress" signal.
  expect(screen.queryByLabelText('Working…')).toBeNull();
});
