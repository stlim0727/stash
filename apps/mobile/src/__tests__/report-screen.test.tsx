import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const mockSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-test' },
};

let mockAuth = {
  status: 'authenticated' as 'anonymous' | 'authenticated' | 'not_configured',
  session: mockSession as typeof mockSession | null,
  userId: 'user-test' as string | null,
  email: null as string | null,
  isSignedIn: true,
  message: null as string | null,
  ensureAnonymousSession: async () => mockSession,
  signIn: async () => mockSession,
  signOut: async () => {},
};

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => mockAuth,
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

// Keep the store's pull-sync inert so mounting the provider does no network.
jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  return {
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince: empty,
      listBookmarkIds: empty,
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
    }),
  };
});

const mockBack = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  usePathname: () => '/report',
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

const mockWindowSize = { width: 390, height: 844, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowSize,
}));

import ReportScreen from '@/app/report';
import {
  clearPendingFeedbackScreenshot,
  setPendingFeedbackSource,
  setPendingFeedbackScreenshot,
} from '@/feedback/screenshot-session';
import { feedbackSourceFromPath } from '@/feedback/FloatingReportButton';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderReport(createApi?: Parameters<typeof ReportScreen>[0]) {
  return render(
    <BookmarksProvider>
      <ReportScreen {...(createApi ?? {})} />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  fakeRepo.__reset([]);
  clearPendingFeedbackScreenshot();
  mockBack.mockClear();
  mockPush.mockClear();
  mockWindowSize.width = 390;
  mockWindowSize.height = 844;
  mockAuth = {
    status: 'authenticated',
    session: mockSession,
    userId: 'user-test',
    email: null,
    isSignedIn: true,
    message: null,
    ensureAnonymousSession: async () => mockSession,
    signIn: async () => mockSession,
    signOut: async () => {},
  };
});

test('renders the form and shows the privacy note', async () => {
  const screen = await renderReport();

  await waitFor(() => expect(screen.getByLabelText('Problem description')).toBeTruthy());
  expect(screen.getByText(/not your bookmark list/)).toBeTruthy();
  expect(screen.getByLabelText('Toggle diagnostic context preview')).toBeTruthy();
  expect(screen.queryByLabelText('Diagnostic context preview')).toBeNull();
  expect(screen.getByLabelText('Share diagnostics')).toBeTruthy();
  expect(screen.getByTestId('share-diagnostics-icon')).toBeTruthy();
  expect(screen.getByTestId('submit-report-icon')).toBeTruthy();
});

test('wide viewport presents the report form as a side sheet', async () => {
  mockWindowSize.width = 1280;
  const screen = await renderReport();

  await waitFor(() => expect(screen.getByLabelText('Problem description')).toBeTruthy());
  expect(screen.getByTestId('report-sheet-backdrop')).toBeTruthy();
});

test('phone viewport presents the report form full-screen', async () => {
  mockWindowSize.width = 390;
  mockWindowSize.height = 844;
  const screen = await renderReport();

  await waitFor(() => expect(screen.getByLabelText('Problem description')).toBeTruthy());
  expect(screen.queryByTestId('report-sheet-backdrop')).toBeNull();
  const root = screen.getByTestId('report-fullscreen');
  const flat = Array.isArray(root.props.style)
    ? Object.assign({}, ...root.props.style.flat())
    : root.props.style;
  expect(flat.height).toBe(844);
});

test('Submit is disabled until a description is entered', async () => {
  const screen = await renderReport();

  const submit = await waitFor(() => screen.getByLabelText('Submit report'));
  expect(submit.props.accessibilityState?.disabled).toBe(true);

  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'It crashed on launch');

  expect(screen.getByLabelText('Submit report').props.accessibilityState?.disabled).toBe(false);
});

test('submitting calls the feedback api with the message and redacted context', async () => {
  const submitReport = jest.fn(async (_input: unknown) => {});
  const createApi = jest.fn(() => ({ submitReport }));

  const screen = await renderReport({ createApi: createApi as never });

  await waitFor(() => expect(screen.getByLabelText('Problem description')).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'Sync seems stuck');

  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Submit report'));
  });

  expect(createApi).toHaveBeenCalledWith(mockSession);
  expect(submitReport).toHaveBeenCalledTimes(1);
  const arg = submitReport.mock.calls[0]![0] as {
    category: string;
    message: string;
    context: Record<string, unknown>;
  };
  expect(arg.message).toBe('Sync seems stuck');
  expect(arg.category).toBe('bug');
  // Redaction: the diagnostic context only carries operational keys.
  expect(Object.keys(arg.context)).not.toContain('notes');
  expect(arg.context.route).toBe('/report');

  expect(screen.getByText('Thanks — your report was sent.')).toBeTruthy();
});

test('shows a pending screenshot but keeps it excluded until the user opts in', async () => {
  setPendingFeedbackScreenshot({
    dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn',
    mimeType: 'image/jpeg',
    capturedAt: '2026-07-08T10:00:00.000Z',
    platform: 'web',
    surface: 'settings',
  });
  const submitReport = jest.fn(async (_input: unknown) => {});
  const createApi = jest.fn(() => ({ submitReport }));

  const screen = await renderReport({ createApi: createApi as never });

  await waitFor(() => expect(screen.getByLabelText('Include screenshot in report')).toBeTruthy());
  expect(screen.queryByLabelText('Screenshot preview')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Toggle diagnostic context preview'));
  expect(screen.getByLabelText('Diagnostic context preview').props.children).not.toContain(
    'screenshot',
  );

  await fireEvent(screen.getByLabelText('Include screenshot in report'), 'valueChange', true);

  expect(screen.getByLabelText('Screenshot preview')).toBeTruthy();
  expect(screen.getByLabelText('Screenshot preview').props.resizeMode).toBe('contain');
  expect(screen.getByLabelText('Diagnostic context preview').props.children).toContain(
    '[redacted image/jpeg screenshot]',
  );
  expect(screen.getByLabelText('Diagnostic context preview').props.children).not.toContain(
    'ZmFrZS1qcGVn',
  );

  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'Layout looks broken');

  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Submit report'));
  });

  const arg = submitReport.mock.calls[0]![0] as {
    context: { screenshot?: { dataUrl?: string; surface?: string } };
  };
  expect(arg.context.screenshot?.dataUrl).toBe('data:image/jpeg;base64,ZmFrZS1qcGVn');
  expect(arg.context.screenshot?.surface).toBe('settings');
  expect(screen.getByLabelText('Include screenshot in report')).toBeTruthy();
  expect(screen.queryByLabelText('Screenshot preview')).toBeNull();
});

test('keeps the captured screenshot available for a follow-up report on the same screen', async () => {
  setPendingFeedbackSource({ route: '/settings', surface: 'settings' });
  setPendingFeedbackScreenshot({
    dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn',
    mimeType: 'image/jpeg',
    capturedAt: '2026-07-08T10:00:00.000Z',
    platform: 'android',
    surface: 'settings',
  });
  const submitReport = jest.fn(async (_input: unknown) => {});
  const createApi = jest.fn(() => ({ submitReport }));

  const screen = await renderReport({ createApi: createApi as never });

  await waitFor(() => expect(screen.getByLabelText('Include screenshot in report')).toBeTruthy());
  await fireEvent(screen.getByLabelText('Include screenshot in report'), 'valueChange', true);
  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'First issue');

  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Submit report'));
  });

  expect(screen.getByText(/Thanks/)).toBeTruthy();
  expect(screen.getByLabelText('Include screenshot in report')).toBeTruthy();
  expect(screen.queryByLabelText('Screenshot preview')).toBeNull();

  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'Second issue');
  await fireEvent(screen.getByLabelText('Include screenshot in report'), 'valueChange', true);

  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Submit report'));
  });

  const second = submitReport.mock.calls[1]![0] as {
    context: { screenshot?: { dataUrl?: string; surface?: string } };
  };
  expect(second.context.screenshot?.dataUrl).toBe('data:image/jpeg;base64,ZmFrZS1qcGVn');
  expect(second.context.screenshot?.surface).toBe('settings');
});

test('excludes the screenshot when the user turns the screenshot toggle off', async () => {
  setPendingFeedbackSource({ route: '/settings', surface: 'settings' });
  setPendingFeedbackScreenshot({
    dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn',
    mimeType: 'image/jpeg',
    capturedAt: '2026-07-08T10:00:00.000Z',
    platform: 'web',
    surface: 'settings',
  });
  const submitReport = jest.fn(async (_input: unknown) => {});
  const createApi = jest.fn(() => ({ submitReport }));

  const screen = await renderReport({ createApi: createApi as never });

  await waitFor(() => expect(screen.getByLabelText('Include screenshot in report')).toBeTruthy());
  await fireEvent(screen.getByLabelText('Include screenshot in report'), 'valueChange', false);
  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'No screenshot please');

  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Submit report'));
  });

  const arg = submitReport.mock.calls[0]![0] as {
    context: { route?: string; screenshot?: unknown; sourceSurface?: string };
  };
  expect(arg.context.route).toBe('/settings');
  expect(arg.context.sourceSurface).toBe('settings');
  expect(arg.context.screenshot).toBeUndefined();
});

test('coarsens dynamic report source routes before tagging screenshots', () => {
  expect(feedbackSourceFromPath('/bookmark/7e64cf1e-0000-4000-8000-0000000000f1')).toEqual({
    route: '/bookmark/detail',
    surface: 'bookmark_detail',
  });
});

test('editing the message after a successful submit clears the thank-you and re-enables Submit', async () => {
  const submitReport = jest.fn(async (_input: unknown) => {});
  const createApi = jest.fn(() => ({ submitReport }));

  const screen = await renderReport({ createApi: createApi as never });

  await waitFor(() => expect(screen.getByLabelText('Problem description')).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'First report');

  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Submit report'));
  });

  // Thank-you is shown and, with the field cleared, Submit is disabled.
  expect(screen.getByText('Thanks — your report was sent.')).toBeTruthy();
  expect(screen.getByLabelText('Submit report').props.accessibilityState?.disabled).toBe(true);

  // Starting a follow-up report clears the stale banner and re-enables Submit.
  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'A second issue');

  expect(screen.queryByText('Thanks — your report was sent.')).toBeNull();
  expect(screen.getByLabelText('Submit report').props.accessibilityState?.disabled).toBe(false);
});

test('refreshes the session before submitting so an expired token is renewed', async () => {
  // A token that expired while the screen stayed open: ensureAnonymousSession
  // hands back a renewed session, which is what the API must be created with.
  const refreshedSession = { ...mockSession, access_token: 'refreshed-token' };
  mockAuth.ensureAnonymousSession = async () => refreshedSession;

  const submitReport = jest.fn(async (_input: unknown) => {});
  const createApi = jest.fn(() => ({ submitReport }));

  const screen = await renderReport({ createApi: createApi as never });

  await waitFor(() => expect(screen.getByLabelText('Problem description')).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'Token went stale');

  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Submit report'));
  });

  expect(createApi).toHaveBeenCalledWith(refreshedSession);
  expect(submitReport).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Thanks — your report was sent.')).toBeTruthy();
});

test('excludes a permanently-too-long-URL queue entry from queueDepth/lastError (Sentry STASH-2T/2V)', async () => {
  // A stuck create that failed with the permanent url_hash btree error stays
  // in the queue forever by design (settings.tsx's `waiting` already excludes
  // it). Without the same exclusion here, this old, unrelated failure
  // resurfaces on every later report as if the CURRENT share just failed.
  await fakeRepo.repository.enqueue({
    local_id: 'local-stuck',
    remote_id: null,
    operation: 'create',
    payload: { url: 'https://example.com/stuck' },
    sync_status: 'failed',
    retry_count: 3,
    last_error:
      'index row size 2888 exceeds btree version 4 maximum 2704 for index "bookmarks_user_url_hash_active_idx"',
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
  });

  const submitReport = jest.fn(async (_input: unknown) => {});
  const createApi = jest.fn(() => ({ submitReport }));

  const screen = await renderReport({ createApi: createApi as never });

  await waitFor(() => expect(screen.getByLabelText('Problem description')).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'Shared but failed to save');

  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Submit report'));
  });

  const arg = submitReport.mock.calls[0]![0] as {
    context: { queueDepth?: number; lastError?: string };
  };
  expect(arg.context.queueDepth).toBe(0);
  expect(arg.context.lastError).toBeUndefined();
});

test('shows a friendly message when Supabase is not configured', async () => {
  mockAuth = {
    status: 'not_configured',
    session: null,
    userId: null,
    email: null,
    isSignedIn: false,
    message: 'not configured',
    ensureAnonymousSession: async () => null as never,
    signIn: async () => null as never,
    signOut: async () => {},
  } as typeof mockAuth;

  const screen = await renderReport();

  await waitFor(() => expect(screen.getByText('Cloud reporting unavailable')).toBeTruthy());
  expect(screen.queryByLabelText('Submit report')).toBeNull();
  // Even without the cloud, diagnostics can still be shared.
  expect(screen.getByLabelText('Share diagnostics')).toBeTruthy();
});

test('prompts an anonymous session to sign in instead of showing the form', async () => {
  mockAuth = {
    ...mockAuth,
    status: 'anonymous',
  };

  const screen = await renderReport();

  await waitFor(() => expect(screen.getByText('Sign in to submit a report')).toBeTruthy());
  expect(screen.queryByLabelText('Submit report')).toBeNull();
  expect(screen.queryByLabelText('Problem description')).toBeNull();
  // Diagnostics can still be shared without an account.
  expect(screen.getByLabelText('Share diagnostics')).toBeTruthy();

  await fireEvent.press(screen.getByText('Sign In'));
  expect(mockPush).toHaveBeenCalledWith('/settings');
});

test('navigates back after a successful submission after the timeout', async () => {
  jest.useFakeTimers();
  const submitReport = jest.fn(async (_input: unknown) => {});
  const createApi = jest.fn(() => ({ submitReport }));

  const screen = await renderReport({ createApi: createApi as never });

  await waitFor(() => expect(screen.getByLabelText('Problem description')).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText('Problem description'), 'Going back');

  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Submit report'));
  });

  expect(screen.getByText('Thanks — your report was sent.')).toBeTruthy();
  expect(mockBack).not.toHaveBeenCalled();

  // Fast-forward time by 1.5 seconds
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });

  expect(mockBack).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});
