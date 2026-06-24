import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@/storage/repository', () => {
  const { createFakeRepositoryModule } = require('./helpers/fake-repository');
  return createFakeRepositoryModule();
});

const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

import { SHARE_CONFIRM_PREF_KEY } from '@/domain/share-confirm';
import { ShareConfirmHandler } from '@/share/share-confirm-handler';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

const tree = (
  <CaptureToastProvider>
    <ShareConfirmHandler />
  </CaptureToastProvider>
);

beforeEach(async () => {
  mockRouter.replace.mockClear();
  // Clear any record the meta store carried over from a previous test.
  await fakeRepo.repository.setMeta(SHARE_CONFIRM_PREF_KEY, JSON.stringify({ savedCount: 0 }));
});

describe('ShareConfirmHandler', () => {
  it('confirms a pending toast-mode save on the next open, without navigating', async () => {
    // Two saves piled up while the app was away (each Android share saved and
    // exited on its own); reopening surfaces a single combined confirmation.
    await fakeRepo.repository.setMeta(SHARE_CONFIRM_PREF_KEY, JSON.stringify({ savedCount: 2 }));

    const { findByText } = await render(tree);

    // The confirmation appears on whatever screen we landed on — it does not
    // pull the user to the Inbox by itself.
    await findByText('2 saved to Stash');
    expect(mockRouter.replace).not.toHaveBeenCalled();

    // The record is drained so a later open won't re-confirm the same saves.
    await waitFor(async () =>
      expect(await fakeRepo.repository.getMeta(SHARE_CONFIRM_PREF_KEY)).toBe(
        JSON.stringify({ savedCount: 0 }),
      ),
    );
  });

  it('its "View" shortcut jumps to the Inbox only when tapped', async () => {
    await fakeRepo.repository.setMeta(SHARE_CONFIRM_PREF_KEY, JSON.stringify({ savedCount: 1 }));

    const { findByText } = await render(tree);

    const view = await findByText('View');
    expect(mockRouter.replace).not.toHaveBeenCalled();

    // The press bubbles from the label up to the enclosing Pressable.
    await act(async () => {
      fireEvent.press(view);
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
  });

  it('shows nothing when no share is pending', async () => {
    const { queryByText } = await render(tree);

    // Let the mount-time check resolve, then confirm no toast surfaced.
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByText('View')).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});
