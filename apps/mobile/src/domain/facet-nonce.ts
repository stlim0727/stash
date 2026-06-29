/**
 * Monotonic nonce for the "browse a facet" drill-in (tag cloud, bookmark detail).
 *
 * Tapping a tag in `/browse/tags` or a bookmark's detail navigates back to the
 * root Inbox with the facet as a route param plus this nonce. The Inbox dedupes
 * by `(facet + nonce)` so it can tell a fresh user selection (apply the facet)
 * from an unrelated re-focus (leave a hand-changed filter alone).
 *
 * The counter MUST live at module scope, not in a per-screen `useRef`. The
 * drill-in uses `router.dismissTo`, which tears the browse/detail screen down,
 * so a ref re-initializes to 0 on every visit and re-emits the SAME nonce ("1")
 * each time. The Inbox then sees a `(facet + nonce)` key it already consumed and
 * silently skips re-applying — re-selecting the same tag does nothing and shows
 * no filter ribbon (STASH-D). A shared module counter survives those teardowns
 * and never repeats a value within a session, so every selection re-applies.
 *
 * Deterministic (a plain counter, not `Date.now()`), so the value is stable
 * under test and replay; it resets to 0 only on a full JS-context reload, which
 * also resets the Inbox's consumed-nonce ref, keeping the two in lockstep.
 */
let counter = 0;

/** Next monotonic facet nonce, as the string a route param carries. */
export function nextFacetNonce(): string {
  counter += 1;
  return String(counter);
}
