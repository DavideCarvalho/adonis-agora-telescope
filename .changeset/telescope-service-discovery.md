---
'@adonis-agora/telescope': minor
---

Service discovery. `fetch('http://billing/invoices/1')` reaches the app named `billing`: each instance's heartbeat carries its URL (`fleet.url`, default `APP_URL`), the central server keeps the live URL of each app and serves the map to tenants (scoped by their token's environment, answered as soon as it changes), and tenants keep it in memory and in a snapshot file so calls still resolve while the server is down. A static `discovery: { billing: 'http://localhost:3334' }` in `config/telescope.ts` works standalone and overrides the server's map. Only single-label hosts are rewritten (never a host with a dot, an IP or `localhost`); an unknown name fails with "app billing is not registered"; `failFast` refuses apps with no live instance; `nodeHttp` covers `http.request`. The resolved map is published on `Symbol.for('@adonis-agora/discovery')` (`resolve`, `appOf`, `subscribe`) for other libraries.
