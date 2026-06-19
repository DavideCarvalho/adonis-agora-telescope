# @agora/telescope-alerts

Alerting on top of [`@agora/telescope`](../core). Detects noteworthy events —
primarily **new exception families** (an exception signature seen for the first
time, or re-occurring after being resolved) — and dispatches rich alerts to
Slack, a generic webhook, the console, or any custom channel.

## Install

```sh
npm i @agora/telescope-alerts
node ace configure @agora/telescope-alerts
```

`configure` registers the provider in `adonisrc.ts` and publishes
`config/telescope_alerts.ts`.

## How it hooks in (polling)

The headless `@agora/telescope` core does not expose a "new entry" event, and this
package intentionally does **not** modify core. Instead, the provider starts an
`ExceptionPoller` that reads the telescope **store** on an interval (default 30s)
for `exception` entries recorded since the previous poll (a high-water mark on
`createdAt`) and feeds them to the `Alerter`. This keeps the hook fully testable
(drive `poller.pollOnce()` directly) and decoupled from any specific watcher. The
poll timer is `unref`'d, so it never keeps the process alive on its own.

> The store resolves through the core's runtime slot (the same cross-copy-stable
> handle the watchers record through) — no dependency injection required.

## Channels

Each fired alert fans out to **every** configured channel concurrently; one
channel failing never blocks the others, and a channel failure is warn-logged
(rate-limited per channel) rather than thrown into the host.

- **`{ type: 'slack', url }`** — POSTs Block Kit JSON to a Slack incoming webhook:
  a severity header, fielded context (route/method/status/user/occurrences), a
  truncated stack snippet, and an "Open in Telescope" deep link when `dashboardUrl`
  is set.
- **`{ type: 'webhook', url }`** — POSTs the raw `AlertPayload` as JSON.
- **`{ type: 'console' }`** — logs a one-line summary (the zero-config default).
- **`customChannel(fn, name)`** — an arbitrary async sink (email, PagerDuty, …).

HTTP channels use the global `fetch` (Node 18+), race every request against a 5s
abort timeout, and treat a non-2xx response as a failure.

## Rules

- **`{ type: 'new-exception', window }`** — fires the first time an exception
  `familyHash` is seen within `window`, and again if the family re-appears after
  the window elapses, or after an explicit `alerter.resolveFamily(hash)` (the
  "resolved → re-occurred" signal). Deduped per-process by `NewExceptionTracker`.
- **`{ type: 'exception-rate', window, threshold }`** — fires when `>= threshold`
  exception entries land in the trailing `window`.

Both are rate-limited by a per-rule / per-family `cooldown` (default 15m).

## Config

```ts
import { defineConfig } from '@agora/telescope-alerts'

export default defineConfig({
  channels: [
    { type: 'slack', url: env.get('TELESCOPE_SLACK_WEBHOOK') },
  ],
  rules: [{ type: 'new-exception', window: '1h' }],
  dashboardUrl: 'https://telescope.example.com/',
  every: '30s',
  cooldown: '15m',
})
```

## Status

`exception` entries are recorded once an exception watcher is wired into your app.
The `Exception` entry type is a stable, reserved type in `@agora/telescope`; this
package reads it generically (`class`/`name`, `message`, `stack`, `route`/`uri`,
`method`, `statusCode`, and a `user:<id>` tag), so it works with any source of
exception entries.
