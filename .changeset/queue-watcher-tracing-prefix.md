---
'@adonis-agora/telescope': patch
---

O watcher de queue assinava um canal que ninguém publica — `type=job` ficava em ZERO

O `@boringnode/queue` (engine por trás do `@adonisjs/queue`) publica a execução de cada job num `diagnostics_channel.tracingChannel('boringqueue.job.execute')`. O watcher assinava `boringqueue.job.execute:asyncEnd`.

Falta o prefixo. O Node nomeia os sub-canais de um tracing channel como `tracing:<name>:<evento>` — o nome real é `tracing:boringqueue.job.execute:asyncEnd`. Assinar o outro cria um canal NOVO, que ninguém publica, e o watcher fica surdo em silêncio.

Em produção isso aparecia como `type=job` em zero com o worker executando jobs normalmente — indistinguível de um sistema sem jobs, que é o pior formato de falha possível para uma ferramenta de observabilidade.

O nome agora é DERIVADO do `tracingChannel` do Node, em vez de montado à mão. A diferença não é estética: o nome passa a vir do Node, e não de uma suposição sobre o Node.

**O teste cometia o mesmo erro.** Ele publicava no mesmo nome montado à mão que o watcher assinava, então passava com o watcher surdo — um teste que reproduz a suposição do código não testa a suposição. Agora ele publica pelo `tracingChannel`, como o engine faz, e há um caso que passa por `tracePromise` (o caminho literal do worker) sem saber o nome de sub-canal nenhum. Contra o código antigo, esses testes falham.
