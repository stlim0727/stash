import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { LibraryStatus } from '@/ui/LibraryStatus';
import { readDurableBookmarks } from '@/storage/durable-snapshot';
import { makeStoredBookmark } from './helpers/fake-repository';
import type { LocalPendingBookmark } from '@/domain/types';

jest.mock('@/storage/durable-snapshot', () => ({ readDurableBookmarks: jest.fn() }));
const read = readDurableBookmarks as jest.Mock;
const bookmarks = [makeStoredBookmark({ title: 'Durability matters' })];
const props = { inline: true, bookmarks, queue: [] as LocalPendingBookmark[], authStatus: 'anonymous', loading: false,
  loadError: false, syncing: false, signIn: jest.fn() };
beforeEach(() => { read.mockReset(); props.signIn.mockClear(); });
afterEach(() => jest.useRealTimers());
const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); };

test('guest persistence is claimed only after a matching durable read', async () => {
  let finish: (value: typeof bookmarks | null) => void = () => {};
  read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const screen = await render(<LibraryStatus {...props} />);
  expect(screen.queryByText('· Saved on this device')).toBeNull();
  await waitFor(() => expect(read).toHaveBeenCalled());
  finish(bookmarks);
  await waitFor(() => expect(screen.getByText('· Saved on this device')).toBeTruthy());
});

test.each([null, [], [makeStoredBookmark({ title: 'Older persisted contents' })]])('memory fallback or stale snapshot makes no persistence claim (%p)', async (snapshot) => {
  read.mockResolvedValue(snapshot);
  const screen = await render(<LibraryStatus {...props} />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  expect(screen.queryByText('· Saved on this device')).toBeNull();
});

test('short work stays hidden; a multi-item flow holds one status and completion switches to new work in place', async () => {
  jest.useFakeTimers();
  const queue = [{ local_id: bookmarks[0].id, sync_status: 'pending' }, { local_id: 'second', sync_status: 'pending' }] as LocalPendingBookmark[];
  const screen = await render(<LibraryStatus {...props} authStatus="authenticated" queue={queue} />);
  expect(screen.queryByTestId('library-status-inline')).toBeNull();
  await advance(1499);
  expect(screen.queryByTestId('library-status-inline')).toBeNull();
  await advance(1);
  expect(screen.getByTestId('library-status-inline')).toBeTruthy();
  expect(screen.getByText('· Syncing')).toBeTruthy();
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" queue={[queue[1]]} />);
  expect(screen.getByText('· Syncing')).toBeTruthy();
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" />);
  expect(screen.getByText('· Sync complete')).toBeTruthy();
  await advance(1000);
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" queue={queue} />);
  expect(screen.getByText('· Syncing')).toBeTruthy();
  expect(screen.queryByText('· Sync complete')).toBeNull();
  expect(screen.queryByTestId('library-status')).toBeNull();
});

test('brief uploads show neither activity nor completion; held completion eventually disappears', async () => {
  jest.useFakeTimers();
  const screen = await render(<LibraryStatus {...props} authStatus="authenticated" syncing />);
  await advance(500);
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" />);
  expect(screen.queryByTestId('library-status-inline')).toBeNull();
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" syncing />);
  await advance(1500);
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" />);
  await advance(2499);
  expect(screen.getByText('· Sync complete')).toBeTruthy();
  await advance(1);
  expect(screen.queryByTestId('library-status-inline')).toBeNull();
});

test('transient failures quietly wait, then show delay without requiring a manual retry', async () => {
  jest.useFakeTimers();
  const queue = [{ local_id: 'a', sync_status: 'failed', last_error_kind: 'transient_dns', retry_count: 10 }] as LocalPendingBookmark[];
  const screen = await render(<LibraryStatus {...props} authStatus="authenticated" queue={queue} />);
  await advance(14999);
  expect(screen.queryByTestId('library-status-inline')).toBeNull();
  await advance(1);
  expect(screen.getByText('· Sync delayed · retrying automatically')).toBeTruthy();
  await screen.rerender(<LibraryStatus {...props} inline={false} authStatus="authenticated" queue={queue} />);
  expect(screen.queryByText('Retry')).toBeNull();
  expect(screen.queryByTestId('library-status')).toBeNull();
});

test('actionable errors and expired sign-in use one library banner with the relevant action', async () => {
  const queue = [{ local_id: 'a', sync_status: 'failed', last_error_kind: 'permission' }] as LocalPendingBookmark[];
  const screen = await render(<LibraryStatus {...props} inline={false} authStatus="authenticated" queue={queue} />);
  expect(screen.getByText('Sync access denied. Review your account permissions.')).toBeTruthy();
  await fireEvent.press(screen.getByText('View sync details'));
  expect(props.signIn).toHaveBeenCalledTimes(1);
  expect(screen.getAllByTestId('library-status')).toHaveLength(1);
  await screen.rerender(<LibraryStatus {...props} inline={false} authStatus="session_expired" />);
  expect(screen.getByText('Sign in to resume sync')).toBeTruthy();
  await fireEvent.press(screen.getByText('Sign In'));
  expect(props.signIn).toHaveBeenCalledTimes(2);
});

test('offline and pause override completion immediately; an account change cancels the prior history', async () => {
  jest.useFakeTimers();
  const screen = await render(<LibraryStatus {...props} authStatus="authenticated" syncing scopeKey="account-a" />);
  await advance(1500);
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" scopeKey="account-a" />);
  expect(screen.getByText('· Sync complete')).toBeTruthy();
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" scopeKey="account-a" flow={{ phase: 'offline', remaining: 1 }} />);
  expect(screen.getByText('· Will sync automatically when connected')).toBeTruthy();
  expect(screen.queryByText('· Sync complete')).toBeNull();
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" scopeKey="account-a" paused />);
  expect(screen.getByText('· Sync paused')).toBeTruthy();
  await screen.rerender(<LibraryStatus {...props} authStatus="authenticated" scopeKey="account-b" />);
  expect(screen.queryByTestId('library-status-inline')).toBeNull();
  await advance(5000);
  expect(screen.queryByTestId('library-status-inline')).toBeNull();
});

test('loading and failed initial storage never assert device persistence', async () => {
  const screen = await render(<LibraryStatus {...props} loading />);
  expect(screen.queryByTestId('library-status')).toBeNull();
  await screen.rerender(<LibraryStatus {...props} loadError />);
  expect(screen.queryByTestId('library-status')).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

test('paused sync directs the user to Settings rather than an ineffective retry', async () => {
  const screen = await render(<LibraryStatus {...props} authStatus="authenticated" paused />);
  expect(screen.getByText('· Sync paused')).toBeTruthy();
  expect(screen.queryByText('Retry')).toBeNull();
  await fireEvent.press(screen.getByText('· Sync paused'));
  expect(props.signIn).toHaveBeenCalledTimes(1);
});

test('paused sync maintains precedence even when failed queue entries exist', async () => {
  const queue = [{ local_id: bookmarks[0].id, sync_status: 'failed' }] as LocalPendingBookmark[];
  const screen = await render(<LibraryStatus {...props} authStatus="authenticated" paused queue={queue} />);
  expect(screen.getByText('· Sync paused')).toBeTruthy();
  expect(screen.queryByTestId('library-status')).toBeNull();
  await screen.rerender(<LibraryStatus {...props} inline={false} authStatus="authenticated" paused queue={queue} />);
  expect(screen.queryByTestId('library-status')).toBeNull();
});


test('a rejected token with an active provider offers sync recovery rather than an unavailable sign-in action', async () => {
  const screen = await render(<LibraryStatus {...props} inline={false} authStatus="authenticated" flow={{ phase: 'sign_in', remaining: 0 }} />);
  expect(screen.queryByText('Sign In')).toBeNull();
  await fireEvent.press(screen.getByText('View sync details'));
  expect(props.signIn).toHaveBeenCalledTimes(1);
});
