---
'@adonis-agora/telescope': patch
---

The console guard now logs (warn) the error when the `authorize` hook throws, before answering 403. It still fails closed.
