---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Libraries can plug their pages into Telescope with no app config: push a `TelescopeExtension` into the `'agora.telescope.extensions'` container binding from your provider's `register()` (create the array when absent). Telescope reads it at boot next to `config.extensions`; a configured extension with the same `name` wins.

Extensions can also declare `actions`: server-side writes a table column triggers on its row (`column.action`), after a confirmation dialog. Every call runs behind the console's `authorize`, needs `{ confirmed: true }`, and is audited (log line + a `diagnostic` entry tagged `event:extension-action`). Console writes now send shield's `X-XSRF-TOKEN` header when the `XSRF-TOKEN` cookie is present.
