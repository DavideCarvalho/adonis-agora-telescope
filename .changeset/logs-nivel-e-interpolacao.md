---
'@adonis-agora/telescope': minor
---

Dois consertos no watcher de logs, os dois descobertos em produção.

**A mensagem gravada era o template, não o texto.** `extractLog` guardava a string de
formato e descartava os valores, então um log real virava `creating query client in %s
mode` — o `%s` nunca preenchido e o `dual` jogado fora. Uma mensagem de log virada em
template é a única forma em que ela não serve para nada. Agora as mensagens são
interpoladas como o pino faz (`%s`, `%d`/`%i`, `%o`/`%O`/`%j`, `%%`). Um placeholder sem
argumento fica **como está**: o template é uma mensagem pior, mas um valor inventado é uma
mensagem falsa.

**O watcher gravava o que o app tinha configurado para não logar.** O tee vê a chamada
mesmo quando o gate de nível do próprio logger a descarta. Em produção isso era o
`logger.trace()` de dentro do Lucid chegando a **243 entries/minuto** sob `LOG_LEVEL=info`
— linhas que não foram escritas em lugar nenhum. Agora o watcher respeita o
`isLevelEnabled` do logger; `captureBelowLoggerLevel: true` volta ao comportamento antigo
para quem quiser o console como um gravador mais fundo que o stdout.
