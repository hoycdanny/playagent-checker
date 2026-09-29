# Design: Test credentials (per-app, AI self-serve)

## Problem

Some test flows need the agent to type real credentials — log in, register, pick a server, etc. Two hard constraints:

1. Case YAML rejects literal passwords (`assertNoLiteralSecrets`), so credentials can't live in the case text.
2. Plaintext must **never** appear in logs, reports, the model prompt, or the per-step trace.

The desired UX: under each App, the user keeps a small key–value table (帳號 / 密碼 / 伺服器名稱 / 伺服器IP …). When a run reaches a login/registration form, the agent uses those values **without the case having to spell out any placeholder**.

## Approach

Two layers, kept strictly separated so plaintext only surfaces at the very last moment:

1. **Engine injects only key names** into the agent's context — the agent learns *what* credentials exist (`帳號`, `密碼`, …) but never sees the values.
2. **Runner substitutes the value only at type time** — when the agent decides to `type ${帳號}` into a field, the runner replaces `${帳號}` with the real value in the exact command sent to the device. The value never re-enters the prompt or the trace.

### Storage (per App)

- One Secrets Manager secret per App: `playagent/tenant/<tenantId>/app/<appId>/credentials`, whose value is a JSON object `{ "帳號": "…", "密碼": "…" }`.
- Keys may be any human-readable label (Chinese allowed); disallowed: `{`, `}`, `$`, whitespace, empty, >64 chars (`isValidCredentialKey`). This keeps `${key}` placeholder syntax unambiguous.
- `infra/lambda/api/appCredentialsStore.ts` holds the naming + list/put/delete-key logic over the secret JSON.

### Write path (API)

`/apps/{id}/credentials` (served in `core.ts`, backed by `secretValueStore.makeSecretWriter`):
- `GET` → `{ keys: [...] }` — key names only, sorted. **Never returns values.**
- `PUT` `{ key, value }` → merges the key into the secret JSON (upsert) and returns the key list.
- `DELETE` `?key=…` → removes one key; deletes the whole secret when the last key is removed.
- IAM: the API Lambda has `secretsmanager:CreateSecret` (resource `*`) + `PutSecretValue/GetSecretValue/DescribeSecret/DeleteSecret/TagResource` scoped to `playagent/tenant/*`. `GetSecretValue` is used only internally to merge/list keys — the value is never sent to the client.

### Context injection (engine)

`assembleAgentContext` calls `readAppCredentialKeys(tenantId, appId)`, which reads the secret but returns **only `Object.keys(...)`** — values are dropped immediately. It appends a block to `context.json`:

> `# 可用測試資料 / AVAILABLE TEST CREDENTIALS` — lists `${帳號}`, `${密碼}`, … and instructs the agent to put the matching `${key}` in a `type` action's text when a field needs it; the system fills the real value at input time; never guess or write credentials literally.

`context.json` records `credentialKeys` (names only) for audit. IAM: the Engine Lambda has `secretsmanager:GetSecretValue` scoped to `playagent/tenant/*`.

### Act-time substitution (runner)

`agent/secretsResolver.mjs`:
- `loadAppCredentials()` reads the App's credential JSON into memory once at `main()` start (task-role `GetSecretValue`).
- `substituteText(text, creds, getStandalone?)` replaces `${key}` from the loaded credentials, with a fallback to a standalone tenant-scoped secret `playagent/tenant/<t>/<key>`, and also resolves `secretRef:<full-name>` when the name is under this tenant's prefix (cross-tenant references are ignored). Missing keys keep the literal placeholder and log a warning. The `${…}` pattern matches any non-`}` content so Chinese keys work.
- Both `explorationRunner.mjs` and `webExplorationRunner.mjs`: the task text (`PA_TASK`) is **not** modified. Only when `cmd.action === 'type'`, right before `client.act`, the runner substitutes `deviceCmd.text`. The `step`/`trace` records are written from the original `cmd` (placeholder), so S3 keeps only placeholders.
- IAM: the exploration and web Fargate task roles have `secretsmanager:GetSecretValue` scoped to `playagent/tenant/*`.

## Security properties

- Plaintext exists only in Secrets Manager and transiently in the runner container's memory at the instant of typing.
- Never in: the model prompt / `context.json`, `job.json`, the SQS message, the ECS task definition/overrides, API responses, reports, `steps/*.json`, or `traces/*.json`.
- The agent's reasoning only ever sees the key *names* and the `${key}` placeholders it writes itself.
- Per-tenant + per-app isolation by secret name; the runner forces every resolved name under `tenantSecretPrefix(PA_TENANT)`.

## Compatibility

The earlier standalone form still works: `secretRef:playagent/tenant/<t>/<KEY>` and `${KEY}` also resolve against per-tenant standalone secrets (managed via `/secret-refs`). The per-app table is the recommended path.

## Verification

- API: setting 帳號/密碼/伺服器名稱/伺服器IP returned key names only; values were confirmed only in the Secrets Manager JSON.
- Engine: `context.json` contained `credentialKeys` (names) and the key names in the context text, with **zero** values present.
- Runner: CloudWatch showed no credential-load failure (task role read OK) and **zero** plaintext leaks. The exact `secretsResolver.mjs` module was run against the real secret and resolved `${帳號}`/`${密碼}`/`${伺服器名稱}` to real values (`[secrets] 已在輸入時替換 3 個憑證佔位符`), with no `${` left — confirming the type-time substitution path.
- Unit tests cover key-name-only listing, CJK keys, standalone fallback, cross-tenant rejection, and missing-key retention.
