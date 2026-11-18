---
'@adonis-agora/telescope': patch
---

Service-token capabilities accept wildcards everywhere a control plane checks them (HTTP ingest, the queue/Redis transports, relaying, `whoami`, discovery). A `*` segment matches one segment and a trailing `*` matches everything after it, the same rule as the rest of Agora, now exported as `capabilityAllows(granted, required)`. A token holding `*` (previously refused) now ingests and relays for every app; `telescope:ingest:relay:*` and `telescope:ingest:*` relay for every app too. `telescope:ingest:relay` still implies `telescope:ingest`, and `telescope:ingest:relay:<app>` still relays for that app only.
