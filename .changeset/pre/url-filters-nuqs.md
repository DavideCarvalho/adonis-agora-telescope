---
"@adonis-agora/telescope-ui": minor
---

Console filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and back/forward step through it: Entries (`type`, `q`, `live`, page cursor), Traces (page cursor), a trace's tab, the time window on Pulse, Exceptions, Screens and AI, the Screens kind, the Fleet role, the open queue and profile, and the Exports form. They sit in the hash's query (`#/entries?type=query&q=users`); a value at its default is left out, so existing `#/<page>` links open as before.
