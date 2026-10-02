import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { SyncDiagnostics } from '@/ui/SyncDiagnostics';
import type { PullAttemptDiagnostics } from '@/domain/pull-diagnostics';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const error = 'Supabase returned a non-array response from /rest/v1/bookmark_tags?select=*\n' + 'long-error-details '.repeat(40);
const attempts: PullAttemptDiagnostics[] = Array.from({ length: 5 }, (_, index) => ({
  timestamp: `2026-10-02T03:${String(57 - index).padStart(2, '0')}:00Z`,
  since: null, fullRefreshReason: null, remoteRowCount: 1,
  durationMs: 240, outcome: index === 1 ? 'failure' : 'success',
  ...(index === 1 ? { errorMessage: error } : {}),
}));
const defaults = { status: 'No cloud sync work outstanding', lastPulledAt: attempts[0].timestamp,
  remaining: 0, recentPulls: attempts, onReport: jest.fn(), reporting: false };

test('current state is separate from historical failures and only three pulls show initially', async () => {
  const screen = await render(<SyncDiagnostics {...defaults} />);
  expect(screen.getByTestId('diagnostics-current-status').props.children).toBe(defaults.status);
  expect(screen.getAllByText('Pull succeeded')).toHaveLength(2);
  expect(screen.getByText('A later pull succeeded · view earlier error')).toBeTruthy();
  expect(screen.queryByText(error)).toBeNull();
  await fireEvent.press(screen.getByText('Show all 5 pulls'));
  expect(screen.getAllByText('Pull succeeded')).toHaveLength(4);
  await fireEvent.press(screen.getByText('Show fewer pulls'));
  expect(screen.getAllByText('Pull succeeded')).toHaveLength(2);
});

test('an expanded error is complete, selectable, copyable, and links to reporting', async () => {
  const onReport = jest.fn();
  const screen = await render(<SyncDiagnostics {...defaults} onReport={onReport} />);
  await fireEvent.press(screen.getByText('Pull failed'));
  const full = screen.getByTestId('pull-error-full');
  expect(full.props.children).toBe(error);
  expect(full.props.selectable).toBe(true);
  expect(full.props.numberOfLines).toBeUndefined();
  await fireEvent.press(screen.getByText('Copy error'));
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith(error));
  await fireEvent.press(screen.getByText('Report a problem'));
  expect(onReport).toHaveBeenCalledTimes(1);
});

test('a failed latest pull does not claim recovery, and a historical success cannot overwrite current attention', async () => {
  const screen = await render(<SyncDiagnostics {...defaults} status="Sync needs attention" recentPulls={[attempts[1], attempts[0]]} />);
  expect(screen.getByTestId('diagnostics-current-status').props.children).toBe('Sync needs attention');
  expect(screen.queryByText('A later pull succeeded · view earlier error')).toBeNull();
  expect(screen.getByText('View error details')).toBeTruthy();
});

test('empty history and no successful pull do not invent a completion', async () => {
  const screen = await render(<SyncDiagnostics {...defaults} lastPulledAt={null} recentPulls={[]} />);
  expect(screen.getByText('No successful pull recorded yet')).toBeTruthy();
  expect(screen.getByText('None yet')).toBeTruthy();
  expect(screen.queryByText('Pull succeeded')).toBeNull();
});
