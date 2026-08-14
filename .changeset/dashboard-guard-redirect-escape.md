---
"@adonis-agora/telescope": patch
---

`enforceGuard` now honors a redirect a custom `authorize` hook already wrote to the response (a `location` header, typically via `ctx.response.redirect(...)`) instead of always overwriting it with the default `401`/`403 { error }` JSON — mirrors `@adonis-agora/durable`'s dashboard guard, which already does this. Lets a host show its own branded "log in" / "access denied" page instead of raw JSON, without needing a separate config hook: redirect from inside `authorize`, return `false`, done.

`UiResponse` (the framework-light response contract `guard.ts` and the JSON API handlers share) gained `getHeader(name)` to make the check possible; `RecordingResponse` (the in-memory test double) implements it too.
