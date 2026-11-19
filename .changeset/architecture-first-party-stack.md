---
'@adonis-agora/telescope': minor
'@adonis-agora/telescope-ui': minor
---

Architecture page: what each app runs on now includes the AdonisJS first-party packages, with no code to write. Drive disks (S3, R2, GCS, the default local disk; the bucket as label), mail transports (Resend, SES, Mailgun…, an SMTP server by its host), cache stores (Redis or database L2 and bus), the lock, limiter, session and queue store in use, and the Transmit Redis transport are read from their configs, through the connection they use. Telescope's own store and Redis ingest stream show up too. `StackUse` accepts `tech: 'lucid'` (a Lucid connection, the default one without `connection`) and a `redis` use without `connection` means the default Redis connection. New logos: ClickHouse, DuckDB, Anthropic, Gemini, OpenAI, Mercado Pago, Asaas, Pagar.me, Brevo, SparkPost, SendGrid, Postmark, DynamoDB, MQTT, Spaces, Vault, KMS.
