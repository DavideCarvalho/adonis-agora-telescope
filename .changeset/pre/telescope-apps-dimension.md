---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

One console for several apps. Entries tagged `app:<id>` (written by a central Telescope server) get an App dimension next to Organization: console `authorize` can return `apps: '*' | string[]` (also `authorizeByToken({ apps })`), and every read honours it: entries, counts, traces, Pulse, exceptions, the live tail, ⌘K search and the MCP tools on `/mcp/agora`. `GET <path>/api/apps` lists the apps a viewer may pick (labels from `telescope_ui.apps.labels`), every API route accepts `?app=<id>` (combined with `?tenant=`), `node ace telescope:apps:list` and `--app` on every `telescope:*` read. The console header gets an App picker next to the Organization one, hidden when no entry carries an app tag, so a standalone app looks and behaves as before. ⌘K search now also honours the viewer's organizations.
