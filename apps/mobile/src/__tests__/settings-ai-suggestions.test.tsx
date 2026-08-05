import {
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react-native';
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
  useRouter: () => ({
    push: jest.fn(),
    navigate: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  }),
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

test('the AI suggestions preference defaults to confirm mode', async () => {
  const screen = await renderSettings();
  await waitFor(() =>
    expect(screen.getByText('Review suggestions before applying')).toBeTruthy(),
  );
});

test('picking Auto-apply updates the preference and persists it', async () => {
  const screen = await renderSettings();
  await waitFor(() =>
    expect(screen.getByText('Review suggestions before applying')).toBeTruthy(),
  );

  fireEvent.press(screen.getByText('AI suggestions'));
  await waitFor(() =>
    expect(
      screen.getByText('Auto-apply high-confidence suggestions'),
    ).toBeTruthy(),
  );
  fireEvent.press(screen.getByText('Auto-apply high-confidence suggestions'));

  await waitFor(() =>
    expect(fakeRepo.__meta(AI_SUGGESTIONS_MODE_PREF_KEY)).toBe('auto_accept'),
  );
});

test('the processing AI row is stable at zero with no backlog', async () => {
  const screen = await renderSettings();
  await waitFor(() =>
    expect(
      within(screen.getByTestId('processing-stage-ai')).getByText('0 bookmarks'),
    ).toBeTruthy(),
  );
});

test('the processing AI row surfaces the full local backlog', async () => {
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify(['bm-1', 'bm-2', 'bm-3']),
  );

  const screen = await renderSettings();
  await waitFor(() =>
    expect(
      within(screen.getByTestId('processing-stage-ai')).getByText('3 bookmarks'),
    ).toBeTruthy(),
  );
});

test('AI off is shown as a modifier without hiding frozen local work', async () => {
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'off');
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify(['bm-1', 'bm-2', 'bm-3']),
  );

  const screen = await renderSettings();
  await waitFor(() =>
    expect(
      within(screen.getByTestId('processing-stage-ai')).getByText(
        '3 bookmarks · AI suggestions off',
      ),
    ).toBeTruthy(),
  );
});

test('AI off also keeps already server-queued work visible', async () => {
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'off');
  await fakeRepo.repository.setMeta(
    'ai_server_queued',
    JSON.stringify(['bm-1', 'bm-2']),
  );

  const screen = await renderSettings();
  await waitFor(() =>
    expect(
      within(screen.getByTestId('processing-stage-ai')).getByText(
        '2 bookmarks · AI suggestions off',
      ),
    ).toBeTruthy(),
  );
});
