import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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
    isSignedIn: false,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => '/settings',
}));

// Mutable, per-test-controllable stand-ins for the two independent opt-in
// layers this screen wires together — the base sanitized analytics client and
// the full PostHog SDK (session replay/heatmaps/flags/surveys). Mocked at the
// module boundary (mirroring share-intent-handler.test.tsx's `useAnalytics`
// mock) so cascade behavior between them is deterministic and doesn't depend
// on real network/storage plumbing.
const mockAnalyticsSetEnabled = jest.fn(async () => {});
const mockAnalyticsState = { enabled: false, ready: true };
jest.mock('@/analytics/provider', () => ({
  useAnalytics: () => ({
    ...mockAnalyticsState,
    setEnabled: mockAnalyticsSetEnabled,
    capture: jest.fn(),
    flush: jest.fn(async () => {}),
  }),
}));

const mockSessionReplaySetEnabled = jest.fn(async () => {});
const mockSessionReplayState = { enabled: false, ready: true, configured: true };
jest.mock('@/analytics-full/posthog-full-runtime', () => ({
  usePostHogFull: () => ({
    ...mockSessionReplayState,
    setEnabled: mockSessionReplaySetEnabled,
  }),
}));

import SettingsScreen from '@/app/settings';
import { BookmarksProvider } from '@/store/bookmarks';

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAnalyticsSetEnabled.mockClear().mockResolvedValue(undefined);
  mockSessionReplaySetEnabled.mockClear().mockResolvedValue(undefined);
  mockAnalyticsState.enabled = false;
  mockAnalyticsState.ready = true;
  mockSessionReplayState.enabled = false;
  mockSessionReplayState.ready = true;
  mockSessionReplayState.configured = true;
});

test('the session replay row is hidden entirely in a build with no full-SDK build gate', async () => {
  mockAnalyticsState.enabled = true;
  mockSessionReplayState.configured = false;
  const screen = await renderSettings();

  await waitFor(() => expect(screen.getByText('Share privacy-safe usage analytics')).toBeTruthy());
  expect(screen.queryByLabelText('Enable session replay & feature previews')).toBeNull();
});

test('the session replay row is disabled and off while base analytics is off', async () => {
  const screen = await renderSettings();

  await waitFor(() =>
    expect(
      screen.getByText('Off — no session recording, surveys, or experiment targeting'),
    ).toBeTruthy(),
  );
  const toggle = screen.getByLabelText('Enable session replay & feature previews');
  expect(toggle.props.disabled).toBe(true);
  expect(toggle.props.value).toBe(false);
});

test('the session replay row is interactive once base analytics is on', async () => {
  mockAnalyticsState.enabled = true;
  const screen = await renderSettings();

  const toggle = await waitFor(() =>
    screen.getByLabelText('Enable session replay & feature previews'),
  );
  expect(toggle.props.disabled).not.toBe(true);

  await act(async () => {
    fireEvent(toggle, 'valueChange', true);
  });

  expect(mockSessionReplaySetEnabled).toHaveBeenCalledWith(true);
});

test('turning off base analytics cascades to turn off session replay', async () => {
  mockAnalyticsState.enabled = true;
  mockSessionReplayState.enabled = true;
  const screen = await renderSettings();

  const analyticsToggle = await waitFor(() =>
    screen.getByLabelText('Share privacy-safe usage analytics'),
  );

  await act(async () => {
    fireEvent(analyticsToggle, 'valueChange', false);
  });

  expect(mockAnalyticsSetEnabled).toHaveBeenCalledWith(false);
  await waitFor(() => expect(mockSessionReplaySetEnabled).toHaveBeenCalledWith(false));
});

test('turning session replay on never touches the base analytics toggle', async () => {
  mockAnalyticsState.enabled = true;
  const screen = await renderSettings();

  const toggle = await waitFor(() =>
    screen.getByLabelText('Enable session replay & feature previews'),
  );

  await act(async () => {
    fireEvent(toggle, 'valueChange', true);
  });

  expect(mockSessionReplaySetEnabled).toHaveBeenCalledWith(true);
  expect(mockAnalyticsSetEnabled).not.toHaveBeenCalled();
});

test('the honest, distinct copy for the session replay toggle renders', async () => {
  mockAnalyticsState.enabled = true;
  mockSessionReplayState.enabled = true;
  const screen = await renderSettings();

  await waitFor(() =>
    expect(
      screen.getByText(
        'Records anonymized screen sessions (with bookmark text and images hidden) and enables in-app surveys and experimental features',
      ),
    ).toBeTruthy(),
  );
});
