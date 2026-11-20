---
'@adonis-agora/telescope': minor
---

Fleet instances carry `createdAt` (first heartbeat) and `updatedAt` (last heartbeat) as ISO 8601 strings (`null` when unknown) in `GET <path>/api/fleet`, `telescope:fleet:list --json` and `telescope_get_fleet`, next to the existing `firstSeenAt` / `lastSeenAt`. An instance now keeps its first-seen time across a control-plane restart or another replica: the Lucid fleet store reads the stored `first_seen_at` once per instance instead of overwriting it with the receiving process's own first sighting. No schema change. Also ships the console update below.
