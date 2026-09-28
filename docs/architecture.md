# Architecture

PlayAgent Checker is a serverless control plane on AWS (**us-east-2**) with on-demand execution runners on ECS Fargate. This document describes the deployed architecture and the main data flows.

## Stacks (AWS CDK)

The CDK app in `infra/` is split into cohesive stacks:

| Stack | Responsibility |
| --- | --- |
| **Foundation** | Shared data bucket (S3), tenant IAM roles, base primitives. |
| **ControlPlane** | HTTP API (API Gateway) + Cognito JWT authorizer, REST Lambda handler, WebSocket API for live push. |
| **Scheduling** | SQS dispatch queue + Dispatcher Lambda (SQS-triggered, invokes the Engine asynchronously). |
| **Execution** | Engine Lambda (orchestrator), the two ECS Fargate task definitions (Device Farm runner, Web runner), their task roles, ECR repositories, and the SageMaker/UI-TARS wiring. |
| **Frontend** | CloudFront + S3 static hosting for the React web console. |

## Request path

```
User (browser)
  │  loads SPA
  ▼
CloudFront → S3 (static site)
  │  SPA calls REST API (JWT from Cognito)
  ▼
API Gateway ──(JWT authorizer: Cognito)──► Lambda API handler
  │  POST /tasks  → enqueue
  ▼
SQS (dispatch queue)
  │
  ▼
Dispatcher Lambda ──(InvocationType: Event)──► Engine Lambda
```

The **Engine Lambda** is the orchestrator. It does not run the screenshot loop itself (512 MB / short timeout cannot handle multi-hundred-MB APK uploads or multi-minute sessions). Instead it launches an **ECS Fargate task** (`ecs:RunTask`) and returns immediately. The task writes its own progress and terminal state to S3.

## Execution backends (ECS Fargate)

Both backends share the same loop shape and S3 output contract; only the device driver differs.

### Device Farm (real devices)

- Runner: `agent/explorationRunner.mjs` (container image `playagent-exploration-runner`).
- Reads the APK/IPA from S3, merges XAPK / split APKs into a universal APK when needed (`apkMerge.mjs`, APKEditor), selects a device (preferring 32-bit-capable devices for 32-bit-only apps), uploads to AWS Device Farm, opens a remote-access session, and drives it via Appium.
- Device Farm projects live in **us-west-2**; the runner manages them.

### Web (headless browser)

- Runner: `agent/webExplorationRunner.mjs` (container image `playagent-web-runner`).
- Launches headless Chromium via Playwright, navigates to the target URL, and drives clicks/scrolls/typing.

## The agent loop

Each step:

1. **Screenshot** the device/browser.
2. **smart-resize** the screenshot to a 28-aligned frame capped at ~2.1M pixels (`imageTools.mjs`). The sent image *is* the model's coordinate basis.
3. **VLM locates** the target and returns coordinates in that frame.
4. **Agent decides** the next action (tap / swipe / type / back / done).
5. **Act** on the device (coordinates mapped from the smart-resized frame back to real device pixels).
6. Write `screenshots/<i>.png`, `steps/<i>.json`, `traces/<i>.json`, an annotated tap image, and update the memory map (`structure.json`) to S3.

The loop ends on a terminal state: `pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`.

## AI brain (model seats)

Models are organized by **role (seat)**, not by vendor:

- **Agent** — decides the next action.
- **VLM** — turns "the thing to tap" into on-screen coordinates.
- **SubAgent** — lighter sub-tasks on a cheaper model.

Agent/SubAgent and general VLMs run on **Amazon Bedrock**. The VLM seat can instead route to **UI-TARS-1.5-7B on Amazon SageMaker** for sharper GUI grounding — see [design/uitars-sagemaker-grounding.md](design/uitars-sagemaker-grounding.md).

`channel` (bedrock / bedrock-converse / openai / sagemaker) is derived from the modelId; users never pick it.

## Knowledge bases

Two forms, both reusable across users:

- **Markdown** — edited in the browser, injected in full at run time (small, certain facts).
- **PDF / document retrieval** — an Amazon Bedrock Knowledge Base backed by Titan Text Embeddings v2 + S3 Vectors; the agent retrieves relevant snippets by task goal (large reference material).

## Live updates

The Engine emits status/trace events to **EventBridge**, which fan out over the **WebSocket API** to push live progress back to the browser while a task runs.

## Cost guardrails

Before a run, the engine locks a price snapshot for each active seat model. If a model has no known price, the run is refused (**fail-closed** — never start at unknown cost). During the run, execution stops once accumulated spend reaches the task budget. The report records actual spend and token usage.

The UI-TARS SageMaker endpoint is billed by GPU-hour (not per token) while it is up; it is torn down when idle.

## Tenancy & security

- Cognito provides login and JWT; the API Gateway authorizer validates it.
- IAM/STS scope each tenant to its own S3 prefix (`tenants/<tenantId>/...`).
- Test cases may not contain literal secrets; `${ENV}` placeholders / secret references are used and literal secrets are rejected at authoring time.
