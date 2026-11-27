---
"@adonis-agora/telescope": patch
---

`node ace configure @adonis-agora/telescope --topology=tenant` publishes `config/telescope.ts` in the one-line tenant form (`defineConfig({ topology: 'tenant' })`), with a note that url, token and partition come from `@adonis-agora/authkit-client` and the explicit `tenant` fields commented out. Without the flag, configure is unchanged. The tenant boot error now points at `config/authkit_client.ts` (authkit-client's config file) instead of `config/authkit.ts`.
