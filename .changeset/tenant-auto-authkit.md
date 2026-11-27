---
'@adonis-agora/telescope': minor
---

`topology: 'tenant'` needs no `tenant` block when `@adonis-agora/authkit-client` is configured with a `service`: the control plane URL, the service token and the partition come from its `authkit.client` binding (`tenantOf('urn:agora:telescope')`), detected structurally. Anything set in `tenant` wins field by field; `tenant: { auto: false }` turns the detection off. Without the binding and the fields, the web process refuses to boot naming both fixes, and `agora:doctor` shows where each field came from (`telescope.tenant-source`).
