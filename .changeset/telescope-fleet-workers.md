---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Fleet: long-running ace commands show up as instances. A worker (`node ace durable:work`, `queue:work`, any command with `staysAlive`) sends a heartbeat under its command's name as its `role`; web processes report `web`. One-off commands (migrations, `telescope:*`) and tests send nothing. Workers drain on `SIGTERM`/`SIGINT`, run the health checks without mounting probe routes, and send no `fleet.url` (never a discovery target). `fleet.report` now defaults to `['web', 'worker']` (also accepts a command name, or `'console'` for every command) and `fleet.role` overrides the role. The control plane accepts heartbeats with or without a role (older tenants count as `web`). `instances-up` alerts take `role` (default `'web'`, or `'*'`), restart loops are per role, and the Fleet page shows a Role column and a role filter.
