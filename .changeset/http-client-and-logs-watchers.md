---
"@agora/telescope": minor
---

Add two watchers: an **http-client** watcher that records outbound `fetch` calls (method, sanitized url, host, status, duration) by wrapping the Node global `fetch`, and a **logs** watcher that records AdonisJS logger output (level, message, bounded structured fields) by teeing the level methods on the container logger instance. Both are opt-in via `config/telescope_watchers.ts` (`watchers: ['http-client', 'logs']`), record through the central redaction layer, and restore their hooks on shutdown.
