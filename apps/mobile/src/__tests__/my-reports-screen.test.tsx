import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

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
  status: 'anonymous' as 'anonymous' | 'not_configured',
  session: mockSession as typeof mockSession | null,
  isSignedIn: true,
  ensureAnonymousSession: async () => mockSession,
};

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => mockAuth,
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

import MyReportsScreen from '@/app/my-reports';
import type { TesterReport } from '@/domain/feedback';

beforeEach(() => {
  mockAuth = {
    status: 'anonymous',
    session: mockSession,
    isSignedIn: true,
    ensureAnonymousSession: async () => mockSession,
  };
});

function reportFixture(overrides: Partial<TesterReport> = {}): TesterReport {
  return {
    id: 'r1',
    category: 'bug',
    message: 'Sync looked stuck',
    status: 'resolved',
    statusLabel: 'Resolved',
    developerReply: 'We pushed a fix.',
    resolution: 'Fixed in 0.2.1',
    attachmentCount: 2,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T02:00:00.000Z',
    ...overrides,
  };
}

test('renders a report with its status, reply, resolution and attachment count', async () => {
  const listMyReports = jest.fn(async () => [reportFixture()]);
  const createApi = jest.fn(() => ({ listMyReports, submitReport: jest.fn() }));

  const screen = await render(<MyReportsScreen createApi={createApi as never} />);

  await waitFor(() => expect(screen.getByText('Sync looked stuck')).toBeTruthy());
  expect(createApi).toHaveBeenCalledWith(mockSession);
  expect(screen.getByLabelText('Status Resolved')).toBeTruthy();
  expect(screen.getByText('We pushed a fix.')).toBeTruthy();
  expect(screen.getByText('Fixed in 0.2.1')).toBeTruthy();
  expect(screen.getByText('2 attachments')).toBeTruthy();
});

test('shows an empty state when there are no reports', async () => {
  const listMyReports = jest.fn(async () => []);
  const createApi = jest.fn(() => ({ listMyReports, submitReport: jest.fn() }));

  const screen = await render(<MyReportsScreen createApi={createApi as never} />);

  await waitFor(() => expect(screen.getByText(/haven’t sent any reports yet/)).toBeTruthy());
});

test('surfaces an error with a retry affordance', async () => {
  const listMyReports = jest.fn(async () => {
    throw new Error('network down');
  });
  const createApi = jest.fn(() => ({ listMyReports, submitReport: jest.fn() }));

  const screen = await render(<MyReportsScreen createApi={createApi as never} />);

  await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
  expect(screen.getByLabelText('Retry loading reports')).toBeTruthy();
});
