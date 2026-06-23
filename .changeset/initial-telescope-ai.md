---
"@adonis-agora/telescope-ai": minor
---

Initial release of AI-assisted diagnosis for `@adonis-agora/telescope`. Turns an
`exception` telescope entry (plus optionally other entries from the same trace)
into a structured root-cause diagnosis via the Anthropic Claude API. Ships:

- `TelescopeAiDiagnoser` — `diagnose(entry, opts?) => Promise<Diagnosis | null>`.
  Builds a prompt from the exception (name, message, clipped stack, route, trace)
  and related entries, calls the Messages API (`@anthropic-ai/sdk`, peer), and
  parses a structured `{ cause, fix, confidence, model, cached }`.
- `parseDiagnosis` — defensive JSON extraction: finds the first balanced object,
  tolerates markdown fences and missing fields; an unparseable response logs and
  resolves to `null` rather than throwing.
- `DiagnosisCache` — bounded, TTL'd, LRU cache keyed by exception **family hash**,
  so the same error is never diagnosed twice; pluggable via the `DiagnosisStore`
  contract for cross-process sharing.
- `createDiagnoser` + provider + `configure.ts` + stub. Config
  (`config/telescope_ai.ts`) sources the API key from the environment
  (`env.get('ANTHROPIC_API_KEY')`) — never hardcoded — with `model` (default
  `claude-sonnet-4-6`), `enabled`, and `maxTokens`. No key / disabled → safe no-op.

`@adonisjs/core` and `@anthropic-ai/sdk` are peer dependencies.
