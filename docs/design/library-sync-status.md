# Library sync status

The Inbox status beside the saved count describes the entire **cloud sync**
flow rather than one upload. Bookmark creates/updates/deletes, the tag journal
(including removal tombstones waiting for pull acknowledgement), imported
folder assignments, imported enrichment restores, and an active account pull
all participate. Metadata fetching and AI generation remain independent; a
cloud sync completion does not claim they have finished.

`buildLibrarySyncFlow` projects those channels into one observation. Remaining
counts include failed/backoff work, not only entries currently eligible for
upload. Permanently unsyncable bookmark entries are excluded from this cloud
flow, while their item-level diagnostics remain available. Tags, imported
folders, and enrichment restores whose never-synced owner is permanently
blocked are excluded too; dependents of already-synced owners still count. A failed pull is retained even with an empty outbox, so it cannot be
mistaken for completion. Successful pulls clear that observation. Account
changes clear its history; account identity also scopes the UI display history.

| Observation | Presentation |
| --- | --- |
| Idle on opening the screen | Hidden; never invent a completion. |
| Work finishes within 1.5 seconds | Hidden, including completion. |
| Work continues for 1.5 seconds | Syncing; keep it while any cloud channel remains. |
| All work and the active sync pass finish | Sync complete for 2.5 seconds, then hide. |
| New work during completion | Switch to Syncing immediately in the same slot. |
| Short retryable failure | Quiet retry; retain an already-visible Syncing label. |
| Retry delay persists for 15 seconds | Sync delayed, retrying automatically. |
| Explicitly observed offline | Will sync automatically when connected; immediate. |
| User pauses sync | Sync paused; tapping opens Settings. |
| Provider error with retained failed pull | Sign in recovery, even with empty outboxes; no automatic-retry promise. |
| Session expired | Sign in to resume; immediate sign-in action. |
| HTTP 401 with an active provider session | Open sync details; manual retry forces token refresh. |
| HTTP 403 | Explain access denial and open sync details in Settings. |
| Three ordinary non-transport failures | Needs attention; open sync details in Settings. |

Blocking observations override display timers. Unknown network state and DNS
errors are not relabelled as an observed offline device. HTTP error provenance
is recorded while the actual response status is available, including in
bookmark, tag, import-folder, and enrichment-restore outboxes. Legacy error
text is not parsed to invent an HTTP status.

The saved-count row has a reserved minimum height and the status stays on one
line, including narrow screens. Routine visibility changes do not move the
header or list. Action-required banners remain in the existing banner area.
Local-only/guest persistence claims still require a matching durable read.

## Automatic retry contract

Failed bookmark uploads and pull failures now have a timer; waiting for the
next save is not sufficient to promise automatic recovery. Upload retries use
the existing backoff (5s, 15s, 30s, 1m, 2m, then 5m; transport failures have a
3x multiplier), without forcing a pass or bypassing `isSyncable`. Timer wakeups
use absolute deadlines; overdue eligible work can wake immediately. Creates
waiting for metadata are excluded rather than repeatedly waking an empty pass.
Legacy queue rows without attempt timestamps use a stable hydration anchor;
legacy import followups use that anchor for their initial 30s wait.
The existing tag retry timer follows the same action-required policy.

Use the [sync change review guide](sync-change-review.md) when changing this
contract or addressing review findings across its channels.

Transport errors and HTTP 408/429/5xx remain automatically retryable. Authentication/permission
errors and ordinary failures after three attempts require inspection instead
of an automatic retry loop. The existing explicit Settings sync action remains
available even when a failed pull has an empty bookmark queue or only other
cloud channels remain. For a rejected session it forces refresh first; a null
refresh result never falls back to the rejected bearer token. Actual expiry
then exposes the provider's sign-in UI. Ordinary sync triggers retain their
existing upload backoff. Bookmark selection, both followup drivers, and the tag journal enforce
retry-kind eligibility and per-item ready-at deadlines on ordinary passes;
explicit manual force overrides them. A successful sign-in or credential
refresh permits one recovery pass for stale auth failures across all channels,
only after account ownership is reconciled. This does not override permission
or exhausted ordinary failures; a fresh 401 under the same credentials stops
again. Cold-start restoration carries an explicit successful-server-refresh
revision from the auth provider; cached session reads do not authorize recovery.
Same-account credential recovery retains the AI quota cooldown. Legacy failed followups without
a timestamp share a stable hydration anchor for their initial 30-second wait.
Tag health alerts retain the ordinary three-failure threshold for HTTP/API
errors; only DNS/network failures use six. Retryable HTTP item chips retain
recoverable queued wording after health escalation without changing reporting.

The pull driver checks its own retry deadline and eligibility even when
another channel or unrelated save starts a sync. A manual force can override
this wait; reconnect uses the normal readiness policy. A skipped pull keeps
its failure observation and does not claim a completed full-sync stamp.
Settings hides the manual sync action while offline and shows an accessible
connectivity indicator instead. Its Activity summary also reflects incomplete
cloud phases when bookmark processing counts are zero, so failed pulls never
claim all work complete. Detail chips identify auth/permission failures from
the first failed attempt in both English and Korean.

A successful remote-and-local library reset clears retained pull failures
and deferred sync flags; failed resets preserve failure observations. Reset
ownership cancels retry timers and synchronously gates sync requests, avoiding
queued duplicate pulls after the wipe.

Retry timers are cancelled while resetting the library, offline, paused, busy, without an active
session, or before local cache ownership has been reconciled. Reconnecting
wakes the normal sync path once and respects remaining upload backoff; an
offline-only request does not queue an extra deferred pass. Offline sync
still performs the same local ownership reconciliation as paused sync, so an
account switch cannot expose the previous account's cache. Already-running
requests are not cancelled or assumed to have failed by a connectivity event.

Connectivity uses the SDK-compatible `expo-network` observer, with cleanup,
unknown-state fallback, and protection against a late initial observation
overwriting a newer event. Uninformative listener events do not supersede
authoritative observations or erase known connectivity. A new native build is needed for the added module.
See the [Expo Network documentation](https://docs.expo.dev/versions/v56.0.0/sdk/network/).

Tests cover transition sequences, all cloud channels, HTTP provenance,
backoff deadlines, restored failed uploads, failed pulls with empty outboxes,
pause/session/offline cancellation, reconnect, and network observer ordering.

Settings advertises cloud progress only with an active cloud session. Its
manual sync control also checks observed connectivity independently of the
aggregate phase, because authentication and permission failures take priority
over offline in that projection. Native image uploads preserve non-success
HTTP status in `SupabaseRequestError` so they share the same authentication,
permission, and retryable HTTP policies as bookmark requests.

Retry wakeups use absolute deadlines, including immediately due work; unrelated
local bookmark changes cannot add another minimum delay. A tag upload already
in flight retains recovered credentials for its coalesced replay, scoped to the
same account and bearer. Fetch `AbortError` failures use transport backoff and
remain automatically recoverable beyond three attempts.

Recoverable HTTP uploads remain in the cloud processing stage even after health
escalation. Retry wakeups exclude creates waiting for metadata and use a stable
hydration anchor for legacy queue rows without attempt timestamps. Direct tag
removals schedule a local confirming pull when no main sync is running.
Credential recovery is consumed only after successful ownership reconciliation
and durable snapshot reads, so an early failure does not discard that proof.
