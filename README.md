# PlayAgent Checker

**AI-driven automated QA for games and apps.** Describe a test flow in plain language; an AI agent watches the screen, taps and swipes for you, judges pass/fail, and produces a multilingual report with screenshots, a step-by-step trace, and a navigation map.

> Languages: **English** · [繁體中文](README_ZH.md) · [简体中文](README_CN.md) · [日本語](README_JP.md) · [한국어](README_KR.md)

---

## What it does

PlayAgent Checker runs on **AWS (us-east-2)** as a serverless control plane plus on-demand execution runners. You upload an app (or point at a web URL), the agent explores it autonomously, and you get repeatable, reviewable test runs.

- **Two real execution backends, both verified end-to-end:**
  - **Web** — headless Chromium via Playwright, on ECS Fargate.
  - **Device Farm** — real Android/iOS devices via AWS Device Farm, driven by Appium from an ECS Fargate runner.
- **The agent loop:** screenshot → VLM locates the target → Agent decides the next action → act on the device → screenshot again, looping until the goal is met or a stop condition fires.
- **Accurate GUI grounding:** the VLM "coordinate" seat can use **UI-TARS-1.5-7B** deployed on SageMaker (fine-tuned for GUI grounding), which is markedly more accurate on art-heavy game screens than general vision models.
- **Knowledge bases:** attach game-genre or scenario knowledge (inline Markdown, or PDF/document retrieval backed by Amazon Bedrock Knowledge Bases + S3 Vectors).
- **Cost guardrails:** every task locks a per-seat price snapshot before running (fail-closed on unknown price) and stops at the budget.
- **Multilingual UI & reports:** 5 locales (zh-Hant, en, zh-Hans, ja, ko).

## Architecture at a glance

```
Browser (Web Console)
  → CloudFront + S3 (static site)
  → API Gateway (+ Cognito JWT, IAM/STS tenant isolation)
  → Lambda API handler → SQS → Dispatcher Lambda → Engine Lambda (orchestrator)
        ├─ AI brain (Amazon Bedrock): Agent / VLM / SubAgent + Knowledge Bases
        │     └─ VLM grounding can route to UI-TARS on Amazon SageMaker
        └─ Device backends (ECS Fargate):
              ├─ Web    → Playwright headless Chromium
              └─ Device Farm → real device + Appium
  → S3 (screenshots, traces, reports, memory map)
  → EventBridge → WebSocket → live push back to the browser
```

The engine (Lambda) only orchestrates; the heavy work (large APK upload, device sessions, the screenshot→act loop) runs in Fargate containers with no time limit. See [docs/architecture.md](docs/architecture.md) for the full picture.

## Repository layout

```
agent/            Execution runners (run inside Fargate containers)
  explorationRunner.mjs   Device Farm real-device runner (Appium loop)
  webExplorationRunner.mjs Web runner (Playwright headless Chromium)
  appiumClient.mjs / playwrightClient.mjs  Device drivers
  imageTools.mjs          smart-resize + annotation for VLM coordinates
  uitarsClient.mjs        UI-TARS (SageMaker) grounding client
  apkMerge.mjs            XAPK / split-APK merge for Device Farm
  sagemaker/              UI-TARS deploy: vLLM BYOC container + CodeBuild scripts
infra/            AWS CDK app (control plane, execution, scheduling, foundation, frontend)
  lib/            CDK stacks
  lambda/         API, engine, dispatcher, WS handlers
  test/           CDK + unit tests
web/              React + Vite web console (5-locale i18n, self-drawn SVG)
docs/             Architecture, design notes, and research
```

## Prerequisites

- Node.js 22+
- An AWS account with credentials configured for **us-east-2** (Device Farm projects live in us-west-2 and are managed by the runner)
- Docker (only needed for local image builds; cloud builds use AWS CodeBuild)
- AWS CDK v2 (`npx cdk`)

## Getting started

```bash
# 1. Install
cd infra && npm install
cd ../web && npm install

# 2. Run tests
cd ../infra && npm test          # CDK + unit tests
cd ../web && npm run ci          # check:i18n + tsc + vitest + build

# 3. Deploy (us-east-2)
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy --all --require-approval never
```

The web console URL and API URL are printed as stack outputs after deploy.

## Using the app

1. **Apps** — create an app (name, platform, genre); upload an APK/IPA/ZIP for native, or just a URL for Web.
2. **Test cases** — draft a flow in plain language (AI turns it into runnable YAML) or hand-write YAML. Secrets use `${ENV}` placeholders — literal passwords are rejected.
3. **Knowledge** *(optional)* — attach genre or scenario knowledge (Markdown injected in full, or PDF retrieval).
4. **Tasks** — pick app + case + runtime (Web or Device Farm) + coordinate model, then submit. Watch it run live, cancel if needed.
5. **Reports** — read the AI narrative, step trace, screenshots, and navigation graph. See the budget and actual spend.

Full in-app help lives on the **Guide** page of the web console.

## UI-TARS grounding (optional, higher accuracy)

General vision models are weak at emitting exact pixel coordinates on busy game art. UI-TARS-1.5-7B, fine-tuned for GUI grounding, is much more precise. To use it, deploy the SageMaker endpoint (built entirely in the cloud, so it does not consume local disk/bandwidth):

```bash
cd agent/sagemaker && npm install
# Cloud build: HF download → S3 → vLLM image → ECR (via CodeBuild)
AWS_REGION=us-east-2 node cloudBuild.mjs
# Create the endpoint (weights + image already staged)
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
# Wire the endpoint name into the engine
cd ../../infra && AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=<endpoint-name>
```

> **Cost note:** the UI-TARS endpoint runs on `ml.g6e.xlarge` (~US$1.86/hr) and bills continuously while up. Tear it down when idle:
> ```bash
> node agent/sagemaker/teardownUitars.mjs <endpoint-name>
> ```

See [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md) for the design.

## Documentation

- [docs/architecture.md](docs/architecture.md) — system architecture, data flow, tenancy
- [docs/design/](docs/design/) — design notes for major subsystems
- [docs/research/](docs/research/) — investigations and findings
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

See repository settings. This project is provided as-is for internal evaluation.
