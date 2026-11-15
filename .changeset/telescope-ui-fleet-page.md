---
"@adonis-agora/telescope-ui": minor
---

New **Fleet** page (Monitor section, and in ⌘K). For each app it shows instance counts by state (up, starting, draining, gone), every instance (host, version, uptime, last heartbeat, health, send buffer), the deploy timeline with rollout progress, hosts in a restart loop, and each failing health check with how long it has been failing ("Redis: down for 12 min on 3 of 3 instances") plus the exception families recorded since then. The page follows the App picker and refreshes every 15 s. It needs `@adonis-agora/telescope` with the fleet (`GET <path>/api/fleet`). The client gains `fleet()`.
