---
'@adonis-agora/telescope': patch
---

O waterfall desenhava a request **depois** dos comandos que ela mesma emitiu.

Um trace real vinha assim: quatro spans de `redis` de 1–3ms, depois
`POST /api/webhooks/google-drive/writing` de 31ms, depois mais um `redis`. A request
aparecia por último e nunca continha os comandos que fez.

A causa não era ordenação. O waterfall tratava `createdAt` como o **início** do span,
mas toda entry do telescope é gravada na **conclusão** — a request num `finally`, o
redis no `.then` do comando, a query no `db:query` depois de executar. Então `createdAt`
é o **fim**, e cada span era deslocado para a direita pela própria duração: os de 1ms mal
se moviam, o de 31ms pulava para depois deles.

O desenho era plausível e a ordem, impossível — que é o pior tipo de gráfico errado.
