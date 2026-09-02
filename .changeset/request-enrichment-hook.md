---
"@adonis-agora/telescope": minor
---

New `requestEnrichment` hook: attach what only your app knows to every `request` entry.

```ts
// config/telescope.ts
requestEnrichment: (ctx) => {
  const screen = ctx.request.header('x-screen')
  return typeof screen === 'string' ? { tags: [`screen:${screen}`] } : undefined
}
```

The motivating case is one the dashboard could not answer: **which requests came from
which front-end screen?** Telescope sees `GET /api/v1/researcher/projects` and has no idea
whether the writing page or the dashboard asked for it. The browser knows; it just had no
way to say so. Now it sends its current page in a header, the host turns that into a
`screen:<name>` tag, and the existing tag filter does the rest — no new UI, no new query
API.

Three optional fields on the returned object:

- **`tags`** — appended to the derived ones. Tags are how the dashboard filters, so this is
  where anything you want to slice by belongs. Capped at 16 tags of 128 characters
  (`MAX_ENRICHMENT_TAGS` / `MAX_ENRICHMENT_TAG_LENGTH`, both exported); blanks and
  non-strings are dropped.
- **`context`** — free-form fields under `content.context`, for detail you want to read but
  not filter by. Declared before `body` in the content so the recorder's byte budget, which
  drops keys in insertion order, cannot let a captured megabyte-sized body starve out a few
  short context fields.
- **`user`** — for hosts where neither `ctx.auth.user` nor the `@adonis-agora/context`
  `userRef()` applies. Wins over both; an explicit `options.user` on `recordRequest` still
  wins over it.

The hook is **synchronous** on purpose. It runs on the recording path of every request, so
an `await` here — a DB lookup for the user, say — would put host I/O between the response
and the next request. Read what is already on the `ctx`.

A bad hook cannot cost you the entry: a throw, a `null`, a string, an array, a thousand
tags, a non-object `context` — every one of them degrades to recording exactly what would
have been recorded without the hook.

Additive: no config change required and behavior is unchanged when `requestEnrichment` is
unset. Also exports the `RequestEnrichment` / `RequestEnrichmentResult` types.
