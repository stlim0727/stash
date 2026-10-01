import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { LibraryStatus } from '@/ui/LibraryStatus';
import { readDurableBookmarks } from '@/storage/durable-snapshot';
import { makeStoredBookmark } from './helpers/fake-repository';
import type { LocalPendingBookmark } from '@/domain/types';

jest.mock('@/storage/durable-snapshot', () => ({ readDurableBookmarks: jest.fn() }));
const read = readDurableBookmarks as jest.Mock;
const bookmarks = [makeStoredBookmark({ title: 'Durability matters' })];
const props = { inline: true, bookmarks, queue: [] as LocalPendingBookmark[], authStatus: 'anonymous', loading: false,
  loadError: false, syncing: false, retry: jest.fn(), signIn: jest.fn() };
beforeEach(() => { read.mockReset(); props.retry.mockClear(); props.signIn.mockClear(); });

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

test('pending uploads, failed retry, and expired sign-in use one library banner', async () => {
  const queue = [{ local_id: bookmarks[0].id, sync_status: 'pending' }] as LocalPendingBookmark[];
  const screen = await render(<LibraryStatus {...props} authStatus="authenticated" queue={queue} />);
  expect(screen.getByTestId('library-status-inline')).toBeTruthy();
  expect(screen.queryByTestId('library-status')).toBeNull();
  await screen.rerender(<LibraryStatus {...props} inline={false} authStatus="authenticated" queue={[{ ...queue[0], sync_status: 'failed' }]} />);
  await fireEvent.press(screen.getByText('Retry'));
  expect(props.retry).toHaveBeenCalledTimes(1);
  expect(screen.getAllByTestId('library-status')).toHaveLength(1);
  await screen.rerender(<LibraryStatus {...props} inline={false} authStatus="session_expired" />);
  expect(screen.getByText('Sign in to resume sync')).toBeTruthy();
  await fireEvent.press(screen.getByText('Sign In'));
  expect(props.signIn).toHaveBeenCalledTimes(1);
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
