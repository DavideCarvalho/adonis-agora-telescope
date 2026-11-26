---
"@adonis-agora/telescope": minor
---

Redaction now masks sensitive keys in any spelling. Key names are normalized (lowercased, with `-`, `_`, `.` and spaces removed) and matched against a sensitive-name heuristic, so keys such as `accessToken`, `refreshToken`, `password_confirmation`, `newPassword`, `x-auth-token`, `_csrf`, `sessionId`, `signingKey` or `otp` are no longer stored in clear text. Identifiers such as `cacheKey`, `publicKey` or `inputTokens` are kept. If a key you need is masked by mistake, list it in the new `redact.allow` option (e.g. `redact: { allow: ['authProvider'] }`); an explicit `redact.keys` entry still masks.
