---
"@adonis-agora/telescope": minor
"@adonis-agora/telescope-ui": patch
---

Two things the dashboard couldn't tell you about a browser-reported error: **who** it happened
to, and **where to click** to see it.

**`client_exception` is now attributed to the session user.** The ingestor took `user` from the
request body alone, and no front-end reporter ships the logged-in user by default — so in
practice every browser error recorded `user: null` and the dashboard's User column sat empty on
a fully authenticated session. It now reads the `@adonis-agora/context` `userRef()`, resolved
server-side on that same request (the endpoint sits behind the host's normal middleware stack).

The precedence is a trust decision, not a preference: the endpoint is **public**, so anything in
the body is a claim a caller could forge for someone else's id. The server-derived context wins
whenever both are present. The body claim is still honoured when the context has nothing — an
anonymous page, or a host without `@adonis-agora/context` — because a self-reported id beats no
attribution when there is nothing to contradict it.

**Exception groups carry their entry type.** `ExceptionGroupStats` and `PulseExceptionGroup` gain
a `type` (`exception` or `client_exception`), and the dashboard's Exceptions rows deep-link into
the entries list filtered by *that row's* type. The link used to hard-code `exception`, so every
click on a browser error landed on a list that by construction could not contain it — "0 shown"
on a row that had just reported 26 occurrences.

A group spans one type in practice, since grouping is by `familyHash` and a server throw's hash
never collides with a browser report's; when two entries of different types do share a key, the
group takes the type of the first seen in the window.
