import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { BackHandler, Platform } from 'react-native';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
// RN's Modal does not render its children in jest-expo; pass them through so the
// Settings sheet content stays queryable (matches the other settings tests).
jest.mock('react-native/Libraries/Modal/Modal', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockModal = ({ visible, children }: { visible?: boolean; children: ReactNode }) =>
    visible === false ? null : React.createElement(View, null, children);
  return { __esModule: true, default: MockModal };
});
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    isSignedIn: false,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({ push: mockPush, navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    usePathname: () => '/',
    // Honour the callback identity ([cb]) so the hardware-back handler re-registers
    // when the filter changes (mirrors the real useFocusEffect) — the ✨ lens must
    // rebind the peel handler after the banner sets the suggested filter.
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, [cb]),
  };
});

import InboxScreen from '@/app/(tabs)/index';
import SettingsScreen from '@/app/settings';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

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

// Capture the hardware-back handlers the Inbox registers (re-registered on each
// filter change; the most recent is the one bound to live state).
let backHandlers: Array<() => boolean | null | undefined> = [];
let addSpy: jest.SpyInstance;

// The screen only subscribes to hardware back on Android; pin the platform so the
// peel handler is exercised. Module registries are per-file, so this can't leak.
beforeAll(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
});

beforeEach(() => {
  mockPush.mockClear();
  backHandlers = [];
  addSpy = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event: string, handler: () => boolean | null | undefined) => {
      backHandlers.push(handler);
      return {
        remove: () => {
          backHandlers = backHandlers.filter((entry) => entry !== handler);
        },
      } as ReturnType<typeof BackHandler.addEventListener>;
    });
});

afterEach(() => {
  addSpy.mockRestore();
});

async function pressBack(): Promise<boolean | null | undefined> {
  const handler = backHandlers[backHandlers.length - 1];
  expect(handler).toBeTruthy();
  let result: boolean | null | undefined;
  await act(async () => {
    result = handler();
  });
  return result;
}

// A bookmark carrying a pending (un-applied) tag suggestion, plus a plain one.
const PENDING_ID = '7e64cf1e-0000-4000-8000-0000000000a1';
const PLAIN_ID = '7e64cf1e-0000-4000-8000-0000000000a2';

function seedOnePending() {
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: PENDING_ID, title: 'Has a suggestion' }),
      makeStoredBookmark({ id: PLAIN_ID, title: 'Nothing pending' }),
    ],
    undefined,
    [makeEnrichment({ bookmark_id: PENDING_ID, suggested_tags: [{ name: 'design', confidence: 0.8 }] })],
  );
}

test('tapping the review banner applies the ✨ lens instead of navigating to /review', async () => {
  seedOnePending();

  const screen = await renderInbox();

  // Both items visible, and the standing review banner counts the one pending.
  await waitFor(() => expect(screen.getByText('Has a suggestion')).toBeTruthy());
  expect(screen.getByText('Nothing pending')).toBeTruthy();
  expect(screen.getByText('✨ 1 suggestion to review')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByTestId('new-suggestions-banner'));
  });

  // It applies an in-Inbox lens — NOT a navigation to the Review screen.
  expect(mockPush).not.toHaveBeenCalledWith('/review');
  // The distinct scope state takes over, and the banner steps aside.
  await waitFor(() => expect(screen.getByText('Reviewing suggestions')).toBeTruthy());
  expect(screen.queryByTestId('review-banner')).toBeNull();
  // Only the pending item remains; the plain one is filtered out.
  expect(screen.getByText('Has a suggestion')).toBeTruthy();
  expect(screen.queryByText('Nothing pending')).toBeNull();
});

test('the ✨ lens count matches the banner/badge count', async () => {
  const SECOND_PENDING = '7e64cf1e-0000-4000-8000-0000000000a3';
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: PENDING_ID, title: 'First pending' }),
      makeStoredBookmark({ id: SECOND_PENDING, title: 'Second pending' }),
      makeStoredBookmark({ id: PLAIN_ID, title: 'Nothing pending' }),
    ],
    undefined,
    [
      makeEnrichment({ bookmark_id: PENDING_ID, suggested_tags: [{ name: 'design', confidence: 0.8 }] }),
      makeEnrichment({ bookmark_id: SECOND_PENDING, suggested_tags: [{ name: 'video', confidence: 0.7 }] }),
    ],
  );

  const screen = await renderInbox();

  // Banner promises two to review.
  await waitFor(() => expect(screen.getByText('✨ 2 suggestions to review')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByTestId('new-suggestions-banner'));
  });

  // The lens section reports the same count, and shows exactly those two items.
  await waitFor(() => expect(screen.getByText('✨ 2 to review')).toBeTruthy());
  expect(screen.getByText('First pending')).toBeTruthy();
  expect(screen.getByText('Second pending')).toBeTruthy();
  expect(screen.queryByText('Nothing pending')).toBeNull();
});

test('clearing the scope (✕) exits the ✨ lens back to the prior filter', async () => {
  seedOnePending();

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('✨ 1 suggestion to review')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByTestId('new-suggestions-banner'));
  });
  await waitFor(() => expect(screen.getByText('Reviewing suggestions')).toBeTruthy());

  // The scope-bar ✕ leaves the lens: the plain item returns and the banner is back.
  await act(async () => {
    fireEvent.press(screen.getByTestId('inbox-filter-clear'));
  });
  await waitFor(() => expect(screen.getByText('Nothing pending')).toBeTruthy());
  expect(screen.queryByText('Reviewing suggestions')).toBeNull();
  expect(screen.getByTestId('review-banner')).toBeTruthy();
});

test('hardware back peels the ✨ lens first, then hands off to the OS', async () => {
  seedOnePending();

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('✨ 1 suggestion to review')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByTestId('new-suggestions-banner'));
  });
  await waitFor(() => expect(screen.getByText('Reviewing suggestions')).toBeTruthy());

  // Back peels the lens (returns to All) and consumes the press.
  expect(await pressBack()).toBe(true);
  await waitFor(() => expect(screen.getByText('Nothing pending')).toBeTruthy());
  expect(screen.queryByText('Reviewing suggestions')).toBeNull();

  // With nothing left to peel, back is handed to the OS.
  expect(await pressBack()).toBe(false);
});

test('Settings still links to the Review screen as the fallback', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Anything' })]);

  const screen = await render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );

  await waitFor(() => expect(screen.getByText('Review AI suggestions')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByText('Review AI suggestions'));
  });
  expect(mockPush).toHaveBeenCalledWith('/review');
});
