---
"@adonis-agora/telescope": minor
"@adonis-agora/telescope-ui": minor
---

feat: request entries capturam o usuário autenticado (`ctx.auth.user` → `id`/`email`, defensivo) com `userLabel` nas projeções de entries/traces; UI mostra o usuário em detail/trace/listas, navegação por hash routes com deep links (`#/entries/:id`, `#/traces/:id`, `#/entries?type=`, ...) e contenção de overflow horizontal no content de exception