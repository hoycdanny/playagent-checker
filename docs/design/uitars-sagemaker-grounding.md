# Design: UI-TARS GUI grounding on SageMaker

## Problem

General vision-language models (Claude, Qwen3-VL) are strong at describing a screen but weak at emitting **exact pixel coordinates** on art-heavy game screens that have no native UI elements. In practice, on a slot-game login screen, general VLMs missed target icons by hundreds of pixels — enough to tap the wrong element or empty space.

## Decision

Add **UI-TARS-1.5-7B** (ByteDance, fine-tuned for GUI grounding) as an option for the **VLM (coordinate) seat**, deployed on **Amazon SageMaker** and served by vLLM. The Agent/SubAgent seats stay on Bedrock; only coordinate grounding switches.

We deliberately did **not** try to fix general VLMs with coordinate-grid overlays — measurements showed the grid did not meaningfully reduce error on these screens.

## Coordinate contract

UI-TARS emits **absolute pixel coordinates in the smart-resized image frame**, following the Qwen2.5-VL convention.

- The runner pre-resizes each screenshot with `smartResizeDims` — both sides aligned to 28, total pixels capped at **2,116,800** (the OSWorld benchmark cap). Larger images degrade 7B grounding badly (~200px error vs ~40px at 2.1M).
- The sent image therefore *is* the coordinate basis. The endpoint's internal smart-resize becomes a no-op.
- Model pixels are mapped back to real device pixels by scaling `smartW×smartH → deviceW×deviceH`.
- **Single-frame:** UI-TARS only sees the current screenshot; prior actions are folded into the text instruction. Extra images would confuse the coordinate basis.

## Serving container (vLLM BYOC)

- Base image `vllm/vllm-openai:v0.19.1`; a FastAPI shim provides SageMaker's `/ping` + `/invocations` contract and proxies to the internal vLLM OpenAI server.
- `/ping` returns 200 immediately so the startup health check passes while vLLM loads asynchronously; `/invocations` returns 503 until ready.
- Multimodal launch args cap image tokens and set the chat template. Env vars (`MODEL_ID`, `MAX_MODEL_LEN`, `DTYPE`, `MODEL_TYPE`) are injected by `CreateModel`.
- Instance: `ml.g6e.xlarge` (L40S). `g4dn` (16 GB T4) cannot hold a 7B multimodal model with a 32K context.

## Cloud build (no local disk/bandwidth)

The vLLM base image (~10 GB) and model weights (~31 GB) are too large to pull over a typical local connection. `agent/sagemaker/cloudBuild.mjs` runs an **AWS CodeBuild** job that, entirely in AWS: downloads the model from Hugging Face, syncs it to S3, builds the vLLM image, and pushes to ECR. Endpoint creation (`deployUitars.mjs`) is then pure API calls and runs from anywhere.

The exploration-runner image is likewise built in the cloud (`cloudBuildRunner.mjs`).

## Wiring

- `modelCatalog.ts` adds a `uitars` entry (vlm seat, pixel coords, `sagemaker` channel).
- When a task is submitted with `vlmModel: 'uitars'`, the engine passes the endpoint name to the Fargate runner as `PA_UITARS_ENDPOINT`.
- The runner routes coordinate calls to `uitarsClient.mjs` (InvokeEndpoint) instead of Bedrock.
- The exploration task role is granted `sagemaker:InvokeEndpoint` on `ui-tars-*`.

## On/off switch (System admin page)

UI-TARS is **off by default**. Admins turn it on or off on the 系統管理 (System admin) page; there is no stored flag — the state is whatever the SageMaker endpoint actually is.

- Fixed names: endpoint `ui-tars-playagent` (cdk context `uitarsEndpoint`), with `ui-tars-playagent-model` and `ui-tars-playagent-config`. The engine always passes this name to runners, so toggling needs no redeploy.
- On = create model/config if missing (free) → `CreateEndpoint` (~8–15 min cold start). Off = `DeleteEndpoint` only; model and config are kept for the next start.
- API: `GET /system/uitars`, `PUT /system/uitars {enabled}` (admin only, `infra/lambda/api/uitarsSwitch.ts`). Last action is recorded in `_system/uitars.json`.
- While off (or still starting), `GET /models` hides `uitars` and task submission with `vlmModel: 'uitars'` is rejected with 400.
- Known gap: a task that was submitted while on and runs after it is turned off gets an endpoint that no longer exists; the runner then only waits on each step (it does not fall back to Bedrock).
- The API role can only touch those three fixed-name resources and may pass `ArtSmokerSageMakerRole` only to `sagemaker.amazonaws.com`.

## Cost

`ml.g6e.xlarge` bills continuously while the endpoint is up, whether or not tasks use it. The AWS bill for 2026-10-01..07 showed **US$62.53/day** (~US$2.6/hr) for an idle endpoint. Weights and image stay staged in S3/ECR, so turning it back on only re-creates the endpoint. `teardownUitars.mjs` still works for endpoints created by `deployUitars.mjs`.
