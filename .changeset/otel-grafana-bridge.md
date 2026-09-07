---
'@adonis-agora/telescope': minor
---

Exportar para Grafana o que o Telescope já captura, sem código novo em nenhuma lib

O pedido era: "seria incrível se todo lib do ecossistema já saísse com OTel export
pronto para Grafana, sem ninguém precisar fazer nada." A resposta não é instrumentar
lib por lib — é notar que o watcher genérico de diagnostics já captura TODO
`agora:<lib>:<event>` que qualquer lib emite, e transformar o que ele já grava em
spans/logs OTLP é um problema resolvido uma vez só, aqui, e não N vezes.

`config/telescope.ts` ganha um bloco `otel` (`enabled`, `endpoint`, `headers`,
`serviceName`, `entryTypes`, `timeoutMs`), desligado por padrão. Ligado, cada entry
`diagnostic` já persistida (redigida, pós-sampling) vira ou um SPAN — quando carrega
uma duração (`durationMs` no envelope, ou dentro de `payload.durationMs`, a
convenção que a ponte de diagnostics do `@adonis-agora/durable` já usa) — ou um LOG,
quando é um evento pontual. Correlação de trace usa o `traceId` que
`@adonis-agora/context` já resolve (inclusive de um `traceparent` W3C de entrada).

O decorator de export entra na MESMA cadeia de redação/sampling/streaming que já
existe: chama o store interno primeiro e exporta a partir da entry JÁ redigida e
JÁ pós-decisão-de-sampling — nunca do input cru. Não existe uma taxa de sampling
separada para OTel de propósito: uma entry descartada do armazenamento local quase
sempre deveria ser descartada do export também. O guard de sobrecarga também é
respeitado: pausado, nenhum trabalho de export novo começa.

Os seis pacotes `@opentelemetry/*` (api, sdk-trace-base, sdk-logs,
exporter-trace-otlp-http, exporter-logs-otlp-http, resources) são peers OPCIONAIS,
importados dinamicamente só quando `otel.enabled` é `true` — ninguém que não ligar
o recurso precisa instalá-los, e nenhum bundle carrega o SDK OTel à toa. Um
`@adonis-agora/telescope/otel` novo expõe só a função pura de mapeamento
(`mapEntryToOtel`), sem nenhum pacote OTel — testável e reutilizável isoladamente.

Métricas ficam de fora desta primeira versão (documentado como trabalho futuro): o
mapeamento de span/log é razoável para qualquer evento, mas transformar payloads
heterogêneos em contadores/histogramas exige saber a semântica de cada um, o que
pede uma convenção própria (`payload.metric`?) em vez de adivinhação. A ponte
bespoke do `@adonis-agora/durable` (`otel/durable-otel.ts`) também é uma candidata a
simplificação futura, já que os eventos que ela consome hoje passam pela MESMA
ponte de diagnostics que este recurso genérico já lê — fora de escopo aqui, só
sinalizado.
