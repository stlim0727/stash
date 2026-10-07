import { fireEvent, render } from '@testing-library/react-native';
import { AccountLibraryNotice } from '@/ui/AccountLibraryNotice';

test('verification failure offers retry; preserved device copies do not claim cloud completion', async () => {
  const retry = jest.fn();
  const screen = await render(<AccountLibraryNotice state="error" transferredCount={2} onRetry={retry} onSettings={() => {}} />);
  expect(screen.getByText('Couldn’t load your bookmarks. Try again.')).toBeTruthy();
  expect(screen.getByText('Kept your 2 existing bookmarks on this device when you signed in.')).toBeTruthy();
  expect(screen.queryByText('Sync complete')).toBeNull();
  await fireEvent.press(screen.getByText('Retry'));
  expect(retry).toHaveBeenCalledTimes(1);
});

test('paused and offline loading explain the wait and do not offer a futile retry', async () => {
  const resume = jest.fn();
  const screen = await render(<AccountLibraryNotice state="checking" paused resumeHere onRetry={() => {}} onSettings={resume} />);
  expect(screen.getByText('Sync paused')).toBeTruthy();
  await fireEvent.press(screen.getByText('Resume sync'));
  expect(resume).toHaveBeenCalledTimes(1);
  await screen.rerender(<AccountLibraryNotice state="error" offline onRetry={() => {}} onSettings={resume} />);
  expect(screen.getByText('Will sync automatically when connected')).toBeTruthy();
  expect(screen.queryByText('Retry')).toBeNull();
});


test('the sign-in result can be acknowledged independently of sync completion', async () => {
  const dismiss = jest.fn();
  const screen = await render(<AccountLibraryNotice state="ready" transferredCount={1} onDismiss={dismiss} onRetry={() => {}} onSettings={() => {}} />);
  await fireEvent.press(screen.getByText('OK'));
  expect(dismiss).toHaveBeenCalledTimes(1);
});
