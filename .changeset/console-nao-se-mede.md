---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

O console para de se medir, os painéis param de afirmar saúde que não mediram, e o
Overview vira página de containers.

**O console não se mede.** A lista "Slowest" em produção vinha com duas rotas do próprio
telescope no top 5 (`/telescope/api/metrics/timeseries` 3.00s, `/telescope/api/metrics/pulse`
2.90s). Os endpoints de agregação estão entre os mais lentos que o processo serve — é
literalmente o trabalho deles — e abrir o Overview gravava mais duas requests lentas no
ranking e no p99 **do app**. O middleware agora pula o prefixo do dashboard;
`recordOwnRequests: true` traz o comportamento antigo. O casamento de prefixo é consciente
de fronteira, para não engolir uma rota `/telescopes` do app.

**Painel que não está medindo para de dizer que está tudo bem.** "No N+1 loops detected." e
"o watcher `query` está desligado" são afirmações opostas, e o console fazia a primeira
quando a segunda era verdade — relatando a própria cegueira na voz de boa notícia. O
`/meta` agora carrega os watchers que estão rodando, e o painel diz qual falta e onde
ligar. O hook é de três valores: um servidor que não informa não vira uma segunda
afirmação errada.

**Throughput para de carregar as entries.** O gráfico precisa de `createdAt` e `type`, mas
só havia `list()`, que faz `select('*')` — sessenta barras custavam cada entry da janela
com seu blob de `content`. Novo `countByBucket` (opcional) no contrato de store.

**Overview vira página de containers.** Cada painel busca o próprio dado e tem o próprio
loading e erro, em vez de um `AsyncBlock` sobre o `pulse` travando a grade inteira. Entra
`@tanstack/react-query` — o que os outros dashboards do ecossistema já usam — porque sem
dedup dividir a página em containers multiplicaria as requests em vez de paralelizar.

**Os tiles do Overview navegam.** `Slow routes: 4` dizia o problema e escondia a evidência.
