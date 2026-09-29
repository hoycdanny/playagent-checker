# Design: Test credentials (secret substitution)

## Problem

Some test flows require the agent to type real credentials — e.g. "register with `${TEST_USERNAME}` / `${TEST_PASSWORD}`, then enter the lobby." Case YAML rejects literal passwords (`assertNoLiteralSecrets`), so the goal carries placeholders. Previously nothing substituted them: the Device Farm / Web runners passed the case task verbatim into `PA_TASK`, so the agent saw the literal `${TEST_USERNAME}` and stalled on the form. (The old `deviceFarmProvider` had a resolver, but that code path is dead — the live path is `engine → startDeviceFarmRun → ECS RunTask`.)

## Approach

Resolve secrets **inside the runner container**, not in the Lambda. The engine keeps passing the raw task (placeholders intact) as `PA_TASK`; the runner reads the values from AWS Secrets Manager and substitutes them just before use.

Why in the runner (not the API/engine):
- Plaintext never touches S3 (`job.json` keeps the placeholders) and never sits in the ECS task definition / RunTask overrides.
- The value exists only in the container's memory for the duration of the run.

### Storage

- Values live in **AWS Secrets Manager**, named `playagent/tenant/<tenantId>/<KEY>` (e.g. `playagent/tenant/globex-us/TEST_USERNAME`). The prefix comes from `tenantSecretPrefix()` in `infra/lambda/api/secretRefs.ts`.
- The registry `tenants/<t>/secret-refs.json` (S3) stores only `{ name, label, createdAt }` — never the value. It drives the UI list and lets cases be validated for missing references.

### Write path (API)

- `PUT /secret-refs` accepts `{ key, value?, label? }`. The backend builds the full name `tenantSecretPrefix(tenant) + key`, validates the key (`^[A-Za-z0-9_.-]+$`), writes the value to Secrets Manager via `secretValueStore.makeSecretWriter` (`CreateSecret`, falling back to `PutSecretValue` on `ResourceExistsException`), then registers the name. The value is never returned.
- `DELETE /secret-refs?name=<key|fullName>` deletes the Secrets Manager secret (`ForceDeleteWithoutRecovery`) and removes the registry entry.
- IAM: the API Lambda has `secretsmanager:CreateSecret` (resource `*`, since the resource does not exist at create time) plus `PutSecretValue/DescribeSecret/DeleteSecret/TagResource` scoped to `playagent/tenant/*`.

### Read + substitute (runner)

- `agent/secretsResolver.mjs`:
  - `extractRefs(task, tenantId)` scans for `${NAME}` (mapped to `prefix+NAME`) and `secretRef:<fullName>` (kept only if it already starts with this tenant's prefix — cross-tenant references are ignored).
  - `resolveTaskSecrets(task)` reads each unique name via `GetSecretValue`, substitutes matches, and returns the rewritten text. A missing value keeps the literal placeholder and logs a warning (never substitutes an empty string). Logs `[secrets] 已替換 N 個憑證佔位符` on success.
- Both `explorationRunner.mjs` (Device Farm) and `webExplorationRunner.mjs` call `resolveTaskSecrets(TASK)` at the start of `main()`, before the task text is sent to the model or written to the report.
- IAM: the exploration and web Fargate **task roles** have `secretsmanager:GetSecretValue` scoped to `playagent/tenant/*`. Tenant isolation is enforced in the resolver by forcing every resolved name under `tenantSecretPrefix(PA_TENANT)`.

## Security properties

- Plaintext only ever exists in Secrets Manager and transiently in the runner container's memory.
- Never in: `job.json`, the SQS dispatch message, the ECS task definition/overrides, API responses, `secret-refs.json`, reports, or the step trace.
- Per-tenant isolation by name prefix, enforced on both write (API) and read (runner).

## Verification

Live-tested: set `TEST_USERNAME`/`TEST_PASSWORD` via the API (responses and `secret-refs.json` contained no value; the value was confirmed only in Secrets Manager). A case using `${TEST_USERNAME}`/`${TEST_PASSWORD}` was submitted; `job.json` retained the raw placeholders, and the runner's CloudWatch log showed `[secrets] 已替換 2 個憑證佔位符` with no placeholder leaking into the agent's reasoning.
