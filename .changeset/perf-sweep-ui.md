---
"@adonis-agora/telescope-ui": patch
---

The live tail batches incoming SSE frames into one state update per 100 ms instead of re-rendering the entries table for every frame, and the "new row" highlight uses a Set lookup instead of scanning the tail for each row.
