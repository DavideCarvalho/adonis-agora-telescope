---
'@adonis-agora/telescope': patch
'@adonis-agora/telescope-ui': patch
---

Add TanStack Intent AI-agent skills. Ship six SKILL.md guides inside both published
packages (`packages/*/skills/**`, now included in the `files` array): five core
skills for `@adonis-agora/telescope` (setup, watchers, storage/retention,
alerts/AI/client-errors, dashboard access control + MCP) and one for
`@adonis-agora/telescope-ui` (the React console + `/client`). Adds
`_artifacts/` domain map, skill spec and skill tree at the repo root, a
`tanstack-intent` keyword and `@tanstack/intent` devDependency to both packages,
and an `.github/workflows/check-skills.yml` CI validation workflow.
