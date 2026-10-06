import { render, waitFor } from '@testing-library/react-native';

let mockPathname = '/';
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
}));

let mockStoreState = {
  isLoading: true,
  loadError: false,
};
jest.mock('@/store/bookmarks', () => ({
  useBookmarks: () => mockStoreState,
}));

import { splashCoordinator } from '@/ui/splash-coordinator';
import { SplashReadinessObserver } from '@/ui/SplashReadinessObserver';

describe('SplashReadinessObserver', () => {
  beforeEach(() => {
    mockPathname = '/';
    mockStoreState = { isLoading: true, loadError: false };
    splashCoordinator.resetForTesting();
  });

  afterEach(() => {
    splashCoordinator.resetForTesting();
  });

  test('holds splash on inbox route until both store and inbox signals ready', async () => {
    const hideSpy = jest.spyOn(splashCoordinator, 'hideSplash');
    const screen = await render(<SplashReadinessObserver />);

    expect(splashCoordinator.isDismissed()).toBe(false);

    // Store resolves
    mockStoreState = { isLoading: false, loadError: false };
    screen.rerender(<SplashReadinessObserver />);

    // Still holds because inbox layout hasn't committed
    expect(splashCoordinator.isDismissed()).toBe(false);

    // Inbox layout commits with restored preferences
    splashCoordinator.signalInboxReady();

    await waitFor(() => expect(splashCoordinator.isDismissed()).toBe(true));
    expect(splashCoordinator.getDismissReason()).toBe('inbox_ready');
    expect(hideSpy).toHaveBeenCalledWith('inbox_ready');

    await screen.unmount();
    hideSpy.mockRestore();
  });

  test('dismisses immediately for non-inbox deep link once store is ready', async () => {
    mockPathname = '/bookmark/test-bookmark-id';
    const hideSpy = jest.spyOn(splashCoordinator, 'hideSplash');

    const screen = await render(<SplashReadinessObserver />);
    expect(splashCoordinator.isDismissed()).toBe(false);

    // Store resolves
    mockStoreState = { isLoading: false, loadError: false };
    screen.rerender(<SplashReadinessObserver />);

    // Dismisses right away without waiting for inbox preferences
    await waitFor(() => expect(splashCoordinator.isDismissed()).toBe(true));
    expect(splashCoordinator.getDismissReason()).toBe('route_ready');
    expect(hideSpy).toHaveBeenCalledWith('route_ready');

    await screen.unmount();
    hideSpy.mockRestore();
  });

  test('dismisses immediately on terminal store failure', async () => {
    const hideSpy = jest.spyOn(splashCoordinator, 'hideSplash');

    mockStoreState = { isLoading: false, loadError: true };
    const screen = await render(<SplashReadinessObserver />);

    await waitFor(() => expect(splashCoordinator.isDismissed()).toBe(true));
    expect(splashCoordinator.getDismissReason()).toBe('storage_error');
    expect(hideSpy).toHaveBeenCalledWith('storage_error');

    await screen.unmount();
    hideSpy.mockRestore();
  });

  test('unmounting observer disarms watchdog cleanly', async () => {
    const disarmSpy = jest.spyOn(splashCoordinator, 'disarmWatchdog');
    const screen = await render(<SplashReadinessObserver />);

    await screen.unmount();
    expect(disarmSpy).toHaveBeenCalled();
    disarmSpy.mockRestore();
  });
});
