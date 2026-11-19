---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Architecture page shows what each app runs on. Each instance sends its stack in the heartbeat: databases and Redis servers from the `database` and `redis` configs, plus what libs declare with `describeStackUse`. No credentials are sent, and each server is identified by a short hash. The page draws the backends as nodes with their logos (PostgreSQL, Redis, S3, Resend…), linked to the apps that use them, and has an Infrastructure layer toggle. The graph is now full width, follows the console theme, and maps calls made to the control plane's internal hosts back to it.
