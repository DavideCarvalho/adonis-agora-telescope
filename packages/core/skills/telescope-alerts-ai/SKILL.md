---
name: telescope-alerts-ai
description: >-
  Alerting, AI diagnosis and client-error ingestion in @adonis-agora/telescope —
  config/telescope_alerts.ts with AlertRule types (new-exception, every-exception,
  exception-rate, stateful metric-threshold), channel helpers (slackChannel,
  webhookChannel, consoleChannel, customChannel), every/cooldown/instanceId/
  geoLookup; config/telescope_ai.ts + TelescopeAiDiagnoser Claude diagnosis cached
  by familyHash (keyless = disabled); clientErrors sendBeacon endpoint. Use for
  "Slack alert on new errors", "AI diagnose exceptions", "page on every error",
  "report browser errors", "why didn't my alert fire".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/telescope"
  library_version: "0.8.4"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-telescope:docs/packages/alerts.mdx"
  - "DavideCarvalho/adonis-telescope:docs/packages/ai.mdx"
  - "DavideCarvalho/adonis-telescope:docs/packages/client-errors.mdx"
  - "DavideCarvalho/adonis-telescope:packages/core/src/alerts/index.ts"
---

# Alerting, AI diagnosis & client errors

The alerter polls the store on an interval, evaluates rules over recorded
`exception` entries, and fans each fire out to every configured channel. The AI
subpath attaches a Claude root-cause diagnosis to an exception, cached by family.
Client-error ingestion lets browsers report their own failures into the same
pipeline. All three are subpaths of the one package — enable them via
`node ace configure @adonis-agora/telescope` (pick **Alerts** / **AI**).

## Setup

```ts
// config/telescope_alerts.ts
import env from '#start/env'
import { defineConfig } from '@adonis-agora/telescope/alerts'

export default defineConfig({
  channels: [{ type: 'slack', url: env.get('TELESCOPE_SLACK_WEBHOOK') }],
  rules: [{ type: 'new-exception', window: '1h' }],
  dashboardUrl: 'https://telescope.example.com/', // enables Slack deep links
  every: '30s',        // poll cadence — alerts are as late as the interval
  cooldown: '15m',     // per-rule / per-family re-notify suppression
})
```

```ts
// config/telescope_ai.ts
import env from '#start/env'
import { defineConfig } from '@adonis-agora/telescope/ai'

export default defineConfig({
  apiKey: env.get('ANTHROPIC_API_KEY'),   // validate as Env.schema.string.optional()
  model: 'claude-sonnet-4-6',             // default; claude-opus-4-8 / claude-haiku-4-5-20251001
  maxTokens: 1024,
})
```

Durations are validated at boot — an unparseable `every`/`cooldown`/`window`
(`'15min'`, a typo) **throws**, fail-closed. Valid units: `ms`, `s`, `m`, `h`, `d`.

Source: `docs/packages/alerts.mdx` (Configuration),
`docs/packages/ai.mdx` (Configuration).

## Core patterns

### Pattern 1 — pick rules deliberately

```ts
rules: [
  { type: 'new-exception', window: '1h' },   // first sighting of a family (+ recurrences after it)
  { type: 'every-exception', window: '15m' },// EVERY server + browser error, cooldown-limited per family;
                                             // window is display-only (labels the occurrence count)
  { type: 'exception-rate', window: '5m', threshold: 10 },
  {
    type: 'metric-threshold',                // stateful raise/auto-resolve, evaluated on every poll
    metric: 'request-p99-ms',                // or query-p95-ms, cache-hit-rate, exception-count, ...
    window: '5m',
    comparator: 'gte',
    threshold: 800,
    minSamples: 10,                          // guard percentiles against a single slow request
  },
]
```

`new-exception` dedup is a bounded per-process map — in a multi-replica deploy the
same family reports "new" once per replica, so budget `cooldown` accordingly.

Source: `docs/packages/alerts.mdx` (Rules, Deduplication).

### Pattern 2 — diagnose an exception with its trace context

`TelescopeAiDiagnoser` is always resolvable from the container — even when disabled,
when `diagnose` resolves `null` — so you can inject it without a null check.

```ts
// app/controllers/diagnose_controller.ts
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { TelescopeService } from '@adonis-agora/telescope'
import { TelescopeAiDiagnoser } from '@adonis-agora/telescope/ai'

@inject()
export default class DiagnoseController {
  constructor(
    private telescope: TelescopeService,
    private diagnoser: TelescopeAiDiagnoser,
  ) {}

  async show({ params, response }: HttpContext) {
    const entry = await this.telescope.find(params.id)
    if (!entry || entry.type !== 'exception') {
      return response.notFound({ error: 'Not an exception entry' })
    }
    const related = entry.traceId ? await this.telescope.byTrace(entry.traceId) : []
    const diagnosis = await this.diagnoser.diagnose(entry, { related })
    // → { cause, fix, confidence, model, cached } | null — never throws
    return response.json(diagnosis)
  }
}
```

Diagnoses cache per `familyHash` (bounded LRU, 24h TTL); pass `{ force: true }` to
spend a fresh call after changing code.

Source: `docs/packages/ai.mdx` (Use it), `docs/recipes/ai-exception-diagnosis.mdx`.

### Pattern 3 — a custom channel sink

Channels fan out concurrently; one failing never blocks the others.

```ts
import { defineConfig, customChannel, slackChannel } from '@adonis-agora/telescope/alerts'
import env from '#start/env'

export default defineConfig({
  channels: [
    slackChannel(env.get('TELESCOPE_SLACK_WEBHOOK'), { username: 'Telescope' }),
    customChannel(async (alert) => { await pagerduty.trigger(alert) }, 'pagerduty'),
  ],
  rules: [{ type: 'new-exception', window: '1h' }],
})
```

Exception alerts carry `{ cause, fix, confidence, model }` when AI is configured —
a guarded hook, so a slow model never delays or breaks the page.

Source: `docs/packages/alerts.mdx` (Channels).

### Pattern 4 — ingest browser errors

Disabled by default; the route only exists once you enable it. Report with
`navigator.sendBeacon`; entries become `client_exception` records through the same
redaction/sampling/prune pipeline as server exceptions.

```ts
// config/telescope.ts
export default defineConfig({
  clientErrors: {
    enabled: true,
    path: '/telescope/client-errors',
    maxBodyBytes: 32_768,          // larger bodies rejected 413 before validation
    rateLimit: { perMinute: 60 },  // per-IP token bucket; over → 429
  },
})
```

```ts
// Browser reporter
window.addEventListener('error', (event) => {
  navigator.sendBeacon(
    '/telescope/client-errors',
    JSON.stringify({
      message: event.message,
      name: event.error?.name ?? null,
      stack: event.error?.stack ?? null,
      url: location.href,
      userAgent: navigator.userAgent,
    }),
  )
})
```

Only `message` is required; `clientIp` is filled server-side, never trusted from
the body.

Source: `docs/packages/client-errors.mdx`.

## Common mistakes

### HIGH Listing two rules of the same exception type

```ts
// Wrong — the second new-exception rule is SILENTLY ignored.
rules: [
  { type: 'new-exception', window: '1h' },
  { type: 'new-exception', window: '24h' },
]
```

```ts
// Correct — at most one of each exception rule; express variations via window/threshold.
rules: [
  { type: 'new-exception', window: '1h' },
  { type: 'exception-rate', window: '5m', threshold: 10 },
]
```

Mechanism: `new-exception`, `every-exception` and `exception-rate` are looked up
once by type; duplicates never evaluate (`metric-threshold` is exempt).
Source: `docs/packages/alerts.mdx` (When rules do and don't run).

### HIGH Shipping AI config without a resolvable key

```ts
// Wrong — keyless install looks configured but silently does nothing:
export default defineConfig({ model: 'claude-opus-4-8' })   // no apiKey, no client
const diagnosis = await diagnoser.diagnose(entry)           // always null
```

```ts
// Correct — source the key from validated env; check isConfigured() when unsure.
export default defineConfig({ apiKey: env.get('ANTHROPIC_API_KEY') })
```

Mechanism: a configured-but-keyless install is treated as disabled — `diagnose`
resolves `null` forever and the dashboard hides the Diagnose button, with no error
anywhere.
Source: `docs/packages/ai.mdx` (warn callout), `docs/reference/configuration.mdx` (AI).

### MEDIUM Expecting sampled-out exceptions to page

```ts
// Wrong — sampling drops most queries AND some exceptions before any rule sees them.
sampling: { default: 0.1 },
rules: [{ type: 'new-exception', window: '1h' }],
```

```ts
// Correct — tail-sampling keeps errors/slow regardless of rate.
sampling: { default: 0.1, exception: { rate: 0.1, keepErrors: true } },
```

Mechanism: only what was recorded is alertable — sampling and the overload shed run
before the alerter's poll, and polling itself adds up to `every` of latency.
Source: `docs/packages/alerts.mdx` (How it hooks in).

### MEDIUM Short cooldown with every-exception

```ts
// Wrong — a tight loop of the same error re-pages once per cooldown... which is 1 minute.
rules: [{ type: 'every-exception' }],
cooldown: '1m',
```

```ts
// Correct — tune cooldown to your on-call tolerance; different families still page immediately.
rules: [{ type: 'every-exception', window: '15m' }],
cooldown: '10m',
```

Mechanism: cooldown is the *only* thing rate-limiting repeats per family (on its own
independent clock from `new-exception`), so a short one on a noisy family is a
self-inflicted alert storm.
Source: `docs/packages/alerts.mdx` (cooldown info callout).

### MEDIUM Probing for the client-error endpoint while it is disabled

```sh
# Wrong — expecting a 404 that proves wiring:
curl -X POST http://localhost:3333/telescope/client-errors
# → generic route-not-found; can't tell whether telescope owns this prefix
```

```ts
// Correct — enable it, then verify the 204:
clientErrors: { enabled: true }
// curl -X POST ... → 204 No Content once registered
```

Mechanism: unlike an always-mounted controller, the provider registers the POST
route only when `clientErrors.enabled` is true — while off the endpoint genuinely
does not exist.
Source: `docs/packages/client-errors.mdx` (Disabled by default warn callout).

See also: `telescope-watchers/SKILL.md` — capture gaps become alert gaps;
`telescope-access-mcp/SKILL.md` — the diagnose endpoint rides behind the dashboard guard.
