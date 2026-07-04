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
  'app.name': 'Stash',
  // Locale-native wordmark shown beside the brand name (e.g. 스태시 in Korean).
  // Defaults to the brand name itself, which the hero reads as "no native
  // wordmark" and renders just "Stash"; locales override it to opt in.
  'app.nameLocal': 'Stash',
  'app.tagline': 'Save now. Organize later.',

  // Shared, reused across screens.
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.share': 'Share',
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
  'status.complete': 'complete',
  'status.skipped': 'skipped',

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

  // Inbox (home).
  'inbox.savedCount': '{count} saved',
  'inbox.storageError':
    'Couldn’t open local storage — showing sample data. Your saves this session may not persist. Tap to report ›',
  'inbox.reportStorageProblem': 'Report storage problem',
  'inbox.searchPlaceholder': 'Search titles, tags, folders',
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
  'inbox.emptySearchHint': 'Search also looks in tags, folders, and site names.',
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
  // Site-name chip on a search result (generated site metadata, not a user
  // field). Marks WHY a result matched when nothing else on the card shows it.
  'inbox.siteChip': '🌐 {name}',
  'inbox.emptyView': 'Nothing in this view yet.',
  'inbox.emptyTitle': 'Your stash is empty',
  'inbox.emptyHintShare': 'Share a link from any app and pick Stash to save it in a tap.',
  'inbox.emptyHintAdd': 'Or tap ＋ below to add one by hand.',
  'inbox.moreActions': 'More actions',
  'inbox.moveToCollectionAction': 'Move to collection…',
  'inbox.moveToCollectionTitle': 'Move to collection',
  'inbox.inboxNoCollection': 'Inbox',
  // Distinct screen-reader label so the unfiled option never sounds identical to
  // a user collection that happens to be named "Inbox" (the visible row stays
  // the clean "Inbox", the tray icon disambiguates it visually).
  'inbox.inboxNoCollectionA11y': 'Inbox (no collection)',
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
  'inbox.addBookmark': 'Add bookmark',
  'inbox.openExternal': 'Open ↗',
  'inbox.settingsA11y': 'Settings',
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
  // Header titles, by scope: whole library / a folder / the uncollected set.
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
  'search.folderChipA11y': 'Filter by folder {name}',
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

  // Add bookmark.
  'add.urlLabel': 'URL',
  'add.urlPlaceholder': 'https://',
  'add.noteLabel': 'Note (optional)',
  'add.notePlaceholder': 'Why are you saving this?',
  'add.save': 'Save bookmark',
  'add.hint': 'Saved instantly. Sync happens in the background.',
  'add.saving': 'Saving…',

  // Capture toasts (also used by the share flow).
  'toast.saved': 'Saved to Stash',
  'toast.savedCount': { one: 'Saved to Stash', other: '{count} saved to Stash' },
  'toast.duplicate': 'Already in Stash',
  'toast.trashed': 'Moved to Trash',
  'toast.noLink': 'No link found to stash',

  // Settings.
  'settings.section.account': 'Account',
  'settings.section.library': 'Library',
  'settings.section.preferences': 'Preferences',
  'settings.section.data': 'Your data',
  'settings.section.advanced': 'Advanced',
  'settings.section.browser': 'Save from your browser',
  'settings.bookmarklet.button': '⊕ Save to Stash',
  'settings.bookmarklet.copied': 'Copied!',
  'settings.bookmarklet.note':
    'Drag this button to your bookmarks bar (or click to copy it). Then click it on any page to stash it.',
  'settings.account.signedIn': 'Signed in',
  'settings.account.signIn': 'Sign In',
  'settings.account.sessionExpired': 'Session expired',
  'settings.account.sessionExpiredBody': 'Sign back in to resume syncing. Your bookmarks are safe.',
  'settings.account.signOut': 'Sign out',
  'settings.account.cloudUnavailable': 'Cloud sync unavailable',
  'settings.account.worksOffline': 'Stash works fully offline',
  'settings.account.signOutConfirmTitle': 'Sign out of Stash?',
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
  'settings.sync.waiting': {
    one: '{count} item waiting to upload',
    other: '{count} items waiting to upload',
  },
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
  'settings.dataNote':
    'Your bookmarks are yours. Export a standard HTML file any browser or bookmark app can import, a CSV for spreadsheets, or a full JSON backup — anytime, even offline.',
  'settings.share.label': 'Open Inbox after sharing',
  'settings.share.inbox': 'Shared links open the Inbox',
  'settings.share.toast': 'Shared links just show a toast',
  'settings.search.clearLabel': 'Clear search history',
  'settings.search.clearValue': '{count} recent searches',
  'settings.search.clearEmpty': 'No recent searches',
  'settings.search.clearConfirmTitle': 'Clear search history?',
  'settings.search.clearConfirmBody':
    'This removes your recent searches on this device. Your bookmarks and tags aren’t affected.',
  'settings.search.clearConfirm': 'Clear',
  'settings.developer.label': 'Developer mode',
  'settings.developer.value': 'Diagnostics, build info & sync queue',
  'settings.language.label': 'Language',
  'settings.language.system': 'System default',
  'settings.language.en': 'English',
  'settings.language.ko': '한국어',
  'settings.language.sheetTitle': 'App language',
  'settings.diagnostics.title': 'Diagnostics',
  'settings.diagnostics.supabaseAuth': 'Supabase auth',
  'settings.diagnostics.lastPulled': 'Last pulled',
  'settings.diagnostics.lastPulledNever': 'Never — arrives on next sync',
  'settings.diagnostics.appVersion': 'App version',
  'settings.diagnostics.build': 'Build',
  'settings.queue.title': 'Pending sync queue',
  'settings.queue.empty': 'The offline queue is empty.',
  'settings.queue.meta': '{operation} · {status} · retries {retries}',
  'settings.queue.lastError': 'last error: {error}',
  'settings.exportSheet.title': 'Export my data',
  'settings.exportSheet.html': 'Bookmarks file (HTML)',
  'settings.exportSheet.csv': 'Spreadsheet (CSV)',
  'settings.exportSheet.json': 'Full backup (JSON)',
  'settings.importSheet.title': 'Import data',
  'settings.importSheet.html': 'Bookmarks file (HTML)',
  'settings.importSheet.json': 'Stash backup (JSON)',
  'settings.importSheet.pocket': 'Pocket export (CSV)',
  'settings.export.failedTitle': 'Export failed',
  'settings.export.failedBody': 'Could not export your data. Please try again.',
  'settings.import.nothingTitle': 'Nothing to import',
  'settings.import.nothingBody': 'No bookmarks were found in {name}.',
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

  'update.title': 'Update Required',
  'update.body': 'This version of Stash is no longer supported. Please update to continue.',
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
  'detail.notesLabel': 'Note',
  'detail.notesA11y': 'Notes',
  'detail.notesPlaceholder': 'Add a note…',
  'detail.tagsDisabledHint': 'Tags can be edited once this bookmark has synced.',
  'detail.currentlyIn': 'Currently in: {name}',
  'detail.aiWorking': 'Working…',
  'detail.aiStale': 'Edited since these suggestions — refresh to update.',
  // Suggested folder, shown as a one-tap chip next to the collection picker.
  'detail.aiSuggestCollectionChip': '📁 ＋ {name}',
  'detail.aiFileIntoA11y': 'File into {name}',
  // Shown when no existing folder matches the AI's hint: create it and file in.
  'detail.aiCreateCollectionChip': '📁 ＋ Create “{name}”',
  'detail.aiCreateCollectionA11y': 'Create collection {name} and file into it',
  'detail.aiDismissCollectionA11y': 'Dismiss suggested collection {name}',
  // Micro-label above the folder suggestion pill under the collection picker.
  'detail.suggestedFolderLabel': 'Suggested folder',
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
  'detail.aiNeedsSync': 'AI suggestions are available once this bookmark has synced.',
  'detail.aiRateLimited': 'AI suggestions have hit their limit for now — try again a little later.',
  // Degraded mode: the result came from the basic heuristics, not the AI model.
  // Shown as a calm, non-error note so the cause is never hidden (M12); the
  // precise cause is forwarded to monitoring rather than spelled out in full.
  'detail.aiDegradedRateLimited':
    'AI is over capacity right now — showing basic suggestions. Try again shortly for AI suggestions.',
  'detail.aiDegradedUnavailable':
    'Couldn’t reach AI — showing basic suggestions for now. Refresh to try again.',
  'detail.aiDegradedBasic': 'Showing basic suggestions.',
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
  'detail.errorCreateCollection': 'Could not create the collection.',
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
  // folder (both folder kinds: file into an existing one, or create+file);
  // "Accept" / "Dismiss" are the folder-only (no tags) singulars.
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
  // match the Detail screen's folder chips: 📁 ＋ for a folder (collection,
  // tap = file in), # for a tag.
  'review.tagChip': '#{name}',
  'review.folderChip': '📁 ＋ {name}',
  'review.createFolderChip': '📁 ＋ Create “{name}”',
  // ADD vs CHANGE (move) folder forms. The "→" run targets are rendered as
  // separate <Text> children so the `from` name can be struck through and only
  // the arrow + target tinted; these strings are the non-strikethrough fallback
  // pieces / a11y labels. `addArrow` is "→ {name}" (file into an existing one);
  // `addCreateArrow` is "→ ＋ "{name}"" (create then file). For a move the chip
  // composes the struck `from` name with one of these arrows.
  'review.folderAddArrow': '📁 → {name}',
  'review.folderCreateArrow': '📁 ＋ Create “{name}”',
  'review.moveArrowTarget': '→ {name}',
  'review.moveCreateTarget': '→ ＋ “{name}”',
  // Chip a11y, per case (screen readers can't see the strikethrough).
  'review.acceptFolderA11y': 'File {title} into {name}',
  'review.createFolderA11y': 'Create collection {name} and file {title} into it',
  'review.moveFolderA11y': 'Move {title} from {from} to {name}',
  'review.moveCreateFolderA11y': 'Move {title} from {from} into a new collection {name}',
  'review.dismissFolderA11y': 'Dismiss suggested collection {name} for {title}',
  // A move overwrites a user-chosen collection_id; the chip already shows the
  // ~~from~~ → to, so instead of confirming we file it and offer an Undo toast.
  'review.movedToast': 'Moved to “{name}”',

  // Report a problem.
  'report.categoryBug': 'Bug',
  'report.categoryIdea': 'Idea',
  'report.categoryOther': 'Other',
  'report.cloudUnavailableTitle': 'Cloud reporting unavailable',
  'report.cloudUnavailableBody':
    'Submitting to the cloud isn’t configured on this build, but you can still share a diagnostics report (including recent logs) to send manually.',
  'report.categoryLabel': 'Category',
  'report.whatHappened': 'What happened?',
  'report.descriptionA11y': 'Problem description',
  'report.descriptionPlaceholder': 'Describe the problem or idea',
  'report.diagnosticContext': 'Diagnostic context',
  'report.privacyNote':
    'Includes app diagnostics and {count} recent log line(s) to aid debugging — not your bookmark list.',
  'report.contextPreviewA11y': 'Diagnostic context preview',
  'report.shareDiagnosticsA11y': 'Share diagnostics',
  'report.shareWithCount': 'Share diagnostics & logs ({count})',
  'report.share': 'Share diagnostics & logs',
  'report.success': 'Thanks — your report was sent.',
  'report.submitA11y': 'Submit report',
  'report.submit': 'Submit report',
  'report.submitting': 'Sending…',
  'report.errorNoSession': 'You need an active session to submit a report.',
  'report.errorSubmit': 'Could not submit your report.',

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
