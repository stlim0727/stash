import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SplashCoordinator,
  type SplashCoordinatorDeps,
} from '@/ui/splash-coordinator';

function makeCoordinator(overrides: Partial<SplashCoordinatorDeps> = {}) {
  let hiddenCalls = 0;
  const hideAsync = async () => {
    hiddenCalls += 1;
    return true;
  };
  const coordinator = new SplashCoordinator({
    hideAsync,
    ...overrides,
  });
  return {
    coordinator,
    getHiddenCalls: () => hiddenCalls,
  };
}

test('inbox route holds splash until both store and inbox layout are ready', async () => {
  const { coordinator, getHiddenCalls } = makeCoordinator();
  coordinator.updateRoute('/');

  // Step 1: Store finishes loading
  coordinator.updateStoreStatus({ isLoading: false, loadError: false });
  assert.equal(coordinator.isDismissed(), false);
  assert.equal(getHiddenCalls(), 0);

  // Step 2: Inbox layout preferences finish loading and commit
  coordinator.signalInboxReady();
  assert.equal(coordinator.isDismissed(), true);
  assert.equal(coordinator.getDismissReason(), 'inbox_ready');
  assert.equal(getHiddenCalls(), 1);

  // Idempotent: subsequent signals do not call hide again
  coordinator.signalInboxReady();
  assert.equal(getHiddenCalls(), 1);
});

test('non-inbox route dismisses as soon as store settles without waiting for inbox', async () => {
  const { coordinator, getHiddenCalls } = makeCoordinator();
  coordinator.updateRoute('/bookmark/test-id');

  coordinator.updateStoreStatus({ isLoading: false, loadError: false });
  assert.equal(coordinator.isDismissed(), true);
  assert.equal(coordinator.getDismissReason(), 'route_ready');
  assert.equal(getHiddenCalls(), 1);
});

test('route change to non-inbox dismisses once store is ready', async () => {
  const { coordinator, getHiddenCalls } = makeCoordinator();
  coordinator.updateRoute('/');
  coordinator.updateStoreStatus({ isLoading: false, loadError: false });
  assert.equal(coordinator.isDismissed(), false);

  // Navigation redirects to deep link before inbox layout commits
  coordinator.updateRoute('/add');
  assert.equal(coordinator.isDismissed(), true);
  assert.equal(coordinator.getDismissReason(), 'route_ready');
  assert.equal(getHiddenCalls(), 1);
});

test('terminal store failure dismisses splash immediately to reveal error UI', async () => {
  const { coordinator, getHiddenCalls } = makeCoordinator();
  coordinator.updateRoute('/');

  coordinator.updateStoreStatus({ isLoading: false, loadError: true });
  assert.equal(coordinator.isDismissed(), true);
  assert.equal(coordinator.getDismissReason(), 'storage_error');
  assert.equal(getHiddenCalls(), 1);
});

test('stalled hydration watchdog dismisses splash after timeout bound', async () => {
  let scheduledCb: (() => void) | null = null;
  const setTimeoutFn = (cb: () => void) => {
    scheduledCb = cb;
    return 123 as unknown as ReturnType<typeof setTimeout>;
  };
  let cancelledHandle: unknown = null;
  const clearTimeoutFn = (handle: unknown) => {
    cancelledHandle = handle;
  };

  const { coordinator, getHiddenCalls } = makeCoordinator({
    maxHoldMs: 3000,
    setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
    clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
  });

  coordinator.startWatchdog();
  assert.equal(coordinator.isDismissed(), false);
  assert.ok(scheduledCb !== null);

  // Fire the watchdog timer (simulating timeout)
  (scheduledCb as () => void)();
  assert.equal(coordinator.isDismissed(), true);
  assert.equal(coordinator.getDismissReason(), 'timeout');
  assert.equal(getHiddenCalls(), 1);
});

test('normal readiness disarms watchdog before timeout', async () => {
  let cancelledHandle: unknown = null;
  const setTimeoutFn = () => 456 as unknown as ReturnType<typeof setTimeout>;
  const clearTimeoutFn = (handle: unknown) => {
    cancelledHandle = handle;
  };

  const { coordinator } = makeCoordinator({
    maxHoldMs: 3000,
    setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
    clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
  });

  coordinator.startWatchdog();
  coordinator.updateRoute('/');
  coordinator.updateStoreStatus({ isLoading: false, loadError: false });
  coordinator.signalInboxReady();

  assert.equal(coordinator.isDismissed(), true);
  assert.equal(cancelledHandle, 456);
});

test('hideAsync error is caught safely without re-throwing', async () => {
  const failingHide = async () => {
    throw new Error('Native splash error');
  };
  const coordinator = new SplashCoordinator({ hideAsync: failingHide });
  coordinator.updateRoute('/add');
  // Should not throw
  await coordinator.hideSplash('route_ready');
  assert.equal(coordinator.isDismissed(), true);
});

test('markAppLoaded is invoked after splash hide settles', async () => {
  let appLoadedCalls = 0;
  const coordinator = new SplashCoordinator({
    hideAsync: async () => true,
    markAppLoaded: () => {
      appLoadedCalls += 1;
    },
  });

  coordinator.updateRoute('/');
  coordinator.updateStoreStatus({ isLoading: false, loadError: false });
  coordinator.signalInboxReady();

  // Allow async hide to settle
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(coordinator.isDismissed(), true);
  assert.equal(appLoadedCalls, 1);
});

test('markAppLoaded is invoked even when hideAsync throws', async () => {
  let appLoadedCalls = 0;
  const coordinator = new SplashCoordinator({
    hideAsync: async () => {
      throw new Error('splash hide failed');
    },
    markAppLoaded: () => {
      appLoadedCalls += 1;
    },
  });

  await coordinator.hideSplash('timeout');
  assert.equal(coordinator.isDismissed(), true);
  assert.equal(appLoadedCalls, 1);
});

test('startWatchdog is idempotent and does not create duplicate timers', () => {
  let timersCreated = 0;
  const setTimeoutFn = () => {
    timersCreated += 1;
    return 101 as unknown as ReturnType<typeof setTimeout>;
  };

  const coordinator = new SplashCoordinator({
    setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
  });

  coordinator.startWatchdog();
  coordinator.startWatchdog();
  coordinator.startWatchdog();

  assert.equal(timersCreated, 1);
});

test('signalUpdateRequired dismisses splash immediately with update_required reason', async () => {
  const { coordinator, getHiddenCalls } = makeCoordinator();
  coordinator.updateRoute('/');
  coordinator.signalUpdateRequired();

  assert.equal(coordinator.isDismissed(), true);
  assert.equal(coordinator.getDismissReason(), 'update_required');
  assert.equal(getHiddenCalls(), 1);
});
