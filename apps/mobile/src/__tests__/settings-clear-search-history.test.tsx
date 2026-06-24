import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
// RN's Modal does not render its children in the jest-expo environment; pass
// them through so any sheet content stays queryable (matches the other settings
// tests).
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

// A controllable focus hook: callbacks register on mount and re-run whenever the
// test calls `refireFocus()` — simulating the Inbox regaining focus after the
// user backs out of Settings.
const focusCallbacks: Array<() => void | (() => void)> = [];
const focusCleanups: Array<(() => void) | void> = [];
function refireFocus() {
  for (let i = 0; i < focusCallbacks.length; i += 1) {
    const cleanup = focusCleanups[i];
    if (typeof cleanup === 'function') {
      cleanup();
    }
    focusCleanups[i] = focusCallbacks[i]();
  }
}
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: (cb: () => void | (() => void)) =>
      useEffect(() => {
        const index = focusCallbacks.length;
        focusCallbacks.push(cb);
        focusCleanups[index] = cb();
        return () => {
          const cleanup = focusCleanups[index];
          if (typeof cleanup === 'function') {
            cleanup();
          }
          focusCallbacks.splice(index, 1);
          focusCleanups.splice(index, 1);
        };
      }, []),
  };
});

import SettingsScreen from '@/app/settings';
import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import { RECENT_SEARCHES_PREF_KEY, parseRecents } from '@/domain/recent-searches';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  focusCallbacks.length = 0;
  focusCleanups.length = 0;
});

test('the clear-search-history row is disabled and reads empty when there is no history', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Anything' })]);
  // No recents seeded.

  const screen = await renderSettings();

  await waitFor(() => expect(screen.getByText('Clear search history')).toBeTruthy());
  // Reads the empty state …
  expect(screen.getByText('No recent searches')).toBeTruthy();
  // … and is announced to assistive tech as a DISABLED button (not silent text):
  // the reserved a11y label resolves, and the disabled state is conveyed.
  const disabledRow = screen.getByLabelText('Clear recent searches');
  expect(disabledRow.props.accessibilityState).toEqual({ disabled: true });
});

test('confirming the clear wipes the persisted recents and flips the row to empty', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Anything' })]);
  fakeRepo.__setMeta(RECENT_SEARCHES_PREF_KEY, JSON.stringify(['local-first', 'raindrop']));

  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = await renderSettings();

  // With history present the row counts it and is pressable via the reserved
  // a11y label (not the visible label).
  await waitFor(() => expect(screen.getByText('2 recent searches')).toBeTruthy());
  const row = screen.getByLabelText('Clear recent searches');

  await act(async () => {
    fireEvent.press(row);
  });

  // The confirm Alert fired with the spec copy (title + reassuring body).
  expect(alertSpy).toHaveBeenCalled();
  const [title, body, buttons] = alertSpy.mock.calls[0];
  expect(title).toBe('Clear search history?');
  expect(body).toContain('Your bookmarks and tags aren’t affected.');

  // Invoke the destructive "Clear" button the way the native dialog would.
  const confirmButton = (buttons as { text?: string; onPress?: () => void }[]).find(
    (b) => b.text === 'Clear',
  );
  expect(confirmButton).toBeTruthy();
  await act(async () => {
    confirmButton?.onPress?.();
  });

  // Row flips to the disabled empty state optimistically …
  await waitFor(() => expect(screen.getByText('No recent searches')).toBeTruthy());
  // … now announced as a disabled button rather than a live one.
  expect(
    screen.getByLabelText('Clear recent searches').props.accessibilityState,
  ).toEqual({ disabled: true });
  // … and the persisted recents are now empty (local-only write).
  await waitFor(() =>
    expect(parseRecents(fakeRepo.__meta(RECENT_SEARCHES_PREF_KEY))).toEqual([]),
  );

  alertSpy.mockRestore();
});

test('the Inbox reflects the cleared recents on its next focus', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e1';
  fakeRepo.__reset([makeStoredBookmark({ id, title: 'Design system' })]);
  // A recent with no tags/folders, so the focus-empty shelf shows ONLY the
  // recent — once cleared, the shelf has nothing to show and disappears.
  fakeRepo.__setMeta(RECENT_SEARCHES_PREF_KEY, JSON.stringify(['local-first']));

  const screen = await render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <InboxScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
  await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

  // Focus the empty field: the shelf shows the seeded recent chip.
  const input = screen.getByPlaceholderText('Search titles, tags, folders');
  await act(async () => {
    fireEvent(input, 'focus');
  });
  await waitFor(() =>
    expect(screen.getByLabelText('Search again for “local-first”')).toBeTruthy(),
  );

  // Simulate clearing search history in Settings: the empty list is written
  // straight to the meta store (as the Settings confirm does), without touching
  // this screen's state.
  await act(async () => {
    await fakeRepo.repository.setMeta(RECENT_SEARCHES_PREF_KEY, JSON.stringify([]));
  });

  // Returning to the Inbox re-runs its focus effect, which re-reads recents.
  await act(async () => {
    refireFocus();
  });

  // The recent chip is gone (and with no tags/folders, the whole shelf with it).
  await waitFor(() =>
    expect(screen.queryByLabelText('Search again for “local-first”')).toBeNull(),
  );
  expect(screen.queryByTestId('search-suggestion-shelf')).toBeNull();
});

test('a focus re-read does not drop a just-submitted recent (in-flight write race)', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000e2';
  fakeRepo.__reset([makeStoredBookmark({ id, title: 'Design system' })]);
  fakeRepo.__setMeta(RECENT_SEARCHES_PREF_KEY, JSON.stringify(['local-first']));

  // Hang the recents persist write so it's still IN FLIGHT (uncommitted, the
  // store still holds only the old list) when the Inbox regains focus — the
  // exact window where a focus re-read could clobber the new in-memory recent.
  let releaseWrite: (() => void) | undefined;
  const realSetMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  const setMetaSpy = jest
    .spyOn(fakeRepo.repository, 'setMeta')
    .mockImplementation((key: string, value: string) => {
      if (key === RECENT_SEARCHES_PREF_KEY) {
        return new Promise<void>((resolve) => {
          releaseWrite = () => realSetMeta(key, value).then(resolve);
        });
      }
      return realSetMeta(key, value);
    });

  try {
    const screen = await render(
      <BookmarksProvider>
        <CaptureToastProvider>
          <InboxScreen />
        </CaptureToastProvider>
      </BookmarksProvider>,
    );
    await waitFor(() => expect(screen.getByText('Design system')).toBeTruthy());

    const input = screen.getByPlaceholderText('Search titles, tags, folders');
    await act(async () => {
      fireEvent(input, 'focus');
    });
    // Type + submit a new query: records 'design system' into recents (in memory),
    // and its persist write hangs — the store is now stale relative to state.
    await act(async () => {
      fireEvent.changeText(input, 'design system');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing', { nativeEvent: { text: 'design system' } });
    });

    // Inbox regains focus while the write is still hanging. The dirty-guard must
    // skip the re-read, so the just-submitted recent is NOT clobbered.
    await act(async () => {
      refireFocus();
    });

    // Clear the query so the focus-empty shelf lists all recents, and assert the
    // just-submitted one survived (it would be gone if the re-read had won).
    await act(async () => {
      fireEvent.changeText(input, '');
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Search again for “design system”')).toBeTruthy(),
    );
    expect(screen.getByLabelText('Search again for “local-first”')).toBeTruthy();
  } finally {
    await act(async () => {
      releaseWrite?.();
    });
    setMetaSpy.mockRestore();
  }
});
