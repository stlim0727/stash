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
  'nav.apiKeys': 'API Keys',

  // Inbox (home).
  'inbox.savedCount': '{count} saved',
  'inbox.storageError':
    'Couldn’t open local storage — showing sample data. Your saves this session may not persist. Tap to report ›',
  'inbox.reportStorageProblem': 'Report storage problem',
  'inbox.searchPlaceholder': 'Search your stash',
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
  'toast.savedCount': { one: 'Saved to Stash', other: '{count} saved to Stash' },
  'toast.duplicate': 'Already in Stash',
  'toast.trashed': 'Moved to Trash',
  'toast.noLink': 'No link found to stash',

  // Settings.
  'settings.account.signedIn': 'Signed in',
  'settings.account.signIn': 'Sign In',
  'settings.account.signOut': 'Sign out',
  'settings.account.cloudUnavailable': 'Cloud sync unavailable',
  'settings.account.worksOffline': 'Stash works fully offline',
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
  'settings.review.label': 'Review AI suggestions',
  'settings.review.toReview': '{count} to review',
  'settings.review.nothing': 'Nothing to review',
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
  'review.acceptAll': 'Accept all',
  'review.dismissAll': 'Dismiss all',
  'review.acceptTagA11y': 'Accept suggested tag {name} for {title}',
  'review.acceptAllA11y': 'Accept all suggested tags for {title}',
  'review.dismissAllA11y': 'Dismiss all suggested tags for {title}',
  'review.goToA11y': 'Go to {title}',
  'review.confidence': '{percent}%',
  // Chip prefixes that distinguish the two kinds of suggestion at a glance:
  // 📂 for a folder (collection), # for a tag.
  'review.tagChip': '#{name}',
  'review.folderChip': '📂 {name}',
  'review.createFolderChip': '📂 Create “{name}”',
  'review.acceptFolderA11y': 'File {title} into {name}',
  'review.createFolderA11y': 'Create collection {name} and file {title} into it',
  'review.dismissFolderA11y': 'Dismiss suggested collection {name} for {title}',

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
  'tagField.addAll': 'Add all',
  'tagField.addAllA11y': 'Add all suggestions',
  'tagField.dismissAll': 'Dismiss all',
  'tagField.dismissAllA11y': 'Dismiss all suggestions',

  // API Keys screen (external AI client integration).
  'settings.apiKeys.label': 'API Keys',
  'settings.apiKeys.value': 'Connect ChatGPT, Claude, and other AI tools',
  'apiKeys.description':
    'API keys let external AI tools (like ChatGPT or Claude) read and organize your bookmarks. Each key is shown only once — copy it somewhere safe.',
  'apiKeys.guide.title': 'How to connect an AI tool',
  'apiKeys.guide.step1': 'Create a key below and copy it when shown.',
  'apiKeys.guide.step2':
    'In ChatGPT: open GPT Builder → Configure → Actions → "Import from URL" and paste the OpenAPI URL below.',
  'apiKeys.guide.step3':
    'Set authentication to Bearer Token and paste your key. In Claude or other tools, pass the key as the Authorization header.',
  'apiKeys.guide.copyUrlA11y': 'Copy OpenAPI URL',
  'apiKeys.namePlaceholder': 'Key name (e.g. "My ChatGPT")',
  'apiKeys.create': 'Create',
  'apiKeys.creating': 'Creating…',
  'apiKeys.empty': 'No API keys yet.',
  'apiKeys.lastUsed': 'Last used {date}',
  'apiKeys.neverUsed': 'Never used',
  'apiKeys.created.title': 'API key created',
  'apiKeys.created.body':
    'Copy your key now — it won\'t be shown again.\n\n{key}',
  'apiKeys.created.copy': 'Copy key',
  'apiKeys.revoke.title': 'Revoke key?',
  'apiKeys.revoke.body': 'This will permanently disable "{name}". Any AI tool using it will stop working.',
  'apiKeys.revoke.confirm': 'Revoke',
  'apiKeys.revokeA11y': 'Revoke key {name}',
  'apiKeys.requiresAuth': 'Sign in to manage API keys.',
  'apiKeys.note': 'Keys are scoped to your account. Revoking a key immediately blocks any tool using it.',
  'apiKeys.error.createTitle': 'Could not create key',
  'apiKeys.error.createBody': 'Please try again.',
  'apiKeys.error.revokeTitle': 'Could not revoke key',
  'apiKeys.error.revokeBody': 'Please try again.',
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

/** A non-default locale's catalog: every key optional, falls back to English. */
export type Catalog = Partial<Record<MessageKey, Message>>;
