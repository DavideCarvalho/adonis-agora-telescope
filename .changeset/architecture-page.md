---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Architecture page: a graph of the apps and what links them.
- **Apps:** health and instances, from the fleet.
- **Calls between apps:** count, failures, avg and p95 latency over 1 h, 6 h or 24 h. Outbound HTTP entries now carry `to:<app>` when service discovery knows the origin.
- **Permissions:** what each app may call on another and what each app accepts, read from authkit-server's app-graph slot when it runs in the same process.

Each link shows as ok, failing, calls without a grant, or granted but unused. New `GET <path>/api/architecture?window=`.
