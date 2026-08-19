---
'@adonis-agora/telescope': patch
'@adonis-agora/telescope-ui': patch
---

Stop pinning 0.x peers with a caret, which npm rejects outright.

Below 1.0 a caret does not cross a minor: `^0.32.0` means `>=0.32.0 <0.33.0`. pnpm downgrades an
unsatisfied peer to a warning, so a workspace never notices — but **npm answers `ERESOLVE` and
refuses to install**, and an optional peer that IS present must still match.

`@adonis-agora/telescope` declared `"@anthropic-ai/sdk": "^0.32.0"`, which was **already broken**:
installing it alongside any current SDK failed.

```
While resolving: @adonis-agora/telescope@0.8.1
Found: @anthropic-ai/sdk@0.116.0
Conflicting peer dependency: @anthropic-ai/sdk@0.32.1
```

It now declares `>=0.32.0 <1.0.0` — the same floor, verified to compile against every SDK minor
from 0.32.0 through 0.116.0, with an upper bound that stops excluding them.

`@adonis-agora/telescope-ui` declared `"@adonis-agora/telescope": "^0.8.0"`, the same defect one
release from biting: satisfied by telescope 0.8.1 today, unsatisfiable the moment telescope cuts
0.9.0. It now declares `>=0.7.0 <1.0.0`. The floor is 0.7.0 because that is the first release
serving every route this console calls — `/api/retention`, `/api/profiles*`, `/api/queues/live*`,
`/api/schedules/live` and `/api/exceptions/:id/diagnose` — not 0.5.0, which is merely where the
provider still type-checks and where the console's Profiles, Queues, Schedules and retention
sections would all 404.
