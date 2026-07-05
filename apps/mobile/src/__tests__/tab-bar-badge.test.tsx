import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

// Capture the options object each <Tabs.Screen> is configured with, so the test
// can inspect what the layout hands the Inbox tab (badge + badge style) without
// mounting the real native bottom-tabs navigator.
const mockScreens: Array<{ name: string; options: Record<string, unknown> }> = [];
jest.mock('expo-router', () => {
  const Tabs = ({ children }: { children: ReactNode }) => children;
  Tabs.Screen = ({ name, options }: { name: string; options: Record<string, unknown> }) => {
    mockScreens.push({ name, options });
    return null;
  };
  return { Tabs };
});

import TabsLayout from '@/app/(tabs)/_layout';
import { BookmarksProvider } from '@/store/bookmarks';
import { palettes } from '@/theme';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function latestIndexOptions(): Record<string, unknown> | undefined {
  for (let i = mockScreens.length - 1; i >= 0; i -= 1) {
    if (mockScreens[i].name === 'index') {
      return mockScreens[i].options;
    }
  }
  return undefined;
}

function renderLayout() {
  return render(
    <BookmarksProvider>
      <TabsLayout />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockScreens.length = 0;
});

test('the Inbox tab badge shows the un-triaged (no-collection) count', async () => {
  // Two loose (no-collection) bookmarks + one filed into a collection: the badge
  // counts only the un-triaged ones, matching the Inbox "No collection" facet.
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000c1', collection_id: null }),
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000c2', collection_id: null }),
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000c3', collection_id: 'col-work' }),
  ]);

  renderLayout();

  await waitFor(() => expect(latestIndexOptions()?.tabBarBadge).toBe(2));
});

test('the Inbox tab badge is HIDDEN (undefined) when the un-triaged count is zero', async () => {
  // Everything filed into a collection → nothing un-triaged → no badge. A queue
  // that can reach zero, per the "no debt number" bet.
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000c4', collection_id: 'col-work' }),
  ]);

  renderLayout();

  // Let the store finish loading, then assert no badge is set.
  await waitFor(() => expect(mockScreens.some((s) => s.name === 'index')).toBe(true));
  await waitFor(() => expect(latestIndexOptions()?.tabBarBadge).toBeUndefined());
});

test('the Inbox tab badge is NEUTRAL — muted palette, not a red danger alert', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000c5', collection_id: null }),
  ]);

  renderLayout();

  await waitFor(() => expect(latestIndexOptions()?.tabBarBadge).toBe(1));

  const style = latestIndexOptions()?.tabBarBadgeStyle as { backgroundColor: string; color: string };
  // Muted/neutral surface, readable text — explicitly NOT the danger red.
  expect(style.backgroundColor).toBe(palettes.light.border);
  expect(style.backgroundColor).not.toBe(palettes.light.danger);
  expect(style.color).toBe(palettes.light.text);
});
