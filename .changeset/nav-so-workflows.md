---
'@adonis-agora/telescope-ui': patch
---

Some o item "Extensions" da barra lateral; cada dashboard contribuído aparece pelo nome.

A barra tinha **dois** itens levando à mesma tela: "Extensions" (a seção sem dashboard
escolhido) e, logo abaixo, o dashboard pelo próprio nome — "Workflows", no caso do
`@adonis-agora/durable`. Um nomeado pelo que a pessoa quer ver, outro pela mecânica que
entrega.

"Extensão" é um conceito de quem escreve a lib, não de quem lê o console. Os dashboards
agora entram direto na lista, que é a mesma forma um-item-por-dashboard que o console
irmão em NestJS usa.

Deep links para `#/extensions` continuam funcionando.
