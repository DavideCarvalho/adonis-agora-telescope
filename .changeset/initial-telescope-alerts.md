---
"@adonis-agora/telescope-alerts": minor
---

Initial release of alerting for `@adonis-agora/telescope`. Detects noteworthy events —
primarily new exception families (first-seen, or re-occurring after the window
elapses / an explicit resolve) — and dispatches rich alerts to channels. Ships:

- Channels: `slackChannel` (Block Kit to a Slack incoming webhook), `webhookChannel`
  (raw JSON POST), `consoleChannel` (one-line summary, zero-config default), and
  `customChannel` (arbitrary async sink). HTTP channels use global `fetch` with a 5s
  abort timeout; a channel failure is isolated and warn-logged, never thrown.
- `NewExceptionTracker` — bounded, per-process first-seen dedupe with explicit
  `resolve(hash)` so a resolved family pages again on its next occurrence.
- `Alerter` — wires exception entries → rules (`new-exception`, `exception-rate`)
  → channels, with per-family / per-rule cooldown throttling.
- `ExceptionPoller` — the hook point: polls the telescope store on an unref'd
  interval for new `exception` entries (high-water mark on `createdAt`) and feeds
  them to the alerter. No core modification; fully testable via `pollOnce()`.

A provider reads `config/telescope_alerts.ts` (default: enabled, console channel,
new-exception rule, 30s poll), resolves the runtime store, and starts/stops the
poller on boot/shutdown. Ships `configure.ts` + stub.
