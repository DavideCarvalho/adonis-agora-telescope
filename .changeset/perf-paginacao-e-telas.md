---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Performance da lista de traces, paginação server-side, e a tela de Screens.

**Traces deixa de varrer a tabela.** `getTraces` chamava `collect({})` — sem janela,
sem filtro — carregava até `scanCap` (50.000) entries com o JSON de `content` inteiro,
agrupava por `traceId` em memória e devolvia 50. Pior que lento: numa tabela dominada
pelo watcher mais tagarela, o orçamento de 50k acabava antes de chegar nos traces
interessantes, então a tela era lenta E incompleta. Agora o store escolhe a página de
trace ids primeiro (`GROUP BY trace_id ORDER BY MAX(created_at)`, indexável) e só então
buscamos as entries desses traces. `TelescopeStore.listTraceIds` é **opcional**: store de
terceiro que não implemente cai no caminho antigo, correto e mais lento.

**Filtros no watcher de redis.** Ele gravava TODO comando. Em produção isso deu 211
entries/minuto (495k linhas, 93% da tabela), quase tudo bookkeeping do próprio
`@adonisjs/limiter`. Novos `redis.ignoreCommands` / `ignoreKeys` / `ignoreConnections` /
`sampleRate`. Nada é filtrado por default — o que é ruído é decisão do app — mas o novo
`floodWarnPerMinute` (600) avisa uma vez nomeando o comando e o prefixo de chave mais
barulhentos, já no formato de colar na config.

**Aviso quando o watcher de `query` está mudo.** O Lucid só emite `db:query` numa conexão
com `debug` ligado, e a forma comum é `debug: app.inDev` — o watcher funciona em
desenvolvimento e grava nada em produção, em silêncio. O boot agora diz isso.

**Screens.** O request watcher classifica cada request em `page` / `api` / `asset`
(`content.kind` + tag `kind:*`), e o novo `GET /metrics/screens` agrega tráfego por rota.
A lista de Entries não conseguia responder "quais telas são mais usadas": a visita e os
XHRs que ela dispara eram todos `request` com uma url.

**Paginação.** `/entries` e `/metrics/traces` aceitam `page=` e respondem `hasMore` (uma
linha além da página, não um `COUNT` sobre a tabela que a paginação existe para parar de
varrer). `EntryQuery` ganha `offset` e `traceIds`. Na UI, as tabelas passam a usar
TanStack Table com `manualPagination`.

**Grupos de exceção deixam de ser limitados a 8.** `topExceptions` é parâmetro do endpoint
de stats; a tela dedicada pede 200. Um teto de 8 num painel de exceções não escondia a 9ª
exceção mais comum — tornava ela inalcançável.

**Novo hook `schedules()` no contrato de extensão.** Uma extensão que é dona de um
scheduler (o `@adonis-agora/durable`, por exemplo) contribui os schedules que já conhece,
em vez de o app repetir a lista à mão e ela divergir dos decorators.
