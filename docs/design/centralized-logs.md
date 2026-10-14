# Centralized logs (system admin)

PlayAgent Checker runs across many AWS services (API Lambda, engine, dispatcher, three
WebSocket Lambdas, two Fargate runners, the self-update and image-build CodeBuild projects).
When something fails it is tedious to open each log group in the CloudWatch console. The
**System admin → Centralized logs** panel queries all of them from one place.

## How it works

- **Discovery.** The API Lambda discovers the platform's log groups by naming prefix, so no
  log-group names are hard-coded:
  - `/aws/lambda/<stagePrefix>-*` — every platform Lambda (API, engine, dispatcher, WebSocket).
  - `/playagent/<stagePrefix>*` — the two Fargate runner groups (pinned names, see below) and the
    self-update CodeBuild group.
  - `/aws/codebuild/playagent-*` — the runner image-build and installer CodeBuild projects.
  `<stagePrefix>` is the stack prefix (e.g. `PlayAgentDev`), injected into the API Lambda as
  `LOG_STAGE_PREFIX`.

- **Pinned runner log groups.** ECS tasks otherwise get random CloudWatch group names, which are
  not discoverable by prefix. The Execution stack therefore gives the two runners fixed names:
  `/playagent/<stagePrefix>/runner-exploration` and `/playagent/<stagePrefix>/runner-web`.

- **Query.** The panel uses **CloudWatch Logs Insights** to search the selected groups over a time
  window with an optional keyword, interleaved and sorted newest-first. Insights is asynchronous:
  - `GET  /system/logs/sources` — list the discovered sources (friendly label + kind).
  - `POST /system/logs/query` — start a query (`sources?`, `minutes`, `pattern?`, `limit`), returns a `queryId`.
  - `GET  /system/logs/query/{queryId}` — poll results until `done`.

- **Classification.** Each group is mapped to a friendly label (control-plane API, engine,
  dispatcher, WebSocket auth/connect/push, runner exploration/web, self-update, image builds) and a
  kind (`lambda` / `ecs` / `codebuild` / `other`) for colour-coding. Log level (ERROR/WARN/INFO/DEBUG)
  is best-effort parsed from each message.

## Permissions

All admin-only (`requireAdmin`). The API Lambda is granted read-only CloudWatch Logs access scoped
to the three prefixes above: `logs:StartQuery`, `logs:FilterLogEvents`, `logs:GetLogEvents`,
`logs:DescribeLogStreams` on the platform log-group ARNs, plus `logs:DescribeLogGroups`,
`logs:GetQueryResults`, `logs:StopQuery` on `*` (these have no resource-level support).

## Not covered

- The Redroid Android-container EC2 host drives itself from user-data and does not ship a
  CloudWatch log stream; per-job detail for those runs lives in the S3 data bucket under
  `tenants/<tenantId>/jobs/<jobId>/` (status, report, step artifacts).
- AWS Device Farm artifacts (device video, native logs) are Device Farm's own; the controller's
  logs land in the exploration runner group.
- Regions: Device Farm is always `us-west-2`; everything else follows the deploy region.
