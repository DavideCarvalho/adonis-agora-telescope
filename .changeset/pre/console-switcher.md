---
'@adonis-agora/telescope-ui': minor
---

Console switcher and global search. Telescope joins the shared `'agora.consoles'` registry (title "Telescope", order 20) with no config; when the app runs other Agora consoles, the sidebar brand becomes a menu of the ones the viewer may open (each decided by that console's own `authorize`), and the `⌘K` palette also searches Telescope entries (by id, trace id or text) and every other console the viewer may open. New routes: `GET <path>/api/consoles` and `GET <path>/api/consoles/search?q=`, behind the console `authorize`. While the switcher runs another console's gate, `ctx.agoraProbe` is `true`.
