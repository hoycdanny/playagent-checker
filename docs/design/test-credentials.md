# Design: Test credentials (per-app, AI self-serve)

## Problem

Some test flows need the agent to type real credentials — log in, register, pick a server, etc. Two hard constraints:

1. Case YAML rejects literal passwords (`assertNoLiteralSecrets`), so credentials can't live in the case text.
2. **Masked** credentials (account, password) must **never** appear in logs, reports, the model prompt, or the per-step trace. (Values the user explicitly marks **visible**, e.g. a server name to select from a menu, are an opt-in exception — see below.)

The desired UX: under each App, the user keeps a small key–value table (帳號 / 密碼 / 伺服器名稱 / 伺服器IP …). When a run reaches a login/registration form, the agent uses those values **without the case having to spell out any placeholder**.

### Why a per-key `visible` flag

Masking-only worked for typing into a field (`type ${帳號}`), but broke a common pre-login step: **picking the right item from a dropdown / list**. If the agent can only see the placeholder `${伺服器名稱}` and never the value `daily-aws`, it cannot match it against the on-screen options and starts guessing (observed in job `job-mumph25c-n02za0`: the agent guessed API server `WK1`, hit "請先選擇 API 伺服器", then got stuck).

The fix is a per-key **`visible`** flag (option C):

- **Masked (default, `visible:false`)** — for secrets like 帳號 / 密碼. The value **never** enters the context, prompt, trace, report, or log. The agent only sees the placeholder `${key}`; the runner substitutes the real value at type time.
- **Visible (`visible:true`)** — for non-sensitive selectors the agent must recognise on screen, like 伺服器名稱 / 伺服器IP. The value **is injected into the agent's context** so it can pick the matching item from a dropdown/list. This is a deliberate, opt-in tradeoff: visible values do reach the model prompt / `context.json` / trace.

The user chooses per key which class it belongs to. Account/password stay masked; server name/IP are marked visible.

## Approach

Three layers, kept strictly separated so masked plaintext only surfaces at the very last moment:

1. **Engine injects masked key *names* only, plus visible key *values*** into the agent's context. For masked keys the agent learns *what* exists (`帳號`, `密碼`, …) but never the value; for visible keys the agent sees `key=value` so it can match on-screen options.
2. **Runner substitutes the value only at type time** — when the agent decides to `type ${帳號}` into a field, the runner replaces `${帳號}` with the real value in the exact command sent to the device. This applies to both masked and visible keys (the runner does not care about visibility); for masked keys the value never re-enters the prompt or the trace.

### Storage (per App)

- One Secrets Manager secret per App: `playagent/tenant/<tenantId>/app/<appId>/credentials`, whose value is a JSON object mapping each key to an entry object: `{ "帳號": { "value": "…", "visible": false }, "伺服器名稱": { "value": "daily-aws", "visible": true } }`.
- **Backward compatible**: a legacy entry stored as a plain string (`{ "帳號": "…" }`) is normalised to `{ value: "…", visible: false }` on read — i.e. legacy = masked.
- Keys may be any human-readable label (Chinese allowed); disallowed: `{`, `}`, `$`, whitespace, empty, >64 chars (`isValidCredentialKey`). This keeps `${key}` placeholder syntax unambiguous.
- `infra/lambda/api/appCredentialsStore.ts` holds the naming + list/put/delete-key logic over the secret JSON (`CredentialEntry`, `normalizeEntry`, `listAppCredentials`, `readVisibleCredentials`, `putAppCredential`, `deleteAppCredential`).

### Write path (API)

`/apps/{id}/credentials` (served in `core.ts`, backed by `secretValueStore.makeSecretWriter`):
- `GET` → `{ items: [{ key, visible }, …] }` — key names + visibility flag only, sorted. **Never returns values.**
- `PUT` `{ key, value, visible? }` → merges the key into the secret JSON (upsert; `visible` defaults to `false`) and returns the item list.
- `DELETE` `?key=…` → removes one key; deletes the whole secret when the last key is removed.
- IAM: the API Lambda has `secretsmanager:CreateSecret` (resource `*`) + `PutSecretValue/GetSecretValue/DescribeSecret/DeleteSecret/TagResource` scoped to `playagent/tenant/*`. `GetSecretValue` is used only internally to merge/list keys — masked values are never sent to the client.

### Context injection (engine)

`assembleAgentContext` calls `readAppCredentialInfo(tenantId, appId)`, which reads the secret and returns `{ maskedKeys: string[], visible: { key, value }[] }` — masked values are dropped immediately, only visible values are carried through. It appends a two-part block to `context.json`:

> `# 可用測試資料 / AVAILABLE TEST CREDENTIALS`
> - **可直接使用的資料** (visible): lists `key=value` (e.g. `伺服器名稱=daily-aws`) so the agent can select the matching item from a menu/list.
> - **受保護的資料** (masked): lists `${帳號}`, `${密碼}`, … and instructs the agent to put the matching `${key}` in a `type` action's text when a field needs it; the system fills the real value at input time; never guess or write these credentials literally.

`context.json` records `credentialKeys` — the **names** of both masked and visible keys, sorted (visible *values* are not duplicated into this audit field, though they do appear in the context text above). IAM: the Engine Lambda has `secretsmanager:GetSecretValue` scoped to `playagent/tenant/*`.

### Act-time substitution (runner)

`agent/secretsResolver.mjs`:
- `loadAppCredentials()` reads the App's credential JSON into memory once at `main()` start (task-role `GetSecretValue`). Each entry is parsed as `{ value, visible }` (taking `.value`) or as a legacy plain string. The runner keeps every value in memory regardless of `visible` — visibility only governs engine context injection, not type-time substitution.
- `substituteText(text, creds, getStandalone?)` replaces `${key}` from the loaded credentials, with a fallback to a standalone tenant-scoped secret `playagent/tenant/<t>/<key>`, and also resolves `secretRef:<full-name>` when the name is under this tenant's prefix (cross-tenant references are ignored). Missing keys keep the literal placeholder and log a warning. The `${…}` pattern matches any non-`}` content so Chinese keys work.
- Both `explorationRunner.mjs` and `webExplorationRunner.mjs`: the task text (`PA_TASK`) is **not** modified. Only when `cmd.action === 'type'`, right before `client.act`, the runner substitutes `deviceCmd.text`. The `step`/`trace` records are written from the original `cmd` (placeholder), so S3 keeps only placeholders.
- IAM: the exploration and web Fargate task roles have `secretsmanager:GetSecretValue` scoped to `playagent/tenant/*`.

## Security properties

**Masked keys** (default — account, password, …):
- Plaintext exists only in Secrets Manager and transiently in the runner container's memory at the instant of typing.
- Never in: the model prompt / `context.json`, `job.json`, the SQS message, the ECS task definition/overrides, API responses, reports, `steps/*.json`, or `traces/*.json`.
- The agent's reasoning only ever sees the key *names* and the `${key}` placeholders it writes itself.

**Visible keys** (opt-in — server name, IP, …):
- The value **is** injected into `context.json` / the model prompt so the agent can match it against on-screen options. This is an explicit user choice per key; only mark non-sensitive selectors visible.
- Visible values still get their own `${key}` placeholder in `type` actions, so the runner substitution path is identical.

**Shared:**
- Per-tenant + per-app isolation by secret name; the runner forces every resolved name under `tenantSecretPrefix(PA_TENANT)`.

## Compatibility

The earlier standalone form still works: `secretRef:playagent/tenant/<t>/<KEY>` and `${KEY}` also resolve against per-tenant standalone secrets (managed via `/secret-refs`). The per-app table is the recommended path.

## Verification

- API: `PUT`/`GET` returned `{ items: [{ key, visible }] }` only (no values). Set 伺服器名稱/伺服器IP `visible:true`, 帳號/密碼 `visible:false`.
- Engine: submitted `job-mumr8ios-mvmhs4`; `context.json` contained the visible values (`伺服器名稱=daily-aws`, `192.168.0.1`) **and** the masked keys as `${帳號}`/`${密碼}` — with **zero** masked values (`qa_surv_9527`, `P@ss_654321`) present anywhere.
- Runner: `secretsResolver.mjs` parses `{ value, visible }` and legacy string entries; the exact module resolved `${帳號}`/`${密碼}`/`${伺服器名稱}` to real values at type time with no `${` left — confirming the substitution path is unchanged for both classes.
- Unit tests (`infra/test/app-credentials.test.ts`) cover keys-only listing with the visible flag, visible-only value read, legacy-string → masked normalisation, CJK keys, standalone fallback, cross-tenant rejection, and delete-empties-secret. Full suite: 197 tests pass.
