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
  'app.tagline': 'Save now. Organize later.',

  // Shared, reused across screens.
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.share': 'Share',
  'common.open': 'Open',
  'common.openLink': 'Open link',
  'common.archive': 'Archive',
  'common.unarchive': 'Unarchive',
  'common.back': '‹ Back',
  'common.signIn': 'Sign in',
  'common.signOut': 'Sign out',
  'common.manage': 'Manage',
  'common.untitled': 'Untitled',

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
  'nav.archived': 'Archived',
  'nav.bookmark': 'Bookmark',

  // Inbox (home).
  'inbox.savedCount': '{count} saved',
  'inbox.storageError':
    'Couldn’t open local storage — showing sample data. Your saves this session may not persist. Tap to report ›',
  'inbox.reportStorageProblem': 'Report storage problem',
  'inbox.searchPlaceholder': 'Search your stash',
  'inbox.browse': 'Browse',
  'inbox.sortFieldA11y': 'Sort field: {field}',
  'inbox.sortDirectionA11y': 'Sort direction: {direction}',
  'inbox.sortDirectionAscending': 'ascending',
  'inbox.sortDirectionDescending': 'descending',
  'inbox.sortFieldDate': 'Date',
  'inbox.sortFieldName': 'Name',
  'inbox.sortNewest': 'Newest',
  'inbox.sortName': 'Name',
  'inbox.sortAsc': '↑ Asc',
  'inbox.sortDesc': '↓ Desc',
  'inbox.viewAsA11y': 'View as {mode}',
  'inbox.filterAll': 'All',
  'inbox.filterNoCollection': 'No collection',
  'inbox.sectionMatches': 'Matches ({count})',
  'inbox.sectionNoCollection': 'No collection · {count}',
  'inbox.sectionFacet': '{label} · {count}',
  'inbox.sectionRecent': 'Recently saved',
  'inbox.loading': 'Loading your bookmarks…',
  'inbox.emptySearch': 'No bookmarks match your search.',
  'inbox.emptyView': 'Nothing in this view yet.',
  'inbox.emptyAll': 'Nothing saved yet. Add your first bookmark below.',
  'inbox.moveToCollectionAction': 'Move to collection…',
  'inbox.moveToCollectionTitle': 'Move to collection',
  'inbox.inboxNoCollection': 'Inbox (no collection)',
  'inbox.aiSuggestionsA11y': { one: '{count} AI suggestion', other: '{count} AI suggestions' },
  'inbox.inCollection': 'in {name}',
  'inbox.addBookmark': 'Add bookmark',
  'inbox.openExternal': 'Open ↗',
  'inbox.settingsA11y': 'Settings',
  'inbox.tagCloudHeader': 'Tags · {count}',
  'inbox.tagCloudTagA11y': {
    one: '#{name}, {count} bookmark',
    other: '#{name}, {count} bookmarks',
  },
  'inbox.tagCloudEmpty': 'No tags yet. Tag a bookmark to see it here.',

  // View-mode labels (Inbox layout density).
  'viewMode.card': 'Cards',
  'viewMode.list': 'List',
  'viewMode.cloud': 'Tag cloud',

  // Add bookmark.
  'add.urlLabel': 'URL',
  'add.urlPlaceholder': 'https://',
  'add.noteLabel': 'Note (optional)',
  'add.notePlaceholder': 'Why are you saving this?',
  'add.save': 'Save bookmark',
  'add.hint':
    'Saved instantly to your device and synced to the cloud in the background — capture never waits on the network.',

  // Capture toasts (also used by the share flow).
  'toast.saved': 'Saved to Stash',
  'toast.duplicate': 'Already in Stash',
  'toast.noLink': 'No link found to stash',

  // Settings.
  'settings.account.signedIn': 'Signed in',
  'settings.account.cloudUnavailable': 'Cloud sync unavailable',
  'settings.account.notSignedIn': 'Not signed in',
  'settings.account.syncedAcrossDevices': 'Synced across your devices',
  'settings.account.worksOffline': 'Stash works fully offline',
  'settings.account.signInToBackup': 'Sign in to back up & sync',
  'settings.sync.label': 'Sync',
  'settings.sync.syncing': {
    one: 'Syncing {count} item…',
    other: 'Syncing {count} items…',
  },
  'settings.sync.upToDate': 'Up to date',
  'settings.sync.localOnly': 'Local only',
  'settings.sync.waiting': {
    one: '{count} item waiting to upload',
    other: '{count} items waiting to upload',
  },
  'settings.sync.queuedOffline': '{count} queued — offline',
  'settings.review.label': 'Review AI suggestions',
  'settings.review.toReview': '{count} to review',
  'settings.review.nothing': 'Nothing to review',
  'settings.library.label': 'Library',
  'settings.library.value': '{inbox} in inbox · {archived} archived',
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

  // Archived.
  'archived.empty':
    'Nothing archived. Archived bookmarks stay out of your Inbox but remain searchable and restorable here.',

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
  'detail.notesA11y': 'Notes',
  'detail.notesPlaceholder': 'Add a note…',
  'detail.tagsDisabledHint': 'Tags can be edited once this bookmark has synced.',
  'detail.currentlyIn': 'Currently in: {name}',
  'detail.aiWorking': 'Working…',
  'detail.aiStale':
    'These suggestions may be out of date since you edited this bookmark — refresh to update them.',
  'detail.aiTagsHint': 'Suggested tags are in the Tags field above — tap a “＋” chip to add.',
  'detail.aiSuggestedCollection': 'Suggested collection: file into “{name}”',
  'detail.aiFileIntoA11y': 'File into {name}',
  'detail.aiGenerating': 'Generating suggestions…',
  'detail.aiRefresh': 'Refresh AI suggestions',
  'detail.aiSuggest': 'Suggest with AI',
  'detail.aiNeedsSync': 'AI suggestions are available once this bookmark has synced.',
  'detail.aiNoNew': 'No new suggestions right now.',
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
  'review.acceptAll': 'Accept all',
  'review.acceptTagA11y': 'Accept suggested tag {name} for {title}',
  'review.acceptAllA11y': 'Accept all suggested tags for {title}',
  'review.confidence': '{percent}%',

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

  // Account / auth controls.
  'account.signInApple': 'Sign in with Apple',
  'account.signInGoogle': 'Sign in with Google',
  'account.cloudNotConfigured':
    'Cloud sync isn’t configured on this build, so account sign-in is unavailable. Stash still works fully offline.',
  'account.signedInAs': 'Signed in as {email}',
  'account.signedIn': 'Signed in',
  'account.syncSubtitle': 'Your bookmarks sync to this account across devices.',
  'account.signInHeading': 'Sign in to sync across devices',
  'account.signInSubtitle':
    'You’re browsing anonymously. Sign in to back up your stash and keep it in sync — your current bookmarks come with you.',
  'account.signInFailedTitle': 'Sign in failed',
  'account.signInFailedBody': 'Could not complete sign in.',

  // Action sheet (bottom menu).
  'actionSheet.dismissA11y': 'Dismiss menu',

  // Collection picker.
  'collectionPicker.changeA11y': 'Change collection',
  'collectionPicker.current': '📁  {name}',
  'collectionPicker.inbox': 'Inbox',
  'collectionPicker.findOrCreateA11y': 'Find or create a collection',
  'collectionPicker.findOrCreatePlaceholder': 'Find or create…',
  'collectionPicker.inboxNone': 'Inbox (none)',
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
  'tagField.dismissAll': 'Dismiss all',
  'tagField.dismissAllA11y': 'Dismiss all suggestions',
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

/** A non-default locale's catalog: every key optional, falls back to English. */
export type Catalog = Partial<Record<MessageKey, Message>>;
