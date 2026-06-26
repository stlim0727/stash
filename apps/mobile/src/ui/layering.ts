import type { ViewStyle } from 'react-native';

/**
 * Stacking for an absolutely-positioned overlay that must sit above sibling
 * scroll content for BOTH paint and touch.
 *
 * On iOS `zIndex` governs paint and touch order together. On Android `zIndex`
 * is paint-only — touch dispatch follows native draw order (elevation, then
 * sibling order). A later-mounted full-screen scroll sibling then steals
 * touches over an overlay that set `zIndex` alone, leaving its controls visible
 * but dead. That was STASH-7: the inbox header went unhittable while the tag
 * cloud was open — reported as "not responding except back key".
 *
 * Setting `elevation` to match `zIndex` keeps the overlay on top for touches
 * too. Always stack overlays through this helper so the two can never drift
 * apart again — `scripts/check-overlay-elevation.mjs` enforces it in CI.
 *
 * Elements that intentionally carry their own shadow and rely on sibling order
 * (e.g. the FAB) set `elevation` directly and don't need this — the check only
 * flags `zIndex` without `elevation`, never the reverse.
 */
export function overlayLayer(z: number): Pick<ViewStyle, 'zIndex' | 'elevation'> {
  return { zIndex: z, elevation: z };
}
