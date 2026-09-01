---
"@adonis-agora/telescope": minor
---

Three things the dashboard was quietly getting wrong: response status, user attribution, and
whether a browser error counts as an error.

**Response status was `null` on every AdonisJS request.** The watcher read
`ctx.response.statusCode`, but an Adonis `Response` has no such property — its status lives
behind `getStatus()` (the `statusCode` it wraps belongs to the Node `ServerResponse`, one level
down). So every `request` entry recorded `status: null`, no `status:<code>` tag was ever emitted,
and the pulse **error rate — computed from the 4xx/5xx breakdown — sat at 0% no matter how many
requests were failing**. The optional `statusCode?: number` on `ResponseLike` could not catch it:
any object satisfies it. `ResponseLike` now declares both accessors and the watcher prefers
`getStatus()`, falling back to `statusCode` for Node/Express-style hosts (and a throwing accessor
degrades to `null` instead of losing the entry).

**User attribution now works with asynchronous auth guards.** `ctx.auth.user` is the
`@adonisjs/auth` convention: a *synchronous* property. A guard that only resolves through
`await getUser()` has nothing there at record time, so those stacks recorded `user: null` for
fully authenticated sessions — the User column and every `user:<id>` tag were dead. The watcher
now falls back to `userRef()` from the `@adonis-agora/context` accessor, which such hosts already
publish per request. The guard still wins when it exposes a user; the fallback costs one property
read and is skipped entirely when `@adonis-agora/context` is absent.

**`client_exception` counts as an exception in metrics.** The alert poller has always read both
`exception` and `client_exception`, but the metrics side hard-coded the server type — so a
front-end-only incident paged on Slack/Discord while the overview it linked to rendered
"Error rate 0.0% · No exceptions recorded 🎉". `summarizePulse` now classifies both,
`summarizeStats` computes exception groups for both, and `MetricsService.getStats` collects both
when asked for either (one `list` per type, mirroring the poller, since `EntryQuery.type` is a
single value). The dashboard's Exceptions section starts showing browser errors with no UI change.

The shared definition now lives in one place — new `EXCEPTION_ENTRY_TYPES` and `isExceptionType`
exports — because that list living in two places is exactly how the two sides drifted apart. Also
exports `currentUserRef` and the `UserRef` type alongside the existing `currentTraceId`.
