import { useEffect, useState } from 'react';

/**
 * A boolean that tracks `raw` asymmetrically — "show instantly, hide
 * patiently":
 *  - 0 → positive (raw becomes true): updates immediately, no delay. A real
 *    state change should never feel laggy.
 *  - positive → 0 (raw becomes false): holds the previous `true` for
 *    `hideDelayMs` before flipping, and the timer resets every time `raw`
 *    goes back to true before it elapses.
 *
 * Used to debounce status-chip visibility (Settings' Activity strip, see
 * docs/design/settings-activity-status.md §2.1) so a rapid flap in an
 * underlying count never surfaces as a chip mount/unmount — the chip only
 * actually disappears after `hideDelayMs` of sustained zero.
 *
 * Pure React (no native imports) so it loads in the component test lane.
 */
export function useDebouncedFlag(raw: boolean, options: { hideDelayMs: number }): boolean {
  const { hideDelayMs } = options;
  const [visible, setVisible] = useState(raw);

  useEffect(() => {
    if (raw) {
      setVisible(true);
      return;
    }
    const handle = setTimeout(() => setVisible(false), hideDelayMs);
    return () => clearTimeout(handle);
  }, [raw, hideDelayMs]);

  return visible;
}
