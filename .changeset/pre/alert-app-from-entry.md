---
'@adonis-agora/telescope': patch
---

Alerts about an exception now name the app that recorded it (its `app:` tag) instead of the server that evaluated the rule: on a control plane, an exception from a tenant used to be reported as the central server. The exception context carries `app`, the chat/incident integrations' `App` and the console summary use it, and the Slack card adds an `App` field.
