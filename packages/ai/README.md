# @agora/telescope-ai

AI-assisted diagnosis for [`@agora/telescope`](../core). Turns an `exception`
telescope entry (plus optionally other entries from the same trace) into a
structured root-cause diagnosis — **likely cause**, **suggested fix**, and a
**confidence** level — via the Anthropic Claude API, cached by exception family
hash so the same error is never diagnosed twice.

## Install

```sh
npm i @agora/telescope-ai @anthropic-ai/sdk
node ace configure @agora/telescope-ai
```

`configure` registers the provider in `adonisrc.ts` and publishes
`config/telescope_ai.ts`. `@anthropic-ai/sdk` and `@adonisjs/core` are peers.

## Configure

```ts
// config/telescope_ai.ts
import env from '#start/env'
import { defineConfig } from '@agora/telescope-ai'

export default defineConfig({
  apiKey: env.get('ANTHROPIC_API_KEY'), // never hardcode the key
  model: 'claude-sonnet-4-6',           // default; configurable
  maxTokens: 1024,
})
```

With **no API key** resolved the diagnoser is a safe no-op (`diagnose` returns
`null`, never calls the API), so the package degrades cleanly in environments
without credentials.

## Usage

The provider binds a `TelescopeAiDiagnoser` into the container:

```ts
import { inject } from '@adonisjs/core'
import { TelescopeAiDiagnoser } from '@agora/telescope-ai'
import { TelescopeService } from '@agora/telescope'

@inject()
export default class DiagnoseController {
  constructor(
    private diagnoser: TelescopeAiDiagnoser,
    private telescope: TelescopeService,
  ) {}

  async show({ params }: HttpContext) {
    const entry = await this.telescope.get(params.id) // an `exception` entry
    const related = await this.telescope.list({ traceId: entry.traceId })
    const diagnosis = await this.diagnoser.diagnose(entry, { related })
    return diagnosis // { cause, fix, confidence, model, cached } | null
  }
}
```

## How it works

1. **Prompt** — `buildUserPrompt` assembles the exception (name, message, clipped
   stack), the route, the trace id, and short summaries of related trace entries.
   A strict system prompt asks Claude for a **single JSON object**
   (`cause` / `fix` / `confidence`).
2. **Call** — the Anthropic Messages API (`messages.create`) with a bounded
   `max_tokens`. Defaults to `claude-sonnet-4-6`.
3. **Parse** — `parseDiagnosis` extracts the first balanced JSON object
   (tolerating markdown fences and stray prose) and defends against missing
   fields; an unparseable response is logged and `diagnose` resolves to `null`.
4. **Cache** — keyed by the exception's **family hash** (same-signature errors
   share one family) in a bounded, TTL'd in-memory LRU. The cache is pluggable
   (`DiagnosisStore`) — swap in a Redis/DB store for cross-process sharing. A
   cached hit returns with `cached: true` and makes **no** API call.

## Safety

- Disabled / no key → no-op.
- A model error, rate limit, or malformed response → logged, returns `null`;
  never throws into the caller's path.
- The API key is read from config (`env.get(...)`), never hardcoded.
