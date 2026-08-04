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

// STASH settings counter cleanup: the old separate Preferences "AI
// suggestions queued" row moved into the Activity section's single "AI
// suggestions" row (also replacing the old sync-card breakdown AI row and
// the Preferences quota row). "AI suggestions" as a label is ambiguous with
// this Preferences mode-selector row's own label, so these tests assert on
// getAllByText counts / the row's unique value text instead.

test('the Activity AI row is absent when there is no AI backlog', async () => {
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Review suggestions before applying')).toBeTruthy());
  // Only the mode-selector row's own "AI suggestions" label remains.
  expect(screen.getAllByText('AI suggestions')).toHaveLength(1);
});

test('the Activity AI row surfaces the full backlog, not just the confirmed-server-queued subset (Codex review, PR #655)', async () => {
  // Codex review: deriving this from only the confirmed-server-queued set
  // (isAiSuggestionServerQueued) undercounts badly — only the ONE bookmark
  // whose 429 already round-tripped through a successful enqueue lands there;
  // everything still sitting in the local dispatch/trigger/retry queues
  // (the bulk of a large backlog) was invisible. diagnosticStats.ai.todo is
  // the union of all three and (via activeUnblocked) is what this must track.
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify(['bm-1', 'bm-2', 'bm-3']),
  );
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getAllByText('AI suggestions')).toHaveLength(2));
  expect(screen.getByText('3 bookmarks')).toBeTruthy();
});

test('the Activity AI row stays hidden when AI suggestions are off and nothing is server-queued, even with a local backlog (Codex review, PR #655)', async () => {
  // With aiSuggestionsMode 'off', neither the dispatch interval nor the
  // retry checker process anything — the not-yet-dispatched local backlog
  // (trigger/dispatch/retry) stays frozen until the user turns AI
  // suggestions back on, and contributes nothing to the blocked count.
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'off');
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify(['bm-1', 'bm-2', 'bm-3']),
  );
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Off — never auto-suggest')).toBeTruthy());
  // Only the mode-selector row's own "AI suggestions" label remains.
  expect(screen.getAllByText('AI suggestions')).toHaveLength(1);
});

test('the Activity AI row shows the confirmed server-queued subset with honest off-mode copy when AI suggestions are off (Codex review, PR #656)', async () => {
  // Codex review: hiding the row entirely when off (the fix above) is itself
  // misleading in the OTHER direction for items the server already confirmed
  // into its overflow queue — the cron worker keeps draining those regardless
  // of this local preference, so they can still arrive with no warning at
  // all. Only the server-queued subset stays visible here (the local
  // trigger/dispatch/retry portions really are frozen), with copy that
  // doesn't promise the rest resumes automatically.
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'off');
  await fakeRepo.repository.setMeta(
    'ai_server_queued',
    JSON.stringify(['bm-1', 'bm-2']),
  );
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Off — never auto-suggest')).toBeTruthy());
  await waitFor(() => expect(screen.getAllByText('AI suggestions')).toHaveLength(2));
  expect(
    screen.getByText(
      '2 bookmarks · AI suggestions are off — only already-queued items keep processing',
    ),
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
