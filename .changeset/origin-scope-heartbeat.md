---
'@adonis-agora/telescope': minor
---

Um escopo de origem, e o direito de não gravar um batimento

O `BatchOrigin` declarava `queue`, `schedule` e `cli` desde sempre, e ninguém nunca os
escrevia: só o request watcher passava um `origin`, então tudo que um processo de fundo
gravava caía no default `manual`. A consequência é que o painel não sabia distinguir
"isto veio de uma request" de "isto veio de um tick do scheduler".

Agora existe um escopo ambiente (`runWithOrigin`), publicado no slot global
`Symbol.for('@agora/telescope:origin-scope')` — o mesmo padrão que o
`@adonis-agora/context` usa com o accessor dele, e pelo mesmo motivo: uma lib irmã
(`@adonis-agora/durable`) precisa poder rotular o próprio trabalho sem passar a depender
de uma ferramenta de observabilidade só para ser legível dentro dela.

Junto vem a distinção que importa de verdade: `runAsHeartbeat` marca uma leitura como
SONDA de vivacidade — o laço perguntando ao store "tem trabalho?". O `safeRecord`
descarta essas, a menos que o host ligue `recordHeartbeat: true`.

A medida que motivou isso: numa janela de 12h em produção, as quatro sondas do worker do
durable (um tick por segundo) eram 182.868 das 320.754 entries — **57% de tudo**, contra
6.363 queries do app inteiro. Uma ferramenta de depuração em que 57% das linhas são o
sistema respirando deixou de ser uma ferramenta de depuração.

O limite é estreito de propósito: a sonda é descartada, o trabalho que ela encontra não.
Lease, checkpoint e resultado da run continuam gravados — é exatamente isso que alguém
abre o console para ver quando um workflow trava.
