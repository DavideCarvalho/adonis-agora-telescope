---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Live Schedules agora mostra o POOL que serve cada agenda

`ScheduleRegistration` ganhou `pool?: string | null`, e ele atravessa toda a cadeia até a
tela: `toRegisteredSchedule` → `RegisteredSchedule.pool` → `LiveScheduledTask.pool` → uma
coluna **Pool** na tabela de Live Schedules (`—` quando a agenda não é pinada).

O caso que motivou isso é o `@adonis-agora/durable`: uma `static schedule` descoberta por
TODOS os `durable:work` que carregam o workflow nasce no namespace do pool que ganha a
corrida do tick. Quando um dos pools não tem a capacidade exigida pelos steps (ex.: o
worker de chat, sem Chrome), ele pode criar um run que ninguém a serviço — a janela morre
em `RemoteStepTimeout` ou erro de binário ausente, e o console não tinha como mostrar
"esta agenda pertence ao pool X". O durable preenche `pool` a partir do `namespace` pinado
da agenda, então a tela passa a revelar, numa linha, para qual pool aquela agenda manda
seus runs.

Campo aditivo e opcional: quem chama `registerSchedule(...)` sem `pool` (todos os callsites
existentes) normaliza para `null` e renderiza `—`, sem quebrar quem já registrava agendas.
