---
"@adonis-agora/telescope": minor
---

Alert integrations: PagerDuty, Opsgenie, Better Stack, incident.io, Grafana OnCall, native Discord, Microsoft Teams, Telegram, Google Chat and email (`@adonisjs/mail`) channels, with incidents that open and resolve with the alert, retries with backoff, and per-rule routing (`severity`, `channels` on rules, `minSeverity` on channels). New `heartbeats` (healthchecks.io, Better Stack, Cronitor, Uptime Kuma, UptimeRobot, any URL) ping only while the app is healthy; `statusPages` keep Atlassian Statuspage, Instatus and Better Stack components in step with the checks; `uptimeEndpoint()` serves the check states to HTTP uptime monitors.
