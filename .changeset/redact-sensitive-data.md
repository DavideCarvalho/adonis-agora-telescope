---
"@adonis-agora/telescope": patch
---

Redact sensitive keys before persisting telescope entries. A central, config-driven scrubber (on by default) masks sensitive keys (`authorization`, `cookie`, `password`, `token`, `api_key`, `secret`, …) in every entry's content at the store boundary — case-insensitively, at any depth — with a bounded, cycle-safe deep clone. Extend the masked set or disable it via `redact: { keys?, enabled? }` in `config/telescope.ts`.
