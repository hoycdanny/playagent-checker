# PlayAgent Checker

**AI-driven automated QA for games and apps.** Describe a test flow in plain language; an AI agent watches the screen, taps and swipes for you, judges pass/fail, and produces a multilingual report with screenshots, a step-by-step trace, and a navigation map.

> Languages: **English** · [繁體中文](README_ZH.md) · [简体中文](README_CN.md) · [日本語](README_JP.md) · [한국어](README_KR.md)

---

## What it does

PlayAgent Checker runs entirely on **AWS (region `us-east-2`)**: a serverless control plane plus execution runners that start per task and shut down when the task ends. You upload an app (or point at a web URL), the agent explores it on its own, and you get repeatable, reviewable test runs.

- **The agent loop:** screenshot → VLM locates the target → Agent decides → act on the device → screenshot again, until the goal is met or a stop condition fires.
- **Looks at the screen, not the UI tree**, so it works on canvas-rendered games (Cocos2d-x, Unity) with no inspectable elements.
- **Knowledge bases, cost guardrails, a 5-language UI** (zh-Hant, en, zh-Hans, ja, ko), and one-click self-update from GitHub.

## Runtimes

| Runtime | What runs it | Available after install | Limits |
| --- | --- | --- | --- |
| **Web browser** | Headless Chromium (Playwright) on ECS Fargate | ✅ | — |
| **Android real device** (Device Farm) | AWS Device Farm + Appium, controller on Fargate | ✅ | 150 min per session (AWS limit); the "long" option reconnects every 140 min and the game restarts |
| **iOS real device** (Device Farm) | AWS Device Farm + Appium | ✅ | Needs an installable `.ipa`; 150 min per session |
| **Android container** (Redroid) | One Graviton EC2 per task (`m7g.xlarge`) running Redroid | ✅ | Games with anti-emulator checks close themselves (use a real device); no video/audio checks; no pinch; 1–72 h per run |
| **Windows PC game** | Amazon GameLift Streams (NVIDIA GPU, `gen6n_medium_win2022`) | ⚙️ one-time setup (see [Optional: Windows](#optional-windows-pc-games-gamelift-streams)) | ≤ 60 min per run; ≤ 1920×1080 total pixels |
| iOS simulator / Linux | — | ❌ not built | — |

Which one to pick for which game: [docs/design/multi-platform-workers.md](docs/design/multi-platform-workers.md).

## What you get by default

After following the install below, this is what is on, what is off, and what needs one extra step.

| Feature | Default | Notes |
| --- | --- | --- |
| Web console, login (Cognito), 5 languages | ✅ On | Sign-up is disabled; admins create users. |
| Apps / test cases / tasks / reports / memory map | ✅ On | AI drafts test cases from plain language (Claude Sonnet 4.5). |
| Runtimes: Web, Device Farm Android/iOS, Android container | ✅ On | Each run starts its own resources and stops them at the end. |
| Default models | ✅ On | Decision **Amazon Nova Lite**, screen analysis **Moonshot Kimi K3**, helper **Amazon Nova Micro**. You can change any seat per task. |
| Knowledge bases (Markdown + PDF retrieval) | ✅ On | PDF retrieval uses Bedrock Knowledge Bases + S3 Vectors + Titan Embeddings V2. |
| Test credentials (Secrets Manager) | ✅ On | Per app; masked values never reach the model. |
| Cost guardrails (budget + fail-closed pricing) | ✅ On | — |
| Cost Analysis page — task estimates | ✅ On | Token × price per task. |
| Cost Analysis page — real AWS bill | ⚙️ Needs account setup | Enable Cost Explorer + activate tags ([below](#enable-the-cost-analysis-page)). |
| Members page (admins) | ✅ On | Add users, reset passwords, move tenants, grant admin. |
| System admin page → **System update** | ⚙️ Optional | Deploy the Updater stack and save a GitHub token ([below](#optional-one-click-system-update)). |
| System admin page → **UI-TARS** | ⛔ **Off** | A GPU grounding model. Admins turn it on/off on the page; it is billed only while on ([below](#optional-ui-tars-grounding-model)). |
| Windows runtime | ⚙️ Optional | One-time GameLift Streams setup from a Windows machine. |

## Architecture

```
Browser ──► CloudFront + S3 (React console)
   │
   │  REST + WebSocket, Cognito JWT
   ▼
API Gateway ──► API Lambda ──────────► S3 data bucket (per-tenant prefixes, tenant-scoped IAM role)
   │              │  POST /tasks          Secrets Manager (test credentials, GitHub token)
   │              ▼                       Bedrock (case drafting, knowledge bases)
   │            SQS dispatch queue
   │              ▼
   │            Dispatcher Lambda ──► Engine Lambda (orchestrator, returns immediately)
   │                                     │
   │          ┌──────────────────────────┼───────────────────────────┬──────────────────────────┐
   │          ▼                          ▼                           ▼                          ▼
   │   Fargate: Web runner     Fargate: Device Farm runner   EC2 (Graviton): Redroid   GameLift Streams: Windows
   │   (Playwright Chromium)   → AWS Device Farm (us-west-2)  Android container         (GPU, optional)
   │          └──────────── each runner: screenshot → Bedrock models → act → write progress to S3 ──┘
   │                                                  │ (optional) SageMaker UI-TARS endpoint
   ▼
WebSocket push (live progress) ◄──────────────────────┘

System admin: API ──► CodeBuild "self-update" (cdk deploy from GitHub) · SageMaker (UI-TARS on/off)
```

CDK stacks (all in `us-east-2`):

| Stack | Contents |
| --- | --- |
| **Foundation** | S3 data bucket, Cognito user pool, tenant IAM role, Bedrock KB service role. |
| **ControlPlane** | HTTP API + JWT authorizer, API Lambda, WebSocket API. |
| **Scheduling** | SQS dispatch queue + Dispatcher Lambda. |
| **Execution** | Engine Lambda, ECS cluster + Fargate task definitions, ECR repos, VPC (no NAT gateway), per-task EC2 launch settings. |
| **Frontend** | CloudFront + S3 static site. |
| **Updater** (optional) | CodeBuild project that redeploys the five stacks above from a GitHub version. |

Details: [docs/architecture.md](docs/architecture.md).

## What it costs

Measured on this project's own account (`us-east-2`, October 2026). AWS prices change, so treat these as estimates.

**When nothing is running (idle):** roughly **US$2–5 / month**. There is no NAT gateway, no always-on server, and no reserved stream capacity. What remains:

- S3 storage (screenshots, reports, uploaded apps; plus ~31 GB of UI-TARS weights if you stage them, about US$0.7/month)
- ECR images (runner images, plus the ~10 GB UI-TARS serving image if built)
- Secrets Manager (US$0.40 per secret per month), CloudWatch Logs, CloudFront
- Lambda, API Gateway, SQS, and Cognito are pay-per-request and stay within pennies at low use

**Per test run (only while it runs):**

| Item | Price | Example |
| --- | --- | --- |
| AI models (Bedrock tokens) | Per token, locked at submit; shown in each report | A 26-step, 10-spin slot test on the default models used ~141k input / 14k output tokens, **under US$0.80** |
| Device Farm real device | **US$0.17 per device minute** | 30 min ≈ US$5.10 |
| Android container (EC2 `m7g.xlarge`) | **US$0.1632 / hour** + disk | 1 h ≈ US$0.17 |
| Fargate runner (1 vCPU / 2 GB) | ~US$0.05 / hour | Web runs and the Device Farm controller |
| Windows (GameLift Streams) | Per second while a session runs | See [GameLift Streams pricing](https://aws.amazon.com/gamelift/streams/pricing/) |
| Self-update | CodeBuild minutes | ~5–15 min per update, a few cents |
| Cost Explorer query (Cost Analysis page) | ~US$0.01 per query | — |

**The one large optional cost: UI-TARS.** `ml.g6e.xlarge` GPU, measured at **US$62.53 / day (~US$2.6 / hour)**, billed the whole time it is on, even with no tasks. It is **off by default**; keep it off unless you need it.

In practice, most of the spend on our account was Bedrock tokens and Device Farm minutes. Neither costs anything when you are not testing.

## Features (what each page does)

| Page | What it's for |
| --- | --- |
| **Guide** | In-app walkthrough (your landing page after login), in 5 languages. |
| **Apps** | One workspace per game/app: name, platform, genre, the artifact (APK/IPA/XAPK/ZIP/EXE) or a URL. Inside: test cases, tasks, reports, memory map, test credentials. |
| **Test cases** (in the app workspace) | One flow for the AI. Draft it in plain language (AI → YAML), hand-write YAML, or import from a spreadsheet. Literal passwords are rejected — use test credentials. |
| **Test tasks** (in the app workspace) | Run a case. Pick the **runtime**, the three **models**, step/budget limits, and **knowledge bases**. Watch the live screen, device logs (real device and Android container), and the agents' reasoning; give the AI instructions mid-run; cancel anytime. |
| **Test reports** | AI narrative, step trace, screenshots, recording playback (real devices), navigation graph, spend and tokens. |
| **Memory map** | Screens visited across all runs become nodes, transitions become edges; later runs navigate faster. |
| **Devices** | Device Farm phones available now, plus the containers, EC2 hosts, and GameLift capacity currently running. |
| **Knowledge** | Shared knowledge bases (game genre / scenario): Markdown injected in full and/or PDF retrieval. |
| **Cost Analysis** | Task estimates by app and model, and the real AWS bill by service / component (once enabled). |
| **Members** (admins) | Add users, reset passwords, disable/enable, move tenants, grant or remove admin. |
| **System admin** (admins) | **System update** from GitHub (version compare, one-click update, progress, history) and the **UI-TARS** on/off switch. |

## The AI: three model "seats"

Models are organized by **role (seat)**, not by vendor. Each seat is chosen per task:

- **Agent (decision)** — decides the next action from the screen and goal. Default **Amazon Nova Lite**.
- **VLM (screen analysis / coordinates)** — turns "the thing to tap" into pixels. Default **Moonshot Kimi K3**. UI-TARS-1.5-7B appears here only while an admin has it turned on.
- **Subagent (helper)** — checks whether an action worked, tracks numbers, verifies completion. Default **Amazon Nova Micro**.

You never pick an SDK or endpoint; the system derives it from the model id.

## Cost guardrails

Every task can have a step limit and a budget. Before running, the engine **locks a price snapshot** for each seat's model (fail-closed: if a price is unknown, the run is refused). Execution stops once spend reaches the budget, and the report shows actual spend and tokens.

## Glossary

- **Seat** — a model role (Agent / VLM / Subagent), not a vendor.
- **VLM** — Vision-Language Model; reads the screenshot and locates coordinates.
- **UI-TARS** — a ByteDance vision model fine-tuned for GUI grounding, served on SageMaker via vLLM. Optional, off by default.
- **Redroid** — Android running in a container on an ARM EC2 host (the "Android container" runtime).
- **Locality** — where the device is: `cloud` (provided) or `attached` (your local device, still driven by the cloud).
- **Terminal state** — `pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`.
- **Fail-closed** — refuse to run rather than spend at an unknown price.

---

# 🚀 Install on a clean AWS account (step by step)

This section assumes **no prior AWS experience**. Follow it top to bottom. Total time: about **60–90 minutes**, most of it waiting for AWS.

> Everything deploys to **`us-east-2` (Ohio)**. Use that region everywhere unless you know what you are changing.
>
> Commands are written for **bash** (macOS, Linux, Git Bash, WSL). On Windows PowerShell, set variables with `$env:NAME="value"` instead of `NAME=value command`.

## Step 0 — Install the tools on your computer

| Tool | Why | Install |
| --- | --- | --- |
| **Node.js 22+** | Runs the build and deploy scripts | https://nodejs.org (the "LTS" installer) |
| **AWS CLI v2** | Talks to your AWS account | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| **Git** | Gets this code | https://git-scm.com/downloads |

```bash
node --version    # v22.x or higher
aws --version     # aws-cli/2.x
git --version
```

You do **not** need Docker; container images are built in the cloud (AWS CodeBuild).

## Step 1 — Get the code

```bash
git clone https://github.com/hoycdanny/playagent-checker.git
cd playagent-checker
npm install
```

## Step 2 — Connect the AWS CLI to the account

Ask the account owner for an **Access Key ID** and **Secret Access Key** (AWS Console → IAM → Users → Security credentials → Create access key). Then:

```bash
aws configure
# AWS Access Key ID     : <paste>
# AWS Secret Access Key : <paste>
# Default region name   : us-east-2
# Default output format : json

aws sts get-caller-identity   # should print your account number
```

> The credentials must be able to create Lambda, S3, Cognito, API Gateway, IAM, ECS, EC2, ECR, CodeBuild, SageMaker, Bedrock, and CloudFront resources. For a first setup, an admin user (`AdministratorAccess`) is simplest.

## Step 3 — Turn on the AI models (Amazon Bedrock)

A new account has Bedrock models **off**. Enable them once, or every run fails.

1. AWS Console → **Bedrock** → region (top-right) **US East (Ohio) us-east-2**.
2. Left menu → **Model access** → **Enable specific models**.
3. Enable at least:
   - **Amazon – Nova Lite** (default decision model)
   - **Amazon – Nova Micro** (default helper model)
   - **Moonshot AI – Kimi K3** (default screen-analysis model)
   - **Anthropic – Claude Sonnet 4.5** (drafts test cases, reads imported spreadsheets)
   - **Amazon – Titan Text Embeddings V2** (knowledge-base search)
4. Wait for **Access granted**. Enabling every model in the region is fine for evaluation; the app lists whatever is available for each seat.

## Step 4 — Prepare CDK (one-time per account)

```bash
cd infra
npx cdk bootstrap aws://ACCOUNT_ID/us-east-2
```

Replace `ACCOUNT_ID` with the number from Step 2.

## Step 5 — Deploy the backend

From `infra/`:

```bash
AWS_REGION=us-east-2 npx cdk deploy \
  PlayAgentDev-Foundation PlayAgentDev-ControlPlane \
  PlayAgentDev-Scheduling PlayAgentDev-Execution \
  --require-approval never
```

> **Optional cost allocation tags.** Every resource is tagged `project`, `stage`, `component`. Add your own with `-c` (they also flow to the EC2/Fargate started at run time):
> `-c costCenter=QA-1234 -c owner=alice -c team=game-qa` (keys: `costCenter`, `owner`, `team`, `env`, `costAllocation`). Use the same flags on every deploy.

This takes ~10–15 minutes. Then print the values you need in the next steps:

```bash
aws cloudformation describe-stacks --region us-east-2 --stack-name PlayAgentDev-Foundation \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
aws cloudformation describe-stacks --region us-east-2 --stack-name PlayAgentDev-ControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'||OutputKey=='WsUrl'].[OutputKey,OutputValue]" --output table
```

Write down:

- **Data bucket** — output name contains `DataBucket` (Ref), looks like `playagentdev-foundation-databucket…`
- **User Pool ID** — contains `UserPoolId`, like `us-east-2_XXXXXXXXX`
- **User Pool Client ID** — contains `UserPoolClientId`
- **ApiUrl** — `https://xxxx.execute-api.us-east-2.amazonaws.com`
- **WsUrl** — `wss://xxxx.execute-api.us-east-2.amazonaws.com/prod`

## Step 6 — Build the runner images (required)

The Web and Device Farm runners run from container images in your ECR. They are built in the cloud with CodeBuild, so nothing large downloads to your computer.

```bash
cd ../agent/sagemaker && npm install
export PA_SM_BUCKET=PASTE_DataBucket     # from Step 5 — the scripts upload build sources here
export AWS_REGION=us-east-2

# a) Creates the shared CodeBuild role and stages the UI-TARS weights + serving image
#    (needed later only if you turn UI-TARS on). ~20–40 min, runs in AWS.
#    It does NOT start a GPU; storage costs about US$2/month.
node cloudBuild.mjs

# b) Build and push the two runner images (a few minutes each).
node cloudBuildRunner.mjs
node cloudBuildWebRunner.mjs
```

> The scripts' built-in bucket name belongs to the original developer's account, so always set `PA_SM_BUCKET` to **your** data bucket.

## Step 7 — Build the web console

```bash
cd ../../web
cat > .env.production <<'EOF'
VITE_COGNITO_REGION=us-east-2
VITE_COGNITO_USER_POOL_ID=PASTE_UserPoolId
VITE_COGNITO_CLIENT_ID=PASTE_UserPoolClientId
VITE_API_URL=PASTE_ApiUrl
VITE_WS_URL=PASTE_WsUrl
EOF
npm run build
```

Replace each `PASTE_...` with the value from Step 5 before building.

## Step 8 — Deploy the web console

```bash
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Frontend --require-approval never
aws cloudformation describe-stacks --region us-east-2 --stack-name PlayAgentDev-Frontend \
  --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text
```

Open the printed `https://xxxx.cloudfront.net` address; you should see the login page.

## Step 9 — Create your first (admin) login

Sign-up is disabled on purpose. Pick an email and a password (min 8 chars, upper + lower + number). `tenant` isolates each customer's data; use something short, e.g. a company name.

**Option A — script (recommended):**

```bash
cd ../agent/sagemaker
AWS_REGION=us-east-2 node createUser.mjs \
  --email you@example.com --tenant acme --password 'ChangeMe123!' --admin
```

**Option B — at deploy time:** add `-c adminEmail=you@example.com -c adminPassword='ChangeMe123!' -c adminTenant=acme` to the Foundation deploy.

<details>
<summary>Option C — raw AWS CLI</summary>

```bash
POOL_ID=PASTE_UserPoolId
aws cognito-idp admin-create-user --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --password 'ChangeMe123!' --permanent
aws cognito-idp admin-add-user-to-group --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --group-name admins
```
</details>

After that, create everyone else from the **Members** page.

## Step 10 — Log in and run a first test

Open the CloudFront URL and log in. You land on the **Guide**. Then:

1. **Apps** → create an app (upload an APK/IPA/XAPK, or enter a URL for Web).
2. In the app workspace → **Test cases** → describe a flow; the AI turns it into a case.
3. **Test tasks** → pick the case and a runtime (**Web**, **Android/iOS real device**, or **Android container**) → submit. Models default to Nova Lite / Kimi K3 / Nova Micro.
4. Watch it live, then read the **report**.

> **No Members / System admin items?** They show only for admins, and your login token picks up group changes only at sign-in. Log out and back in after being made an admin.

✅ **You now have a working environment.** Everything below is optional.

---

## Optional: one-click system update

Lets admins update the whole platform to a GitHub version from **System admin → System update** (runs tests first, then `cdk deploy` in CodeBuild).

1. Deploy the Updater stack once (it is never updated by itself):
   ```bash
   cd infra
   AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Updater --require-approval never --exclusively
   ```
   Using a fork? Add `-c githubRepo=owner/name` to this and every deploy.
2. Create a GitHub **fine-grained** token for this repository with **Contents: Read-only** and **Metadata: Read-only**.
3. Open **System admin**, paste the token, and save. It is stored in Secrets Manager (`playagent/github`) and never shown again.

The update button redeploys IAM and resources with high privileges, so only admins see it and every run is recorded. Design notes: [docs/design/self-update.md](docs/design/self-update.md).

## Optional: UI-TARS grounding model

UI-TARS-1.5-7B is a GUI-grounding model that can be more precise on small buttons. It is **off by default** because its GPU costs about **US$62.5 / day while on**. Today only the Device Farm real-device runtime uses it; other runtimes fall back to a Bedrock vision model.

Before the switch works, the account needs:

1. The staged weights and serving image from **Step 6a** (`cloudBuild.mjs`).
2. A SageMaker execution role named **`ArtSmokerSageMakerRole`** (the name the stacks expect by default; it lets SageMaker pull the image and read the weights):
   ```bash
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   BUCKET=PASTE_DataBucket
   aws iam create-role --role-name ArtSmokerSageMakerRole --assume-role-policy-document \
     '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"sagemaker.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
   aws iam put-role-policy --role-name ArtSmokerSageMakerRole --policy-name uitars --policy-document "{
     \"Version\":\"2012-10-17\",\"Statement\":[
     {\"Effect\":\"Allow\",\"Action\":\"ecr:GetAuthorizationToken\",\"Resource\":\"*\"},
     {\"Effect\":\"Allow\",\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\",\"ecr:BatchCheckLayerAvailability\"],
      \"Resource\":\"arn:aws:ecr:us-east-2:${ACCOUNT}:repository/playagent-vllm-byoc\"},
     {\"Effect\":\"Allow\",\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::${BUCKET}\"},
     {\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::${BUCKET}/sagemaker-models/ui-tars/*\"},
     {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\",\"logs:DescribeLogStreams\",\"cloudwatch:PutMetricData\"],\"Resource\":\"*\"}]}"
   ```
   To use a different role, deploy ControlPlane with `-c uitarsRoleArn=arn:aws:iam::…:role/…`.

Then use **System admin → UI-TARS → Turn on**. It takes about 8–15 minutes to reach **On**; while starting, it is already billed. UI-TARS then appears in the task VLM menu. Turn it **off** on the same page when you are done; that deletes the GPU endpoint and keeps the model settings, so turning it on again needs no setup. While it is off, the model menu hides UI-TARS and tasks that ask for it are rejected.

More: [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md).

## Optional: Windows PC games (GameLift Streams)

Run this once **from a Windows machine** (it packages Windows tools for the GPU host):

```powershell
cd worker\windows-host\gamelift
npm install
$env:AWS_REGION="us-east-2"; node setup.mjs --capacity 2
```

It creates the GameLift Streams application and a stream group with **no always-on capacity** (nothing is billed while no test runs) and up to 2 concurrent runs. Then the **Windows** runtime appears when submitting a task. A first start takes 10–15 minutes; each run is capped at 60 minutes. Re-run `setup.mjs` after changing the Windows host scripts; self-update does not cover it.

## Enable the Cost Analysis page

The **Cost Analysis** page shows the real AWS bill (from Cost Explorer) next to task estimates (tokens × price). Estimates work immediately. For the real bill, once per account:

1. **Billing and Cost Management → Cost Explorer** → enable. Data appears ~24 h later.
2. **Billing and Cost Management → Cost allocation tags** → activate `project`, `stage`, `component` (and any custom tags).
3. Wait a day. Tags only apply to cost after activation; earlier cost is never backfilled.

Cost Explorer is only in `us-east-1` (the app queries it there), costs about US$0.01 per query, and lags ~24 h. Activating tags needs billing access.

Note: Bedrock tokens and Device Farm minutes do not carry resource tags, so the real-bill view by `component` shows them separately. Device Farm minutes are also matched to each run by session name.

## Device Farm (real phones) note

No extra setup. Device Farm lives in **us-west-2**; the runner creates its project automatically. When you pick a real-device runtime, a dropdown lists the phones available now (model, OS, resolution, memory, CPU); "Auto" takes the first available one. If the screen stops changing past a hard limit (stuck install, frozen app, reCAPTCHA wall), the run ends as `error` instead of billing in a loop.

## Test credentials (registration/login flows)

Keep accounts and passwords per app under **App → Test credentials**, one key–value row per field (e.g. `帳號`, `密碼`, `伺服器名稱`). Each row is **masked** (default; the AI only sees `${key}` and the runner fills in the value at input time) or **visible** (for non-sensitive values the AI must pick from a list). Write cases normally, without referencing credentials.

Values live only in **AWS Secrets Manager** (`playagent/tenant/<tenant>/app/<appId>/credentials`). Masked values are never shown in the UI, returned by the API, sent to a model, or written to S3, task definitions, reports, or traces. Details: [docs/design/test-credentials.md](docs/design/test-credentials.md).

---

## Cleanup and troubleshooting

**Stop the biggest costs first:** turn UI-TARS **off** on the System admin page, and make sure no long Android-container or Device Farm runs are still going (Devices page).

**Tear everything down** (the data bucket and Cognito user pool are retained by design; delete them by hand if you really want them gone):

```bash
cd infra
AWS_REGION=us-east-2 npx cdk destroy --all
```

Also left behind: the runner ECR repos `playagent-exploration-runner` / `playagent-web-runner` (CDK retains them by default), the ECR repo `playagent-vllm-byoc`, the CodeBuild projects `playagent-uitars-build` / `playagent-runner-build` / `playagent-web-runner-build`, the role `PlayAgentCodeBuildUitarsRole`, the SageMaker model/config `ui-tars-playagent-*`, and (if set up) the GameLift Streams application and stream group.

| Symptom | Fix |
| --- | --- |
| Deploy fails: *"not bootstrapped"* | Run Step 4 for `us-east-2`. |
| Runs error with *AccessDenied* / model not available | Enable model access in **us-east-2** (Step 3). |
| Web / Device Farm runs fail to start (image not found) | Build the runner images (Step 6). |
| Login page loads but sign-in fails, or the page is blank | Wrong values in `web/.env.production`, or the web was not rebuilt + redeployed after editing (Steps 7–8). |
| A game closes itself right away on the Android container | It has an anti-emulator check; use an Android real device. |
| UI-TARS shows **Failed** | Turn it off (stops billing), check the reason on the card, verify Step 6a and the SageMaker role, then turn it on again. |
| System update says the token lacks permission | The token needs **Contents: Read-only** on this repository. |
| Can't sign up | By design; admins create users (Step 9 / Members page). |

---

## Repository layout

```
agent/            Execution runners
  explorationRunner.mjs    Device Farm / Android container / Windows runner (one loop, different drivers)
  webExplorationRunner.mjs Web runner (Playwright headless Chromium)
  uitarsClient.mjs         UI-TARS (SageMaker) grounding client
  sagemaker/               Cloud build scripts (runner images, UI-TARS), createUser.mjs
infra/            AWS CDK app (Foundation, ControlPlane, Scheduling, Execution, Frontend, Updater)
web/              React + Vite web console (5-locale i18n)
worker/           Platform workers, incl. windows-host/gamelift (Windows GameLift Streams setup)
docs/             Architecture, design notes, research
```

## For developers

```bash
npm run test:web       # web unit tests
npm run test:worker    # worker unit tests
cd infra && npm test   # CDK + Lambda unit tests
npm run build:web      # i18n check + type-check + build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).

## License

See repository settings. Provided as-is for internal evaluation.
