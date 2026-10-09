import {
  nextHeaderCollapseState,
  type HeaderCollapseState
} from '@/domain/header-collapse';
import { queryHasSearchTokens } from '@/domain/search';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { trackBreadcrumb } from '@/observability/sentry';
import { syncFlush } from '@/ui/sync-flush';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import {
  Keyboard,
  Platform,
  TextInput
} from 'react-native';

interface Dependencies {
  lastScrollYRef: RefObject<number>;
  headerCollapseRef: RefObject<HeaderCollapseState>;
  preSearchHeaderCollapseRef: RefObject<HeaderCollapseState>;
  preSearchCollapsibleHeightRef: RefObject<number>;
  collapsibleHeightRef: RefObject<number>;
  setHeaderCollapse: Dispatch<SetStateAction<HeaderCollapseState>>;
}

export function useInboxSearch({
  lastScrollYRef,
  headerCollapseRef,
  preSearchHeaderCollapseRef,
  preSearchCollapsibleHeightRef,
  collapsibleHeightRef,
  setHeaderCollapse,
}: Dependencies) {

  const [query, setQuery] = useState('');
  // The TextInput stays bound to `query` (instant echo), but the derived work —
  // filtering, sorting, the searching flag, the section label — keys off this
  // debounced copy so an O(C) collection lookup per bookmark doesn't re-run on
  // every keystroke and the match count doesn't flicker mid-type.
  const debouncedQuery = useDebouncedValue(query, 140);
  // A query is only a search when it produces at least one real search token. A
  // query that is purely punctuation/symbols ("...", "-", "!!!") normalizes to
  // zero tokens, so `filterBookmarks` returns everything — treating that as a
  // search would mislabel the full library as "Matches (all)". Gate the searching
  // flag on real tokens so such a query falls back to the normal Inbox (recent/
  // facet section + the focus-empty suggestion shelf). `searchTerms`, the site
  // chip / matched-tag reason UI, the empty-search recovery, and the section
  // label all key off this one flag, so they stay consistent.
  const searching = queryHasSearchTokens(debouncedQuery);
  // Latest query for listeners that must not re-subscribe on each keystroke
  // (keyboardDidHide below reads this to decide whether an empty search folds
  // away without re-registering the listener every keystroke).
  const queryRef = useRef(query);
  queryRef.current = query;
  // The field remains visible; this state tracks an active search session
  // so the existing focus, keyboard and header restoration behavior survives.
  const [searchOpen, setSearchOpen] = useState(false);
  // Whether the search field holds focus — drives the suggestion shelf (shown
  // only while focused with an empty query).
  const [searchFocused, setSearchFocused] = useState(false);
  // Tapping a suggestion chip blurs the TextInput FIRST on native (iOS/Android),
  // which would unmount the shelf mid-gesture and drop the tap into the void. So
  // we defer the hide one tick: a chip's onPress runs synchronously before the
  // deferred blur lands, and tag/folder taps (which intentionally blur) cancel
  // the timer and hide immediately. The ref lets us clear a pending hide on
  // re-focus and on unmount so we never setState after teardown.
  const blurHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearBlurHide = useCallback(() => {
    if (blurHideTimer.current !== null) {
      clearTimeout(blurHideTimer.current);
      blurHideTimer.current = null;
    }
  }, []);
  useEffect(() => clearBlurHide, [clearBlurHide]);
  const searchRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  // STASH-33/34/35/36 root cause: the list has `keyboardDismissMode="on-drag"`
  // (below, near the FlatList) so scrolling the results dismisses the
  // keyboard. Opening search from a collapsed header forces a large relayout
  // in the same commit as the field mounting and requesting focus — an
  // incidental drag/scroll landing in that same window (a real finger's
  // residual movement from the opening tap, or scroll produced by the
  // header/list reflow itself) can register as a drag-start on the
  // underlying list and fire that on-drag dismiss milliseconds later. That's
  // indistinguishable at the JS level from a real blur/keyboardDidHide, so it
  // hits the exact same auto-close path every report has shown (confirmed:
  // STASH-37, first report on the build with this fix, showed the field
  // staying open). No local repro ever reproduced this — every synthetic
  // interaction tested (mouse clicks, Playwright's touchscreen.tap(),
  // simulated scroll) is perfectly still, unlike a real device.
  //
  // Fix: suppress on-drag dismissal for a short window right after opening
  // (long enough to absorb incidental drag/scroll from the opening itself,
  // short enough that a genuine subsequent drag still dismisses the keyboard
  // normally). Real state, not a ref: clearing it after the window needs to
  // actually re-render to put `keyboardDismissMode` back to "on-drag" on the
  // FlatList prop below — a ref write alone wouldn't do that without some
  // other, unrelated re-render happening to pick it up.
  const [suppressOnDragDismiss, setSuppressOnDragDismiss] = useState(false);
  const SUPPRESS_ON_DRAG_DISMISS_MS = 500;
  // A close-then-reopen within the window left the OLD timer armed, so it
  // could clear the NEW open's suppression early (a fast enough second open
  // would inherit however much time was left on the first one, not the full
  // 500ms) — caught in PR review, Codex. Track it so a fresh open cancels
  // any still-pending timer before arming its own, and clear it on unmount
  // too, so no stray setState fires after the component is gone.
  const suppressOnDragDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (suppressOnDragDismissTimerRef.current !== null) {
        clearTimeout(suppressOnDragDismissTimerRef.current);
      }
    },
    [],
  );
  const openSearch = useCallback(() => {
    // Diagnostic trail for the "search icon tap does nothing but the list
    // scrolls slightly" report: if this breadcrumb is ABSENT for a tap the
    // user saw happen, the touch never reached JS (swallowed by the list's
    // scroll responder — the same hit-test class as STASH-7/STASH-8), not a
    // bug in this function. If it's present but the field still isn't
    // visible, the reveal-focus effect / collapse-state breadcrumbs below
    // narrow it further.
    trackBreadcrumb('search', 'open tap', {
      scrollY: Math.round(lastScrollYRef.current),
      collapsedBefore: headerCollapseRef.current.collapsed,
    });
    // Keep the gesture-synchronous focus path for mobile browsers. Search
    // activation expands a collapsed header and snapshots its prior state.
    syncFlush(() => {
      setSearchOpen(true);
      setSuppressOnDragDismiss(true);
      preSearchHeaderCollapseRef.current = headerCollapseRef.current;
      preSearchCollapsibleHeightRef.current = collapsibleHeightRef.current;
      const expanded = { collapsed: false, anchorScrollY: lastScrollYRef.current };
      headerCollapseRef.current = expanded;
      setHeaderCollapse(expanded);
    });
    searchRef.current?.focus();
    // The focus-on-open effect below is the fallback for any mount-order
    // race the synchronous call above missed.
    if (suppressOnDragDismissTimerRef.current !== null) {
      clearTimeout(suppressOnDragDismissTimerRef.current);
    }
    suppressOnDragDismissTimerRef.current = setTimeout(() => {
      suppressOnDragDismissTimerRef.current = null;
      setSuppressOnDragDismiss(false);
    }, SUPPRESS_ON_DRAG_DISMISS_MS);
  }, []);
  // While search is open, every scroll tick pins the header at
  // `{ collapsed: false, anchorScrollY: <wherever the user was> }` (see the
  // scroll listener below), so `headerCollapseRef.current` at close time holds
  // that pinned value, not the real pre-search hysteresis anchor. Continuing
  // from `INITIAL_HEADER_COLLAPSE_STATE` (as if the header had just now
  // scrolled to this position from the top) fixed the original stuck-expanded
  // bug (deep in a long list, no room to scroll further down and re-trigger a
  // collapse) but overcorrected: it discards a legitimate reveal that was
  // already in effect before search opened (scroll up, pause, scroll back
  // down a little — see domain/header-collapse.ts's reveal/collapse
  // hysteresis) and forces a full collapse on close instead (STASH report:
  // closing search made the whole top row vanish, not just the field).
  // `openSearch` snapshots the real pre-search state into
  // `preSearchHeaderCollapseRef` before pinning it expanded; continuing the
  // hysteresis from THAT anchor (rather than 0) at the current scroll offset
  // gets both right — an unmoved position stays exactly as it was, and a
  // position that moved far enough during search still collapses normally.
  // The collapsible height comes from that same pre-search snapshot too, not
  // the live `collapsibleHeightRef` — the search-open layout (search input,
  // no sort/browse row) can measure a different height than the normal
  // layout the header reverts to on close, so comparing the pre-search
  // anchor against the WRONG (search-open) height picked the wrong threshold
  // (caught in PR review, Codex).
  // Shared by every path that can close search — not just the explicit
  // closeSearch() below, but the empty-blur and native keyboardDidHide
  // auto-closes too, which set searchOpen false directly without going
  // through closeSearch (caught in PR review, Codex — the first version of
  // this fix only covered closeSearch).
  const restoreHeaderCollapseOnSearchClose = useCallback(() => {
    const restored = nextHeaderCollapseState(
      preSearchHeaderCollapseRef.current,
      lastScrollYRef.current,
      preSearchCollapsibleHeightRef.current,
    );
    headerCollapseRef.current = restored;
    if (Platform.OS === 'web') {
      setHeaderCollapse(restored);
    }
  }, []);
  // Explicit close clears the query and restores the pre-search scroll state.
  // The field stays mounted so the next search can start directly from it.
  const closeSearch = useCallback(() => {
    trackBreadcrumb('search', 'close', { scrollY: Math.round(lastScrollYRef.current) });
    clearBlurHide();
    setSearchFocused(false);
    searchRef.current?.blur();
    setQuery('');
    setSearchOpen(false);
    restoreHeaderCollapseOnSearchClose();
  }, [clearBlurHide, restoreHeaderCollapseOnSearchClose]);
  // Keep the focus fallback for activation from the search icon.
  useEffect(() => {
    if (searchOpen) {
      // hasRef=false here would mean the field hadn't mounted yet when this
      // effect ran (a mount-order race), so .focus() below was a silent no-op.
      trackBreadcrumb('search', 'focus effect', { hasRef: searchRef.current != null });
      searchRef.current?.focus();
    }
  }, [searchOpen]);
  // On native, dismissing the keyboard with the Back button / interactive swipe
  // (or an on-drag list scroll) does NOT fire the TextInput's onBlur — so without
  // this the focused-only suggestion shelf would stay stranded on screen with no
  // keyboard, and the Browse row (gated on !searchFocused) would never return.
  // When the keyboard hides, drop the focused state and blur the field (Android
  // keeps native focus after a Back-button dismiss, so blur() is needed for the
  // next tap to re-fire onFocus). Route the hide through the SAME deferred timer
  // the onBlur path uses, so a same-gesture chip onPress still resolves against a
  // mounted shelf — native hide ordering isn't guaranteed. The shelf's own
  // ScrollView sets keyboardShouldPersistTaps="handled", so a chip tap never
  // dismisses the keyboard and this can't fire mid-tap. Web has no soft keyboard.
  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      clearBlurHide();
      blurHideTimer.current = setTimeout(() => {
        blurHideTimer.current = null;
        setSearchFocused(false);
        searchRef.current?.blur();
        // Keyboard dismissed with nothing typed (Back button / interactive
        // swipe never fire onBlur) → fold the search UI away to keep the top
        // thin. A live query keeps the field up (the "results, keyboard down"
        // state); a recent-suggestion tap leaves a query so it won't close.
        if (queryRef.current.length === 0) {
          setSearchOpen(false);
          restoreHeaderCollapseOnSearchClose();
        }
      }, 0);
    });
    return () => sub.remove();
  }, [clearBlurHide, restoreHeaderCollapseOnSearchClose]);
  return { query, setQuery, debouncedQuery, searching, queryRef, searchOpen, setSearchOpen, searchFocused, setSearchFocused, blurHideTimer, clearBlurHide, searchRef, suppressOnDragDismiss, openSearch, restoreHeaderCollapseOnSearchClose, closeSearch };
}
