/**
 * English message catalog — the source of truth for every user-facing string.
 *
 * Keys are dotted and grouped by screen/component. A value is either a plain
 * string (with `{name}` placeholders for interpolation) or a `PluralMessage`
 * with `one`/`other` variants selected by a `count` param. Other locales
 * (`ko.ts`) are `Partial` catalogs: any missing key falls back to English here,
 * so the UI never shows a blank or a raw key.
 *
 * Pure data — no React, no native imports — so the Node test lane can load it.
 */

/** A count-sensitive message; `one` is optional (defaults to `other`). */
export interface PluralMessage {
  one?: string;
  other: string;
}

export type Message = string | PluralMessage;

export const en = {
  // App identity (brand name is intentionally never translated).
  'app.name': 'Keepory',
  // Locale-native wordmark shown beside the brand name. Defaults to the brand
  // name itself, which the hero reads as "no native wordmark" and renders just
  // "Keepory"; locales override it to opt in.
  'app.nameLocal': 'Keepory',
  'app.tagline': 'Save now. Organize later.',

  // Shared, reused across screens.
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.share': 'Share',
  'common.copy': 'Copy',
  'common.open': 'Open',
  'common.openLink': 'Open link',
  'common.view': 'View',
  'common.undo': 'Undo',
  'common.trash': 'Move to Trash',
  'common.restore': 'Restore',
  'common.back': '‹ Back',
  'common.close': 'Close',
  'common.signOut': 'Sign out',
  'common.untitled': 'Untitled',
  'common.ok': 'OK',

  // Status words (sync/metadata), composed via the prefixes below.
  'status.syncPrefix': 'sync {status}',
  'status.metadataPrefix': 'metadata {status}',
  'status.pending': 'pending',
  'status.synced': 'synced',
  'status.syncing': 'syncing',
  'status.failed': 'failed',
  'status.waitingForConnection': 'waiting for connection',
  'status.complete': 'complete',
  'status.skipped': 'skipped',
  // STASH-61: an on-device check confirmed a saved YouTube video is gone
  // (deleted/private). Lowercase to match the other status words above, which
  // this joins alongside via " · ".
  'status.videoUnavailable': 'video unavailable',

  // Navigation / screen titles (expo-router Stack headers).
  'nav.addBookmark': 'Add Bookmark',
  'nav.settings': 'Settings',
  'nav.account': 'Account',
  'nav.review': 'Review AI suggestions',
  'nav.report': 'Report a problem',
  'nav.trash': 'Trash',
  'nav.bookmark': 'Bookmark',
  'nav.browseTags': 'Tags',
  'nav.graph': 'Graph',

  // Tag graph (/graph) — a pan/zoom map of bookmarks linked to their tags.
  'graph.empty': 'Nothing to map yet',
  'graph.emptyHint': 'Save a few bookmarks and they’ll appear here, linked to their tags.',
  'graph.untaggedLabel': 'Untagged',
  'graph.untaggedHint': 'Add tags to your bookmarks to see how they connect.',
  'graph.building': 'Building your map…',
  'graph.buildingStageDerive': 'Reading your bookmarks…',
  'graph.buildingStageLayout': 'Positioning nodes…',
  'graph.buildingStagePlacing': 'Arranging bookmarks…',
  'graph.buildingStageDeclutter': 'Polishing the layout…',
  'graph.recenterA11y': 'Recenter the graph',
  'graph.openA11y': 'Open the tag graph',
  'graph.tagA11y': {
    one: 'Tag {name}, {count} bookmark',
    other: 'Tag {name}, {count} bookmarks',
  },
  'graph.untaggedA11y': {
    one: 'Untagged, {count} bookmark',
    other: 'Untagged, {count} bookmarks',
  },
  'graph.bookmarkA11y': 'Bookmark {title}',
  'graph.modeBipartite': 'Bookmarks',
  'graph.modeCooccurrence': 'Tags',
  'graph.cooccurrenceEmpty': 'No shared tags yet',
  'graph.cooccurrenceEmptyHint':
    'Tags that appear together on two or more bookmarks will connect here.',

  // Inbox (home).
  'inbox.savedCount': '{count} saved',
  'inbox.storageError':
    'Couldn’t open local storage — showing sample data. Your saves this session may not persist. Tap to report ›',
  'inbox.reportStorageProblem': 'Report storage problem',
  'inbox.searchPlaceholder': 'Search titles, tags, collections',
  'inbox.searchPlaceholderScoped': 'Search in {name}',
  'inbox.searchPlaceholderUncollected': 'Inbox',
  'inbox.browse': 'Browse',
  'inbox.sortA11y': 'Sort: {label}. Tap to change.',
  'inbox.sortMenuTitle': 'Sort by',
  'inbox.sortNewest': 'Newest',
  'inbox.sortOldest': 'Oldest',
  'inbox.sortRecentlyOpened': 'Recently opened',
  'inbox.sortLeastRecentlyOpened': 'Least recently opened',
  'inbox.sortNameAsc': 'Name A–Z',
  'inbox.sortNameDesc': 'Name Z–A',
  // Folder View's own sort menu (Collection tiles) — a separate 4-option set
  // from the bookmark-level sort above (see domain/folder-sort.ts).
  'inbox.folderSortNameAsc': 'Name A–Z',
  'inbox.folderSortNameDesc': 'Name Z–A',
  'inbox.folderSortCountDesc': 'Most items',
  'inbox.folderSortCountAsc': 'Fewest items',
  'inbox.viewAsA11y': 'View as {mode}',
  // "Browse by tag" toggle: an icon-only control that navigates to the dedicated
  // tag-browse route (/browse/tags), carrying the current facet as its scope.
  'inbox.browseTagsA11y': 'Browse by tag',
  // Web-only overflow affordance on the horizontal browse shelf: chevron buttons
  // that appear at the clipped edges to reveal filter chips scrolled off-screen.
  'inbox.shelfMoreA11y': 'Show more filters',
  'inbox.shelfPrevA11y': 'Show previous filters',
  'inbox.openBookmarkHint': 'Opens bookmark details',
  'inbox.filterAll': 'All',
  'inbox.filterNoCollection': 'Inbox',
  'inbox.sectionMatches': { one: '{count} result', other: '{count} results' },
  'inbox.sectionNoCollection': 'Inbox · {count}',
  'inbox.sectionFacet': '{label} · {count}',
  'inbox.sectionRecent': 'Recently saved',
  'inbox.loading': 'Loading your bookmarks…',
  // Shown in the empty Inbox while a post-sign-in pull is in flight and the local
  // cache is still empty (fresh install / account switch). Distinct from
  // `inbox.loading` (the local durable read) — this is the cloud fetch.
  'inbox.syncing': 'Syncing your bookmarks…',
  'inbox.syncingHint': 'Fetching your saved links from the cloud.',
  'inbox.emptySearch': 'No bookmarks match your search.',
  // Recovery affordances shown beneath the empty-search message: a hint that the
  // search reaches beyond titles, and a button to drop the query.
  'inbox.emptySearchHint': 'Search also looks in tags, collections, and site names.',
  'inbox.clearSearch': 'Clear search',
  'inbox.clearSearchA11y': 'Clear search',
  // Sticky active-filter bar: tells the user the list is narrowed and offers a
  // one-tap way back. `scopeFiltered`/`scopeSearch` label what's active; a
  // clear/✕ action is shown.
  'inbox.scopeFiltered': 'Filtered: {label}',
  'inbox.scopeSearch': 'Results for “{query}”',
  // When a search runs inside an active facet (a collection, a tag, or the
  // Inbox/no-collection view), the results are scoped to that facet — so the
  // banner names it, e.g. "Results for “파스” in Inbox".
  'inbox.scopeSearchIn': 'Results for “{query}” in {scope}',
  'inbox.scopeClearA11y': 'Clear filter and show all bookmarks',
  'inbox.scopeClearSearchA11y': 'Clear the search',
  'inbox.emptyView': 'Nothing in this view yet.',
  'inbox.emptyTitle': 'Nothing saved yet',
  // Native first-run teach: a numbered 2-step share-capture walkthrough, plus a
  // smaller fallback line for the manual add path. Web has no share sheet
  // (expo-share-intent is a no-op there), so it gets a distinct single-step
  // variant below instead of this pair.
  'inbox.emptyHintStep1': 'Open any app, tap Share',
  'inbox.emptyHintStep2': 'Choose Keepory — saved instantly',
  'inbox.emptyHintFallback': 'Prefer to paste a link? Tap the + below.',
  'inbox.emptyHintGetWeb': 'Also on the web at keepory.app',
  // Web empty-state: no share sheet to teach, so lead with the paste-a-link
  // flow and explain the platform gap rather than implying share works here.
  'inbox.emptyHintWebStep': 'Tap + to paste a link and save.',
  'inbox.emptyHintWebNote': 'Sharing from other apps works in the Keepory Android app, not on the web yet.',
  'inbox.emptyHintWebGetAndroid': 'Get the Android app',
  // Anonymous-account nudge banner (shown after the 2nd save, dismissible
  // forever) — see AnonymousNudgeBanner.
  'inbox.anonymousNudgeBody':
    'Your bookmarks are saved on this device. Sign in to back them up and access them elsewhere.',
  'inbox.anonymousNudgeDismissA11y': 'Dismiss',
  'inbox.moreActions': 'More actions',
  'inbox.moveToCollectionAction': 'Move to collection…',
  'inbox.moveToCollectionTitle': 'Move to collection',
  'inbox.inboxNoCollection': 'Inbox',
  // Distinct screen-reader label so the unfiled option never sounds identical to
  // a user collection that happens to be named "Inbox" (the visible row stays
  // the clean "Inbox", the tray icon disambiguates it visually).
  'inbox.inboxNoCollectionA11y': 'Inbox (no collection)',
  // Folder View: a grid of tappable Collection tiles instead of the flat
  // bookmark list. Each tile's subtitle is its item count; the trailing tile
  // is a dashed "New collection" affordance.
  'inbox.collectionTileCount': { one: '{count} item', other: '{count} items' },
  'inbox.newCollection': 'New collection',
  'inbox.newCollectionA11y': 'Create a new collection',
  // "New collection" dialog: a single name field plus Cancel/Create.
  'inbox.newCollectionNamePlaceholder': 'Collection name',
  'inbox.newCollectionCreate': 'Create',
  'inbox.aiSuggestionsA11y': { one: '{count} AI suggestion', other: '{count} AI suggestions' },
  'inbox.newSuggestions': {
    one: '✨ {count} new AI suggestion',
    other: '✨ {count} new AI suggestions',
  },
  'inbox.newSuggestionsReview': 'Review',
  'inbox.newSuggestionsA11y': {
    one: 'Review {count} new AI suggestion',
    other: 'Review {count} new AI suggestions',
  },
  'inbox.newSuggestionsDismiss': 'Dismiss new AI suggestions',
  // Calm, persistent form of the review banner: shown whenever anything is left
  // to review (even after the "new" arrivals are acknowledged), as the standing
  // entry point into the Review screen.
  'inbox.reviewPending': {
    one: '✨ {count} suggestion to review',
    other: '✨ {count} suggestions to review',
  },
  'inbox.reviewPendingA11y': {
    one: 'Review {count} AI suggestion',
    other: 'Review {count} AI suggestions',
  },
  // Shown when a signed-in account's session expired on launch: the local
  // bookmarks are preserved but cloud sync is paused until the user re-signs-in.
  'inbox.sessionExpired': 'Signed out — cloud sync is paused',
  'inbox.sessionExpiredCta': 'Sign in',
  'inbox.sessionExpiredA11y': 'Session expired. Open settings to sign back in and resume syncing.',
  'inbox.inCollection': 'in {name}',
  'inbox.memoType': 'Memo',
  'inbox.addBookmark': 'Add bookmark',
  'inbox.settingsA11y': 'Settings',
  'inbox.scrollToTopA11y': 'Scroll to top',
  'inbox.searchOpenA11y': 'Search',
  'inbox.searchCloseA11y': 'Close search',
  'inbox.tagCloudTagA11y': {
    one: '#{name}, {count} bookmark',
    other: '#{name}, {count} bookmarks',
  },
  'inbox.tagCloudEmpty': 'No tags yet. Tag a bookmark to see it here.',

  // Browse-by-tag route (/browse/tags). One debounced co-occurrence search field
  // at top, then a segmented control between the (adaptive-capped) word cloud and
  // the full virtualized list. Header title names the active facet scope.
  'inbox.tagSearchPlaceholder': 'Search tags',
  'inbox.tagViewCloud': 'Cloud',
  'inbox.tagViewAll': 'All',
  'inbox.tagViewCloudA11y': 'Show the tag cloud',
  'inbox.tagViewAllA11y': 'Show all tags as a list',
  // Header titles, by scope: whole library / a collection / the uncollected set.
  'inbox.tagsTitle': 'Tags',
  'inbox.tagsTitleScoped': 'Tags in {name}',
  'inbox.tagsTitleUncollected': 'Tags · Inbox',
  // The list row's muted count badge (how many bookmarks carry the tag).
  'inbox.tagListCount': '· {count}',
  // Empty/zero states on the route.
  'inbox.tagsScopedEmpty': 'No tags in {name} yet.',
  'inbox.tagsUncollectedEmpty': 'No tags in the Inbox yet.',
  'inbox.tagsBrowseAll': 'Browse all tags',
  'inbox.tagsSearchZero': 'No tags match “{query}”.',
  // Cloud-surface overflow footer: shown only when the adaptive cap hides tags.
  // {count} is the TOTAL tag count (what the All list reveals), not the hidden
  // count. Tapping switches to the All list.
  'inbox.tagCloudShowAll': {
    one: 'Show all {count} tag',
    other: 'Show all {count} tags',
  },
  'inbox.tagCloudShowAllA11y': {
    one: 'Show all {count} tag',
    other: 'Show all {count} tags',
  },

  // Search suggestion shelf (focused-empty state).
  'search.shelfAffordance': 'Jump to',
  'search.shelfA11y': 'Search suggestions',
  'search.recentChipA11y': 'Search again for “{query}”',
  // Phase 2 (§13.7): a11y region label for the shelf while a query is active, so
  // a screen-reader user knows the rail narrowed to their query. Optional polish;
  // the key is reserved for parity.
  'search.shelfFilteredA11y': 'Suggestions matching “{query}”',
  'search.tagChipA11y': 'Filter by tag {name}',
  'search.collectionChipA11y': 'Filter by collection {name}',
  // Per-entry delete, exposed as an accessibility action on a recent chip.
  'search.removeRecentA11y': 'Remove recent search “{query}”',
  // Reserved for the Phase-2 Settings "Clear history" bulk-clear control; not
  // wired in Phase 1 (per-chip removal uses removeRecentA11y above).
  'search.clearRecentsA11y': 'Clear recent searches',
  // Reserved for a future recents sub-grouping label (pre-declared for parity).
  'search.recentGroupA11y': 'Recent searches',

  // View-mode labels (Inbox layout density).
  'viewMode.card': 'Cards',
  'viewMode.compact': 'Compact',
  'viewMode.list': 'List',
  'viewMode.collection': 'Collections',

  // Add bookmark.
  'add.urlLabel': 'URL',
  'add.urlPlaceholder': 'https://',
  'add.modeLink': 'Link',
  'add.modeMemo': 'Memo',
  'add.modeLinkA11y': 'Add a link bookmark',
  'add.modeMemoA11y': 'Add a Markdown memo',
  'add.noteLabel': 'Note (optional)',
  'add.notePlaceholder': 'Why are you saving this?',
  'add.memoTitleLabel': 'Title (optional)',
  'add.memoTitlePlaceholder': 'Give this memo a title',
  'add.memoBodyLabel': 'Markdown',
  'add.memoBodyPlaceholder': '# Heading\n\nWrite your memo in Markdown…',
  'add.memoRequired': 'Write something before saving this memo.',
  'add.save': 'Save bookmark',
  'add.saveMemo': 'Save memo',
  'add.hint': 'Saved instantly. Sync happens in the background.',
  'add.memoHint': 'Markdown is stored as written and rendered on the detail screen.',
  'add.saving': 'Saving…',

  // Capture toasts (also used by the share flow).
  'toast.saved': 'Saved to Keepory',
  'toast.savedCount': { one: 'Saved to Keepory', other: '{count} saved to Keepory' },
  'toast.duplicate': 'Already in Keepory',
  'toast.trashed': 'Moved to Trash',
  'toast.noLink': 'No link found to save',
  'toast.urlTooLong': 'This link is too long to save',
  // STASH #574 Phase 1: shown once a burst of background auto-enrichments
  // finishes (2+ settled together) — never for a single, routine completion.
  'toast.aiEnrichmentBurst': { other: '{count} bookmarks checked for AI suggestions' },
  'toast.saveFailed': 'Could not save to Keepory',
  'toast.linkCopied': 'Link copied',
  'toast.memoCopied': 'Memo copied',

  // Settings.
  'settings.section.account': 'Account',
  'settings.section.activity': 'Activity',
  'settings.section.library': 'Library',
  'settings.section.preferences': 'Preferences',
  'settings.section.data': 'Your data',
  'settings.section.advanced': 'Advanced',
  'settings.section.browser': 'Save from your browser',
  'settings.bookmarklet.button': '⊕ Save to Keepory',
  'settings.bookmarklet.copied': 'Copied!',
  'settings.bookmarklet.note':
    'Drag this button to your bookmarks bar (or click to copy it). Then click it on any page to save it.',
  'settings.account.signedIn': 'Signed in',
  'settings.account.signIn': 'Sign In',
  'settings.account.sessionExpired': 'Session expired',
  'settings.account.sessionExpiredBody': 'Sign back in to resume syncing. Your bookmarks are safe.',
  'settings.account.signOut': 'Sign out',
  'settings.account.cloudUnavailable': 'Cloud sync unavailable',
  'settings.account.worksOffline': 'Keepory works fully offline',
  'settings.account.signOutConfirmTitle': 'Sign out of Keepory?',
  'settings.account.signOutConfirmBody':
    'Your bookmarks are safely backed up to your account. Sign back in anytime to see them again.',
  'settings.account.signOutConfirm': 'Sign out',
  'settings.account.signOutCancel': 'Cancel',
  'settings.sync.label': 'Sync',
  'settings.sync.syncing': {
    one: 'Syncing {count} item…',
    other: 'Syncing {count} items…',
  },
  'settings.sync.allBackedUp': 'All backed up',
  'settings.sync.localOnly': 'Local only',
  'settings.sync.paused': 'Paused',
  'settings.sync.pausedWaiting': {
    one: 'Paused — {count} item waiting',
    other: 'Paused — {count} items waiting',
  },
  'settings.sync.waiting': {
    one: '{count} item waiting to upload',
    other: '{count} items waiting to upload',
  },
  'settings.sync.pauseButton': 'Pause sync',
  'settings.sync.resumeButton': 'Resume sync',
  'settings.processing.label': 'Background processing',
  'settings.processing.complete': 'All work complete',
  'settings.processing.remaining': {
    one: '{count} bookmark remaining',
    other: '{count} bookmarks remaining',
  },
  'settings.processing.remainingWithAttention': {
    one: '{count} bookmark remaining · {attention} needs attention',
    other: '{count} bookmarks remaining · {attention} need attention',
  },
  'settings.processing.count': {
    one: '{count} bookmark',
    other: '{count} bookmarks',
  },
  'settings.processing.cloud.label': 'Saving to cloud',
  'settings.processing.cloud.localOnly': {
    one: '{count} bookmark · local only',
    other: '{count} bookmarks · local only',
  },
  'settings.processing.cloud.paused': {
    one: '{count} bookmark · sync paused',
    other: '{count} bookmarks · sync paused',
  },
  'settings.processing.cloud.syncing': {
    one: '{count} bookmark · saving now',
    other: '{count} bookmarks · saving now',
  },
  'settings.processing.metadata.label': 'Fetching information',
  'settings.processing.ai.label': 'Preparing AI suggestions',
  'settings.processing.ai.off': {
    one: '{count} bookmark · AI suggestions off',
    other: '{count} bookmarks · AI suggestions off',
  },
  'settings.processing.ai.localPaused': {
    one: '{count} bookmark · local AI waiting',
    other: '{count} bookmarks · local AI waiting',
  },
  'settings.processing.ai.quota': {
    one: '{count} bookmark · resumes {resetTime}',
    other: '{count} bookmarks · resumes {resetTime}',
  },
  'settings.processing.attention.label': 'Needs attention',
  'settings.processing.details.label': 'Processing details',
  'settings.processing.details.show': 'Show diagnostic counters',
  'settings.processing.details.hide': 'Hide diagnostic counters',
  'settings.processing.details.none': 'none',
  'settings.processing.details.syncStates.label': 'Cloud queue states',
  'settings.processing.details.syncStates.value':
    'pending {pending} · syncing {syncing} · failed {failed}',
  'settings.processing.details.syncOps.label': 'Cloud queue operations',
  'settings.processing.details.syncOps.value':
    'create {create} · update {update} · delete {delete}',
  'settings.processing.details.syncHealth.label': 'Cloud queue health',
  'settings.processing.details.syncHealth.value':
    'max retries {retries} · oldest {oldest}',
  'settings.processing.details.metadata.label': 'Information pipeline',
  'settings.processing.details.metadata.value':
    'pending {pending} · failed {failed} · skipped {skipped}',
  'settings.processing.details.aiLocal.label': 'AI local pipeline',
  'settings.processing.details.aiLocal.value':
    'trigger {trigger} · dispatch {dispatch} · retry {retry} · active {active}',
  'settings.processing.details.aiServer.label': 'AI server pipeline',
  'settings.processing.details.aiServer.value':
    'pending {pending} · processing {processing} · failed {failed}',
  'settings.processing.details.degraded.label': 'Fallback suggestions',
  'settings.processing.details.degraded.value': '{count} rate-limited',
  'settings.syncBreakdown.uploading.label': 'Waiting to upload',
  'settings.syncBreakdown.uploading.value': {
    one: '{count} bookmark',
    other: '{count} bookmarks',
  },
  'settings.syncBreakdown.fetchingInfo.label': 'Fetching info',
  'settings.syncBreakdown.fetchingInfo.value': {
    one: '{count} bookmark',
    other: '{count} bookmarks',
  },
  // Activity's compact chip strip (docs/design/settings-activity-status.md)
  // reuses this `.label` for the AI chip's text, with the count rendered via
  // `Chip`'s own `count` prop instead of one of the sentence-form `.value`/
  // `.blockedOff`/`.blockedPaused`/`.quotaWithCount` variants below — those
  // are kept unused rather than deleted (not required by this pass; see the
  // design doc §5).
  'settings.activity.aiSuggestions.label': 'AI suggestions',
  'settings.activity.aiSuggestions.value': {
    one: '{count} bookmark',
    other: '{count} bookmarks',
  },
  'settings.activity.aiSuggestions.blockedOff': {
    one: '{count} bookmark · AI suggestions are off — only already-queued items keep processing',
    other: '{count} bookmarks · AI suggestions are off — only already-queued items keep processing',
  },
  'settings.activity.aiSuggestions.blockedPaused': {
    one: '{count} bookmark · paused with sync — resumes when you resume sync',
    other: '{count} bookmarks · paused with sync — resumes when you resume sync',
  },
  'settings.activity.aiSuggestions.quotaWithCount': {
    one: '{count} bookmark · {quotaReason}',
    other: '{count} bookmarks · {quotaReason}',
  },
  // The Activity strip's distinct quota-reached chip (design doc §2/§5): no
  // numeric count (how many items is not the useful fact once blocked). The
  // reset time (always accurate — `request_ai_enrichment_slot`'s
  // `retry_after`, STASH-4P follow-up) is worth the pill's space, but the
  // hourly/daily/generic reason text isn't, so `chipQuotaReachedWithTime` is
  // the normal case and this static fallback only covers the (practically
  // unreachable) case of a quota cooldown with no reset time to show.
  'settings.syncBreakdown.aiSuggestions.chipQuotaReached': 'AI suggestions · quota reached',
  'settings.syncBreakdown.aiSuggestions.chipQuotaReachedWithTime':
    'AI suggestions · resumes at {resetTime}',
  // Gemini itself hit its own rate limit (RESOURCE_EXHAUSTED, separate from
  // the user quota chip above) and the server served heuristic suggestions
  // instead — reuses `detail.aiDegradedBasic`'s "basic suggestions" wording.
  // `quiet`, not `highlight`: nothing is blocked, the server already
  // auto-requeued these for a real-model retry.
  'settings.syncBreakdown.degradedResults.label': 'Basic suggestions shown',
  'settings.trash.label': 'Trash',
  'settings.trash.value': '{count} items',
  'settings.report.label': 'Report a problem',
  'settings.report.value': 'Send a bug or idea',
  'settings.export.label': 'Export my data',
  'settings.export.preparing': 'Preparing export…',
  'settings.export.nothing': 'Nothing to export yet',
  'settings.export.value': 'Download a bookmarks file or full backup',
  'settings.import.label': 'Import data',
  'settings.import.importing': 'Importing…',
  'settings.import.value': 'Restore a backup or another app’s bookmarks',
  // Library reset (issue #600) — deletes the account's cloud + local library
  // data. Deliberately worded as "reset library", never "delete account": the
  // auth user itself is not deleted and sign-out is a separate, safe action.
  'settings.reset.label': 'Reset library',
  'settings.reset.value': 'Delete every bookmark & all data in this account',
  'settings.reset.resetting': 'Resetting…',
  'settings.reset.signInRequired': 'Needs an active session',
  'settings.reset.dialogTitle': 'Reset library?',
  'settings.reset.dialogBody':
    'This permanently deletes ALL bookmarks, tags, collections, and AI data from this account — in the cloud and on this device. Export a backup first if you might want this data again. This cannot be undone.',
  'settings.reset.confirmWord': 'RESET',
  'settings.reset.typeToConfirm': 'Type {word} to confirm:',
  'settings.reset.confirm': 'Delete everything',
  'settings.reset.successTitle': 'Library reset',
  'settings.reset.successBody':
    'All bookmarks and data were deleted. You can import a backup or start fresh.',
  'settings.reset.failedTitle': 'Reset failed',
  'settings.reset.failedBusy': 'A sync is in progress. Wait for it to finish, then try again.',
  'settings.reset.failedAuth': 'No active session. Sign in (or go online) and try again.',
  'settings.reset.failedRemote':
    'Could not delete the cloud data — nothing was changed. Check your connection and try again.',
  'settings.reset.failedLocal':
    'The cloud data was deleted, but clearing this device failed. Run the reset again to finish clearing this device.',
  'settings.dataNote':
    'Your bookmarks are yours. Export a standard HTML file any browser or bookmark app can import, a CSV for spreadsheets, or a full JSON backup — anytime, even offline.',
  'settings.share.label': 'Open Inbox after sharing',
  'settings.share.inbox': 'Shared links open the Inbox',
  'settings.share.toast': 'Shared links just show a toast',
  'settings.analytics.label': 'Share privacy-safe usage analytics',
  'settings.analytics.enabled':
    'Shares app opens, screen categories, platform/sign-in state, share performance/latency, time, and a random analytics ID',
  'settings.analytics.disabled': 'Off — no analytics are sent',
  'settings.analytics.errorTitle': 'Could not save analytics preference',
  'settings.analytics.errorBody':
    'Analytics stays off for this session. Please try again so the choice is saved for the next launch.',
  'settings.sessionReplay.label': 'Enable session replay & feature previews',
  'settings.sessionReplay.enabled':
    'Records anonymized screen sessions (with bookmark text and images hidden) and enables in-app surveys and experimental features',
  'settings.sessionReplay.disabled':
    'Off — no session recording, surveys, or experiment targeting',
  'settings.sessionReplay.errorTitle': 'Could not save session replay preference',
  'settings.sessionReplay.errorBody':
    'Session replay stays off for this session. Please try again so the choice is saved for the next launch.',
  'settings.search.clearLabel': 'Clear search history',
  'settings.search.clearValue': '{count} recent searches',
  'settings.search.clearEmpty': 'No recent searches',
  'settings.search.clearConfirmTitle': 'Clear search history?',
  'settings.search.clearConfirmBody':
    'This removes your recent searches on this device. Your bookmarks and tags aren’t affected.',
  'settings.search.clearConfirm': 'Clear',
  'settings.developer.label': 'Developer mode',
  'settings.developer.value': 'Diagnostics & build info',
  'settings.language.label': 'Language',
  'settings.language.system': 'System default',
  'settings.language.en': 'English',
  'settings.language.ko': '한국어',
  'settings.language.sheetTitle': 'App language',
  'settings.aiSuggestions.label': 'AI suggestions',
  'settings.aiSuggestions.sheetTitle': 'AI suggestions mode',
  'settings.aiSuggestions.off': 'Off — never auto-suggest',
  'settings.aiSuggestions.confirm': 'Review suggestions before applying',
  'settings.aiSuggestions.auto_accept': 'Auto-apply high-confidence suggestions',
  // Reused by the Activity "AI suggestions" row's quota-priority branch
  // (settings.tsx's quotaReasonKey) — no longer rendered as their own row.
  'settings.aiQuotaExceeded.hourly': 'Hourly limit reached — resumes at {resetTime}',
  // Codex review, PR #664: the daily case's displayed reset time is the
  // server's exact figure, but the auto-dispatch drain loop still waits out
  // a fixed 30-minute cooldown regardless (see AI_QUOTA_DAILY_COOLDOWN_MS) —
  // "resumes at" would overpromise whenever the real reset lands sooner than
  // that. Worded as the quota's own reset instead of a resume-processing
  // promise; hourly/generic don't need this hedge since their internal gate
  // already trusts the server's exact figure directly.
  'settings.aiQuotaExceeded.daily': 'Daily limit reached — quota resets at {resetTime}',
  'settings.aiQuotaExceeded.generic': 'Rate limited — resumes at {resetTime}',
  'settings.pushNotifications.label': 'Notify when AI catches up',
  'settings.pushNotifications.on': 'On — a push arrives once AI finishes a backlog',
  'settings.pushNotifications.off': 'Off',
  'settings.pushNotifications.signInRequired': 'Sign in to enable',
  'settings.pushNotifications.aiOff': 'Turn on AI suggestions first',
  'settings.pushNotifications.deniedTitle': 'Notifications are turned off',
  'settings.pushNotifications.deniedBody':
    'Stash can’t send this notification without permission. Enable notifications for Stash in your device Settings, then try again.',
  'settings.pushNotifications.unavailableTitle': 'Can’t enable notifications right now',
  'settings.pushNotifications.unavailableBody':
    'Something went wrong setting up notifications on this device. Please try again later.',
  'settings.diagnostics.title': 'Diagnostics',
  'settings.diagnostics.footnote':
    'Live raw counters for the background pipelines — most useful when triaging a stuck sync or AI suggestion.',
  'settings.diagnostics.supabaseAuth': 'Supabase auth',
  'settings.diagnostics.lastPulled': 'Last pulled',
  'settings.diagnostics.lastPulledNever': 'Never — arrives on next sync',
  'settings.diagnostics.recentPulls.label': 'Recent pulls',
  'settings.diagnostics.recentPulls.none': 'None yet',
  'settings.diagnostics.recentPulls.entryLabel': 'Pull {index}',
  'settings.diagnostics.recentPulls.rows': {
    one: '{count} row',
    other: '{count} rows',
  },
  'settings.diagnostics.recentPulls.success': '{time} · {rows}',
  'settings.diagnostics.recentPulls.failure': '{time} · failed: {error}',
  'settings.diagnostics.syncLifecycle.label': 'Sync lifecycle (synced once / 2x+)',
  'settings.diagnostics.syncLifecycle.value': '{once} / {twice}',
  'settings.diagnostics.metadataDone.label': 'Metadata completed',
  'settings.diagnostics.metadataDone.value': '{done}',
  'settings.diagnostics.aiDone.label': 'AI suggestions completed',
  'settings.diagnostics.aiDone.value': '{done}',
  'settings.diagnostics.appVersion': 'App version',
  'settings.diagnostics.build': 'Build',
  'settings.exportSheet.title': 'Export my data',
  'settings.exportSheet.html': 'Bookmarks file (HTML)',
  'settings.exportSheet.htmlDescription': 'Tags only — skips text-only saves & AI summaries',
  'settings.exportSheet.csv': 'Spreadsheet (CSV)',
  'settings.exportSheet.csvDescription': 'Tags only — no AI summaries',
  'settings.exportSheet.json': 'Full backup (JSON)',
  'settings.exportSheet.jsonDescription': 'Includes AI summaries, tags & confidence',
  'settings.exportSheet.share': 'Share…',
  'settings.exportSheet.saveToDevice': 'Save to device',
  'settings.importSheet.title': 'Import data',
  'settings.importSheet.html': 'Bookmarks file (HTML)',
  'settings.importSheet.json': 'Keepory backup (JSON)',
  'settings.importSheet.pocket': 'Pocket export (CSV)',
  'settings.export.failedTitle': 'Export failed',
  'settings.export.failedBody': 'Could not export your data. Please try again.',
  'settings.export.savedTitle': 'Export saved',
  'settings.export.savedBody': 'Saved {name} to the folder you chose.',
  'settings.import.nothingTitle': 'Nothing to import',
  'settings.import.nothingBody': 'No bookmarks were found in {name}.',
  'settings.import.notReadyTitle': 'Still loading your library',
  'settings.import.notReadyBody':
    'Your library is still loading or syncing. Please wait a moment and try importing again.',
  'settings.import.added': {
    one: 'Added {count} bookmark.',
    other: 'Added {count} bookmarks.',
  },
  'settings.import.duplicates': '{count} already in your library.',
  'settings.import.skipped': '{count} skipped (no web address).',
  'settings.import.completeTitle': 'Import complete',
  'settings.import.failedTitle': 'Import failed',
  'settings.import.failedBody': 'Could not import that file. Please try again.',

  // Trash.
  'trash.empty': 'Trash is empty.',
  'trash.emptyButton': 'Empty Trash',
  'trash.emptyTitle': 'Empty Trash?',
  'trash.emptyBody': 'This permanently deletes all items in the trash. This cannot be undone.',
  'trash.emptyConfirm': 'Delete All',
  'trash.restore': 'Restore',
  'trash.openA11y': 'Open {title}',

  'update.title': 'Update Required',
  'update.body': 'This version of Keepory is no longer supported. Please update to continue.',
  'update.button': 'Download Update',

  // Bookmark detail.
  'detail.notFound': 'This bookmark could not be found.',
  'detail.savedByline': 'Saved',
  'detail.showMore': 'Show more',
  'detail.showLess': 'Show less',
  'detail.showFullTitleA11y': 'Show the full title',
  'detail.showLessTitleA11y': 'Show less of the title',
  'detail.titlePlaceholder': 'Untitled — metadata pending',
  'detail.editTitleA11y': 'Edit title',
  'detail.editTitleHint': 'Edits the title',
  'detail.memoFallbackTitle': 'Memo',
  'detail.memoContentLabel': 'Content',
  'detail.memoPreview': 'Preview',
  'detail.memoEdit': 'Edit Markdown',
  'detail.memoBodyA11y': 'Markdown memo body',
  'detail.memoBodyPlaceholder': 'Write your memo in Markdown…',
  'detail.notesLabel': 'Note',
  'detail.notesA11y': 'Notes',
  'detail.notesPlaceholder': 'Add a note…',
  'detail.tagsDisabledHint': 'Tags can be edited once this bookmark has synced.',
  'detail.currentlyIn': 'Currently in: {name}',
  'detail.aiWorking': 'Working…',
  'detail.aiStale': 'Edited since these suggestions — refresh to update.',
  // Suggested collection, shown as a one-tap chip next to the collection picker.
  'detail.aiSuggestCollectionChip': '📁 ＋ {name}',
  'detail.aiFileIntoA11y': 'File into {name}',
  // Shown when no existing collection matches the AI's hint: create it and file in.
  'detail.aiCreateCollectionChip': '📁 ＋ Create “{name}”',
  'detail.aiCreateCollectionA11y': 'Create collection {name} and file into it',
  'detail.aiDismissCollectionA11y': 'Dismiss suggested collection {name}',
  // Micro-label above the collection suggestion pill under the collection picker.
  'detail.suggestedCollectionLabel': 'Suggested collection',
  // The AI summary, proposed as a note in its own dashed block under the note field.
  'detail.summaryLabel': '✨ Suggested summary',
  'detail.summaryUseAsNote': 'Use as note',
  'detail.summaryUseAsNoteA11y': 'Use the suggested summary as your note',
  'detail.summaryAppendToNote': 'Add to note',
  'detail.summaryAppendToNoteA11y': 'Append the suggested summary to your note',
  'detail.summaryDismiss': 'Dismiss',
  'detail.summaryDismissA11y': 'Dismiss the suggested summary',
  // Screen-level sweep in the AI control strip, when 2+ suggestion surfaces are live.
  'detail.aiDismissAll': 'Dismiss all suggestions',
  'detail.aiDismissAllA11y': 'Dismiss all AI suggestions',
  'detail.aiGenerating': 'Generating suggestions…',
  'detail.aiRefresh': 'Refresh AI suggestions',
  'detail.aiSuggest': 'Suggest with AI',
  'detail.previewRefresh': 'Preview',
  'detail.previewRefreshing': 'Refreshing…',
  // STASH-61: recovery action shown once a saved YouTube video is confirmed
  // unavailable — searches YouTube for the bookmark's title, which often
  // turns up a re-upload or mirror even when the original link is dead.
  'detail.searchYoutube': 'Search YouTube',
  'detail.aiNeedsSync': 'AI suggestions are available once this bookmark has synced.',
  'detail.aiPreviewFailed': 'AI suggestions are unavailable because the preview could not be loaded.',
  'detail.previewFailedNote': 'Failed to load preview and metadata.',
  'detail.aiPostponed': 'Still working on AI suggestions for this one — we’ll keep trying automatically.',
  'detail.aiQueued': 'AI suggestions are queued and will arrive automatically — no need to check back.',
  // Degraded mode: the result came from the basic heuristics, not the AI model.
  // Shown as a calm, non-error note so the cause is never hidden (M12); the
  // precise cause is forwarded to monitoring rather than spelled out in full.
  'detail.aiDegradedRateLimited':
    'AI is over capacity right now — showing basic suggestions. Try again shortly for AI suggestions.',
  'detail.aiDegradedUnavailable':
    'Couldn’t reach AI — showing basic suggestions for now. Refresh to try again.',
  'detail.aiDegradedBasic': 'Showing basic suggestions.',
  // The card collapsed to just the affordance (no actionable suggestions), and
  // the last completed attempt came back rate-limited — there is no "basic
  // suggestions" to point at, and no background retry is scheduled for a
  // completed (if degraded) attempt, so this must not promise one.
  'detail.aiDegradedCollapsed': 'AI suggestions hit their limit for now — try again a little later.',
  'detail.detailsShow': '▸  Details',
  'detail.detailsHide': '▾  Details',
  'detail.toggleDetailsA11y': 'Toggle details',
  'detail.rowUrl': 'URL',
  'detail.rowSite': 'Site',
  'detail.rowDescription': 'Description',
  'detail.rowSaved': 'Saved',
  'detail.rowFrom': 'From',
  'detail.errorShare': 'Could not open the share sheet.',
  'detail.errorOpen': 'Could not open this link.',
  'detail.errorCopyLink': 'Could not copy this link.',
  'detail.errorRefreshPreview': 'Could not refresh the preview.',
  'detail.errorCreateCollection': 'Could not create the collection.',
  'detail.notesTooLong': 'Note is too long ({count}/{max} characters). Truncate or split it.',
  'detail.deleteConfirmWeb': 'Delete this bookmark permanently?',

  // Delete confirmation (native alert; shared by Inbox + Detail).
  'bookmark.deleteTitle': 'Delete bookmark',
  'bookmark.deleteMessage': 'This permanently removes the bookmark from this device.',

  // Review AI suggestions.
  'review.empty': 'No suggestions to review.',
  'review.pendingHeader': {
    one: 'Pending suggestions · {count} bookmark',
    other: 'Pending suggestions · {count} bookmarks',
  },
  // Bulk row, by card content. "Accept all"/"Dismiss all" act on tags AND the
  // collection (both collection kinds: file into an existing one, or create+file);
  // "Accept" / "Dismiss" are the collection-only (no tags) singulars.
  'review.acceptAll': 'Accept all',
  'review.acceptOne': 'Accept',
  'review.dismissAll': 'Dismiss all',
  'review.dismissOne': 'Dismiss',
  'review.acceptTagA11y': 'Accept suggested tag {name} for {title}',
  'review.acceptAllA11y': 'Accept all suggestions for {title}',
  'review.acceptOneA11y': 'File {title} into the suggested collection',
  'review.dismissAllA11y': 'Dismiss all suggestions for {title}',
  'review.dismissOneA11y': 'Dismiss the suggestion for {title}',
  'review.goToA11y': 'Go to {title}',
  'review.confidence': '{percent}%',
  // Chip prefixes that distinguish the two kinds of suggestion at a glance and
  // match the Detail screen's collection chips: 📁 ＋ for a collection (tap =
  // file in), # for a tag.
  'review.tagChip': '#{name}',
  'review.collectionChip': '📁 ＋ {name}',
  'review.createCollectionChip': '📁 ＋ Create “{name}”',
  // ADD vs CHANGE (move) collection forms. The "→" run targets are rendered as
  // separate <Text> children so the `from` name can be struck through and only
  // the arrow + target tinted; these strings are the non-strikethrough fallback
  // pieces / a11y labels. `addArrow` is "→ {name}" (file into an existing one);
  // `addCreateArrow` is "→ ＋ "{name}"" (create then file). For a move the chip
  // composes the struck `from` name with one of these arrows.
  'review.collectionAddArrow': '📁 → {name}',
  'review.collectionCreateArrow': '📁 ＋ Create “{name}”',
  'review.moveArrowTarget': '→ {name}',
  'review.moveCreateTarget': '→ ＋ “{name}”',
  // Chip a11y, per case (screen readers can't see the strikethrough).
  'review.acceptCollectionA11y': 'File {title} into {name}',
  'review.createCollectionA11y': 'Create collection {name} and file {title} into it',
  'review.moveCollectionA11y': 'Move {title} from {from} to {name}',
  'review.moveCreateCollectionA11y': 'Move {title} from {from} into a new collection {name}',
  'review.dismissCollectionA11y': 'Dismiss suggested collection {name} for {title}',
  // A move overwrites a user-chosen collection_id; the chip already shows the
  // ~~from~~ → to, so instead of confirming we file it and offer an Undo toast.
  'review.movedToast': 'Moved to “{name}”',
  // ProposedSummary a11y overrides: unlike Detail (one bookmark per screen),
  // Review can show several summary cards at once, so these name the bookmark.
  'review.summaryUseA11y': 'Use the suggested summary as your note for {title}',
  'review.summaryAppendA11y': 'Add the suggested summary to your note for {title}',
  'review.summaryDismissA11y': 'Dismiss the suggested summary for {title}',

  // Report a problem.
  'report.categoryBug': 'Bug',
  'report.categoryIdea': 'Idea',
  'report.categoryOther': 'Other',
  'report.cloudUnavailableTitle': 'Cloud reporting unavailable',
  'report.cloudUnavailableBody':
    'Submitting to the cloud isn’t configured on this build, but you can still share a diagnostics report (including recent logs) to send manually.',
  'report.signInRequiredTitle': 'Sign in to submit a report',
  'report.signInRequiredBody':
    'Reports need a signed-in account so we can follow up. You can still share a diagnostics report to send manually.',
  'report.categoryLabel': 'Category',
  'report.whatHappened': 'What happened?',
  'report.descriptionA11y': 'Problem description',
  'report.descriptionPlaceholder': 'Describe the problem or idea',
  'report.diagnosticContext': 'Diagnostic context',
  'report.privacyNote':
    'Includes app diagnostics and {count} recent log line(s) to aid debugging — not your bookmark list.',
  'report.screenshotTitle': 'Include screenshot',
  'report.screenshotNote':
    'Captured from the screen where you opened this report. It may show bookmark or account details.',
  'report.screenshotToggleA11y': 'Include screenshot in report',
  'report.screenshotPreviewA11y': 'Screenshot preview',
  'report.contextPreviewA11y': 'Diagnostic context preview',
  'report.contextPreviewToggleA11y': 'Toggle diagnostic context preview',
  'report.showDiagnostics': 'Show diagnostic context',
  'report.hideDiagnostics': 'Hide diagnostic context',
  'report.shareDiagnosticsA11y': 'Share diagnostics',
  'report.shareWithCount': 'Share diagnostics & logs ({count})',
  'report.share': 'Share diagnostics & logs',
  'report.success': 'Thanks — your report was sent.',
  'report.submitA11y': 'Submit report',
  'report.submit': 'Submit report',
  'report.submitting': 'Sending…',
  'report.errorNoSession': 'You need an active session to submit a report.',
  'report.errorSubmit': 'Could not submit your report.',
  'report.minimizeA11yHint': 'Long press to minimize',
  'report.expandA11y': 'Show report button',

  // Account / auth controls (sign-in is inline in Settings).
  'account.signInApple': 'Sign in with Apple',
  'account.signInGoogle': 'Sign in with Google',
  'account.signInFailedTitle': 'Sign in failed',
  'account.signInFailedBody': 'Could not complete sign in.',

  // Action sheet (bottom menu).
  'actionSheet.dismissA11y': 'Dismiss menu',

  // Collection picker.
  'collectionPicker.changeA11y': 'Change collection',
  'collectionPicker.current': '📁  {name}',
  'collectionPicker.inbox': 'Inbox',
  // Distinct a11y label for the unfiled (no-collection) row — see the matching
  // note on inbox.inboxNoCollectionA11y.
  'collectionPicker.inboxA11y': 'Inbox (no collection)',
  'collectionPicker.findOrCreateA11y': 'Find or create a collection',
  'collectionPicker.findOrCreatePlaceholder': 'Find or create…',
  'collectionPicker.inboxNone': 'Inbox',
  'collectionPicker.createA11y': 'Create collection {name}',
  'collectionPicker.create': '＋ Create “{name}”',

  // Tag field.
  'tagField.addTagA11y': 'Add a tag',
  'tagField.placeholderEmpty': 'Add tags…',
  'tagField.placeholderMore': 'Add…',
  'tagField.noTags': 'No tags yet',
  'tagField.browseA11y': 'Browse #{name}',
  'tagField.removeA11y': 'Remove tag {name}',
  'tagField.acceptSuggestionA11y': 'Accept suggested tag {name}',
  'tagField.dismissSuggestionA11y': 'Dismiss suggested tag {name}',
  'tagField.addAll': 'Add all',
  'tagField.addAllA11y': 'Add all suggestions',
  'tagField.dismissAll': 'Dismiss all',
  'tagField.dismissAllA11y': 'Dismiss all suggestions',
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

/** A non-default locale's catalog: every key optional, falls back to English. */
export type Catalog = Partial<Record<MessageKey, Message>>;
