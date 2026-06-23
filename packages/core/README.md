# `@adonis-agora/telescope`

Laravel Telescope-style **headless** observability for AdonisJS — records every
HTTP request and every `agora:<lib>:<event>` diagnostics publish as a queryable
entry.

```sh
npm i @adonis-agora/telescope
node ace configure @adonis-agora/telescope
```

```ts
import { TelescopeService } from '@adonis-agora/telescope'

const telescope = await app.container.make(TelescopeService)
telescope.list({ type: 'request', limit: 50 })
telescope.byTrace('abc123')
telescope.topFamilies(10, 'diagnostic')
```

See the [repo README](../../README.md) and [`DESIGN.md`](../../DESIGN.md) for the
full contract, the cross-repo decoupling design, and the deferred roadmap.

## License

MIT © Davi Carvalho
