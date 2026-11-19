---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Federated console: a console can show an app that keeps its entries in its own store. List it under `apps.federated` in `config/telescope_ui.ts` with its `store` (and optionally `commands`). Its entries, traces, Pulse, exceptions, Overview and Architecture are read straight from its store, every read bounded to an index and a page or time window. Actions (request replay, queue retry and enqueue) and live views (queues, schedules, health) are sent to the app over its Redis, where one instance runs each; the app opts in with `consoleCommands` in its `config/telescope.ts`. With no app picked, a trace's waterfall includes the spans federated apps recorded. The App picker tags federated apps and shows a notice while one is picked; `GET /api/apps` lists each app's `mode` and `actions`. `storage.lucid({ readOnly: true })` reads a table without creating or writing it.
