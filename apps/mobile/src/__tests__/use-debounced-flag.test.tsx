import { act, renderHook } from '@testing-library/react-native';

import { useDebouncedFlag } from '@/hooks/useDebouncedFlag';

// docs/design/settings-activity-status.md §2.1: "show instantly, hide
// patiently" — the show edge (0 → positive) must have zero delay, and the
// hide edge (positive → 0) must hold for hideDelayMs, resetting on any flap
// back to true before it elapses.

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('shows instantly when raw flips false -> true (no delay on the show edge)', async () => {
  const { result, rerender } = await renderHook<boolean, { raw: boolean }>(
    ({ raw }) => useDebouncedFlag(raw, { hideDelayMs: 2000 }),
    { initialProps: { raw: false } },
  );
  expect(result.current).toBe(false);

  await act(async () => {
    rerender({ raw: true });
  });

  // No timer advance at all — the show edge must be immediate.
  expect(result.current).toBe(true);
});

test('holds the previous true for hideDelayMs before hiding, then hides once elapsed', async () => {
  const { result, rerender } = await renderHook<boolean, { raw: boolean }>(
    ({ raw }) => useDebouncedFlag(raw, { hideDelayMs: 2000 }),
    { initialProps: { raw: true } },
  );
  expect(result.current).toBe(true);

  await act(async () => {
    rerender({ raw: false });
  });
  // Still visible immediately after the count drops to zero.
  expect(result.current).toBe(true);

  await act(async () => {
    jest.advanceTimersByTime(1999);
  });
  expect(result.current).toBe(true);

  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(result.current).toBe(false);
});

test('a flap back to true before the hide delay elapses resets the timer and never hides', async () => {
  const { result, rerender } = await renderHook<boolean, { raw: boolean }>(
    ({ raw }) => useDebouncedFlag(raw, { hideDelayMs: 2000 }),
    { initialProps: { raw: true } },
  );

  await act(async () => {
    rerender({ raw: false });
  });
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });
  expect(result.current).toBe(true);

  // The count flaps back to positive before the 2s hide delay elapses.
  await act(async () => {
    rerender({ raw: true });
  });
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });
  // Still visible — a rapid flap must never surface as a hide.
  expect(result.current).toBe(true);

  // Only after a FULL fresh 2s of sustained zero does it finally hide.
  await act(async () => {
    rerender({ raw: false });
  });
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(result.current).toBe(false);
});
