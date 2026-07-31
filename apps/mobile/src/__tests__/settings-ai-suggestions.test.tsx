import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// Mirrors settings-sheet.test.tsx's mocking harness.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'anonymous',
    email: null,
    displayName: null,
    avatarUrl: null,
    isSignedIn: true,
    userId: 'user-1',
    message: '',
    signIn: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => {}),
    ensureAnonymousSession: jest.fn(async () => null),
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

const mockWindowSize = { width: 390, height: 844, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowSize,
}));

import SettingsScreen from '@/app/settings';
import { AI_SUGGESTIONS_MODE_PREF_KEY } from '@/domain/ai-suggestions-pref';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  fakeRepo.__reset([]);
});

test('the AI suggestions row defaults to "Review suggestions before applying" (confirm mode)', async () => {
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Review suggestions before applying')).toBeTruthy());
});

test('picking Auto-apply in the sheet updates the row label and persists durably', async () => {
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Review suggestions before applying')).toBeTruthy());

  await fireEvent.press(screen.getByText('AI suggestions'));
  await waitFor(() =>
    expect(screen.getByText('Auto-apply high-confidence suggestions')).toBeTruthy(),
  );
  await fireEvent.press(screen.getByText('Auto-apply high-confidence suggestions'));

  // The row now reflects the new mode...
  await waitFor(() =>
    expect(screen.getByText('Auto-apply high-confidence suggestions')).toBeTruthy(),
  );
  // ...and the choice is durably persisted (survives a relaunch).
  await waitFor(() =>
    expect(fakeRepo.__meta(AI_SUGGESTIONS_MODE_PREF_KEY)).toBe('auto_accept'),
  );
});

test('the AI queue backlog row is absent when nothing is server-queued', async () => {
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Review suggestions before applying')).toBeTruthy());
  expect(screen.queryByText('AI suggestions queued')).toBeNull();
});

test('the AI queue backlog row surfaces the server-queued count (STASH-4K follow-up UX)', async () => {
  // A large backlog (e.g. after a bulk import that exhausts the daily AI
  // quota) should read as "still working, just paced" — not silently stuck.
  await fakeRepo.repository.setMeta(
    'ai_server_queued',
    JSON.stringify(['bm-1', 'bm-2', 'bm-3']),
  );
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('AI suggestions queued')).toBeTruthy());
  expect(
    screen.getByText('3 bookmarks · paced by daily quota, resumes automatically'),
  ).toBeTruthy();
});

test("picking 'Off' in the sheet updates the row label", async () => {
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Review suggestions before applying')).toBeTruthy());

  await fireEvent.press(screen.getByText('AI suggestions'));
  await waitFor(() => expect(screen.getByText('Off — never auto-suggest')).toBeTruthy());
  await fireEvent.press(screen.getByText('Off — never auto-suggest'));

  await waitFor(() => expect(screen.getByText('Off — never auto-suggest')).toBeTruthy());
  await waitFor(() => expect(fakeRepo.__meta(AI_SUGGESTIONS_MODE_PREF_KEY)).toBe('off'));
});
