import { useEffect, useState } from 'react';

/**
 * Returns a copy of `value` that only updates after it has stopped changing for
 * `delayMs`. The source value (e.g. a controlled `TextInput`'s text) stays
 * instant for echoing keystrokes; the debounced copy is what should drive
 * expensive derived work (filtering, sorting) so it runs once per typing pause
 * rather than once per keystroke.
 *
 * Pure React (no native imports) so it loads in the component test lane.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
