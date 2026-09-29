# PlayAgent Checker

**AI-driven automated QA for games and apps.** Describe a test flow in plain language; an AI agent watches the screen, taps and swipes for you, judges pass/fail, and produces a multilingual report with screenshots, a step-by-step trace, and a navigation map.

> Languages: **English** · [繁體中文](README_ZH.md) · [简体中文](README_CN.md) · [日本語](README_JP.md) · [한국어](README_KR.md)

---

## What it does

PlayAgent Checker runs entirely on **AWS (region `us-east-2`)**: a serverless control plane plus on-demand execution runners. You upload an app (or point at a web URL), the agent explores it autonomously, and you get repeatable, reviewable test runs.

- **Two real execution backends, both verified end-to-end:** **Web** (headless Chromium via Playwright on ECS Fargate) and **Device Farm** (real Android/iOS devices via AWS Device Farm, driven by Appium).
- **The agent loop:** screenshot → VLM locates the target → Agent decides → act on the device → screenshot again, until the goal is met or a stop condition fires.
- **Accurate GUI grounding (optional):** the VLM seat can use **UI-TARS-1.5-7B** on SageMaker for far more precise coordinates on busy game art.
- **Knowledge bases, cost guardrails, and a 5-language UI** (zh-Hant, en, zh-Hans, ja, ko).

Architecture details: [docs/architecture.md](docs/architecture.md).

## Who it's for

- **QA teams** who want to test games/apps without writing or maintaining brittle UI scripts.
- **Studios shipping many titles** (slots, RPG, MMORPG, casual…) that need repeatable smoke/regression runs across builds.
- **Anyone** who can describe a flow in words but doesn't want to learn an automation framework.

## How it works (end to end)

```
① Create an app        Upload APK/IPA/ZIP, or point at a web URL. Tag its genre.
② Write a test case    Describe the flow in plain language → AI drafts runnable YAML.
③ (Optional) Knowledge Attach game-genre or scenario knowledge so the AI understands the domain.
④ Submit a task        Pick runtime (Web / Device Farm) + coordinate model, queue to the cloud.
⑤ The agent runs       screenshot → VLM finds coordinates → Agent decides → act → repeat.
⑥ Report + memory      Multilingual report (narrative, screenshots, step trace, cost) +
                        a navigation map that accumulates across runs.
```

The AI never relies on brittle element selectors — it **looks at the actual screen** like a human tester, which is why it works on canvas-rendered games (Cocos2d-x, Unity) that have no inspectable UI tree.

## Features (what each page does)

| Page | What it's for |
| --- | --- |
| **Guide** | The in-app walkthrough (this is your landing page after login), localized in 5 languages. |
| **Apps** | One workspace per game/app. Create with name + platform + genre; upload the artifact (native) or a URL (Web). Holds that app's cases, tasks, reports, and memory. |
| **Test Cases** | A case = one flow for the AI to run. Draft it in plain language (AI → YAML) or hand-write YAML. Secrets use `${ENV}` placeholders; literal passwords are rejected. |
| **Test Tasks** | Send a case to run. Choose **runtime** (Web browser or Device Farm real device), the **coordinate model** (defaults to UI-TARS), and multi-select **knowledge bases**. Watch live; cancel anytime. |
| **Test Reports** | Read-only result: AI narrative, step-by-step trace, gameplay screenshots, navigation graph, plus budget vs actual spend and token usage. |
| **Memory Map** | An app-wide picture built across all runs: visited screens become nodes, transitions become edges — later tests navigate faster. |
| **Knowledge** | Reusable knowledge bases shared across users. Two kinds (game genre / scenario), each holding **Markdown** (injected in full) and/or **PDF retrieval** (vector search over uploaded docs). |
| **Devices** | Browse the real device models available on AWS Device Farm. Cloud runners are created per task and reclaimed automatically — no manual device management. |

## The AI: three model "seats"

Models are organized by **role (seat)**, not by vendor. Each seat is chosen independently per task:

- **Agent (decision)** — the brain; looks at the current screen and goal and decides the next action.
- **VLM (coordinates)** — vision; turns "the thing to tap" into actual on-screen pixels. **Defaults to UI-TARS-1.5-7B on SageMaker** (fine-tuned for GUI grounding; far more accurate on game art than general models, and replies in Traditional Chinese).
- **Subagent (helper)** — lighter sub-tasks on a cheaper model to save cost.

Knowledge-base search additionally uses **Amazon Titan Text Embeddings v2** with **Amazon Bedrock Knowledge Bases + S3 Vectors**. You never pick an SDK/endpoint — the system derives it from the model id.

## Cost guardrails

Every task has a budget. Before running, the engine **locks a price snapshot** for each seat's model (fail-closed: if a price is unknown, the run is refused — it never starts at unknown cost). Execution stops once spend hits the budget, and the report shows actual spend and token usage.

## Glossary

- **Seat** — a model role (Agent / VLM / SubAgent), not a vendor.
- **VLM** — Vision-Language Model; reads the screenshot and locates coordinates.
- **UI-TARS** — a ByteDance vision model fine-tuned for GUI grounding, served on SageMaker via vLLM; reports absolute pixels on the smart-resized image.
- **Agent loop** — screenshot → VLM locates → Agent decides → act → repeat. The engine runs in the cloud (Lambda orchestrates; the runner container runs on Fargate).
- **Knowledge base** — Markdown (injected in full) or PDF retrieval (vector search by task goal).
- **Locality** — where the device under test is: `cloud` (provided) or `attached` (your local device, still driven by the cloud brain).
- **Terminal state** — a task's end state: `pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`.
- **Fail-closed** — refuse to run rather than spend at an unknown price.

---

# 🚀 Install on a clean AWS account (step by step)

This section assumes **no prior AWS experience**. Follow it top to bottom. Total time: about **45–60 minutes**, most of it waiting for AWS to finish.

> Everything deploys to **`us-east-2` (Ohio)**. Use that region everywhere unless you know what you are changing.

## Step 0 — Install the tools on your computer

You need three things installed locally. Copy-paste these checks; if a version prints, you are good.

| Tool | Why | Install |
| --- | --- | --- |
| **Node.js 22+** | Runs the build and deploy scripts | https://nodejs.org (download the "LTS" installer) |
| **AWS CLI v2** | Talks to your AWS account | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| **Git** | Gets this code | https://git-scm.com/downloads |

```bash
node --version    # should print v22.x or higher
aws --version     # should print aws-cli/2.x
git --version
```

You do **not** need Docker — large container images are built in the cloud.

## Step 1 — Get the code

```bash
git clone https://github.com/hoycdanny/playagent-checker.git
cd playagent-checker
```

## Step 2 — Connect the AWS CLI to the account

Ask the account owner for an **Access Key ID** and **Secret Access Key** (AWS Console → IAM → Users → Security credentials → Create access key). Then:

```bash
aws configure
# AWS Access Key ID     : <paste>
# AWS Secret Access Key : <paste>
# Default region name   : us-east-2
# Default output format  : json
```

Verify it works — this should print an account number:

```bash
aws sts get-caller-identity
```

> The credentials need permission to create resources (Lambda, S3, Cognito, API Gateway, IAM, ECS, SageMaker, Bedrock, CloudFront). For a first setup, an admin user (AWS managed policy `AdministratorAccess`) is simplest. You can tighten later.

## Step 3 — Turn on the AI models (Amazon Bedrock)

A brand-new account has AI models **switched off** by default. You must enable them once, or every test run will fail.

1. Open the AWS Console → search **Bedrock** → open it → make sure the region (top-right) is **US East (Ohio) us-east-2**.
2. Left menu → **Model access** → **Enable specific models** (or "Manage model access").
3. Enable at least these, then **Save** (approval is usually instant):
   - **Anthropic – Claude Sonnet 4.5** (writes test cases, strong fallback VLM)
   - **Amazon – Titan Text Embeddings V2** (knowledge-base search)
   - **Amazon – Nova Micro** (helper sub-tasks)
   - **Qwen – Qwen3-VL** and **MiniMax** models if listed (default vision/decision models)
4. When status shows **Access granted**, you are done. You can enable more later; the app lists whatever is available.

> Tip: enabling "all models" in this region is fine for evaluation and saves guessing.

## Step 4 — Prepare CDK (one-time per account)

The infrastructure is defined with **AWS CDK**. It needs a one-time "bootstrap" in the region.

```bash
cd infra
npm install
npx cdk bootstrap aws://ACCOUNT_ID/us-east-2
```

Replace `ACCOUNT_ID` with the number from Step 2 (`aws sts get-caller-identity`). This creates a small staging bucket CDK uses to upload code.

## Step 5 — Deploy the backend

From the `infra/` folder:

```bash
AWS_REGION=us-east-2 npx cdk deploy \
  PlayAgentDev-Foundation \
  PlayAgentDev-ControlPlane \
  PlayAgentDev-Scheduling \
  PlayAgentDev-Execution \
  --require-approval never
```

> **Optional — cost allocation tags.** Every resource is auto-tagged with `project`, `stage`, and `component`. You can add your own tags at deploy time (e.g. to charge back to a cost center) by passing `-c` context. These flow to all resources, including the EC2/Fargate started at runtime, and power the **Cost Analysis** page once activated (see "Enable the Cost Analysis page" below).
>
> ```bash
> AWS_REGION=us-east-2 npx cdk deploy \
>   PlayAgentDev-Foundation PlayAgentDev-ControlPlane \
>   PlayAgentDev-Scheduling PlayAgentDev-Execution \
>   --require-approval never \
>   -c costCenter=QA-1234 -c owner=alice -c team=game-qa
> ```
>
> Recognized keys: `costCenter`, `owner`, `team`, `env`, `costAllocation`. Use the same `-c` flags on every stack you deploy so the tags stay consistent.

This takes ~10–15 minutes. When it finishes, run this one command to print the four values you need (it handles the naming automatically):

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Foundation \
  --query "Stacks[0].Outputs[?contains(OutputKey,'UserPool')].[OutputKey,OutputValue]" --output table
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-ControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'||OutputKey=='WsUrl'].[OutputKey,OutputValue]" --output table
```

You are looking for four values:

- **User Pool ID** — the output whose name contains `UserPoolId`; looks like `us-east-2_XXXXXXXXX`
- **User Pool Client ID** — the output whose name contains `UserPoolClientId`; a long letter/number string
- **ApiUrl** — `https://xxxx.execute-api.us-east-2.amazonaws.com`
- **WsUrl** — `wss://xxxx.execute-api.us-east-2.amazonaws.com/prod`

## Step 6 — Deploy the UI-TARS coordinate model (required)

PlayAgent uses **UI-TARS-1.5-7B** on SageMaker for accurate on-screen coordinates — it is the default and is required for good results (general models miss tap targets by hundreds of pixels on game art). This is built entirely in the cloud, so it does **not** use your computer's disk or bandwidth.

```bash
cd ../agent/sagemaker && npm install
# 1) Cloud build: download the model, build the serving image, push to your account (via AWS CodeBuild).
#    Takes ~20–40 min; runs in AWS, nothing downloads to your machine.
AWS_REGION=us-east-2 node cloudBuild.mjs
# 2) Create the endpoint (weights + image are already staged). Prints ENDPOINT_NAME when InService.
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
```

Note the `ENDPOINT_NAME=ui-tars-...` it prints at the end. Now wire it into the engine and re-deploy just the execution stack:

```bash
cd ../../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=PASTE_ENDPOINT_NAME
```

> **💲 Important cost note:** UI-TARS runs on a GPU instance (`ml.g6e.xlarge`, ~US$1.86/hour) and **bills continuously while it is running**. When you are done testing for the day, turn it off:
> ```bash
> node agent/sagemaker/teardownUitars.mjs PASTE_ENDPOINT_NAME
> ```
> The model and image stay saved, so bringing it back later only takes a few minutes (re-run step 2 above with the skip flags, then re-deploy the execution stack).

## Step 7 — Build the web console with those values

The web app needs the four values baked in at build time. Create the file `web/.env.production` (from the repo root):

```bash
cd ../web
npm install
cat > .env.production <<'EOF'
VITE_COGNITO_REGION=us-east-2
VITE_COGNITO_USER_POOL_ID=PASTE_UserPoolId
VITE_COGNITO_CLIENT_ID=PASTE_UserPoolClientId
VITE_API_URL=PASTE_ApiUrl
VITE_WS_URL=PASTE_WsUrl
EOF
```

Edit the file and replace each `PASTE_...` with the matching Output from Step 5. Then build:

```bash
npm run build
```

## Step 8 — Deploy the web console

```bash
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Frontend --require-approval never
```

Print your app URL (a `https://xxxx.cloudfront.net` address) and open it — you should see the login page:

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Frontend \
  --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text
```

## Step 9 — Create your first (admin) login

Sign-up is disabled on purpose, so you create users yourself. Pick an email and a password (min 8 chars, upper + lower + number). The `tenantId` isolates each customer's data — use anything short, e.g. the company name. Make the first user an **admin** so you can manage the rest from the in-app **Members** page.

Pick whichever option you like:

**Option A — one-command script (recommended).** Creates the user, sets a permanent password, and (with `--admin`) adds them to the `admins` group. It resolves the User Pool automatically.

```bash
cd agent/sagemaker && npm install
AWS_REGION=us-east-2 node createUser.mjs \
  --email you@example.com --tenant acme --password 'ChangeMe123!' --admin
```

**Option B — create the admin at deploy time.** Pass `-c` context when deploying the Foundation stack (or any deploy) and CDK creates the admin and adds it to the `admins` group automatically:

```bash
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Foundation --require-approval never \
  -c adminEmail=you@example.com -c adminPassword='ChangeMe123!' -c adminTenant=acme
```

Once you have one admin, create everyone else from the **Members** page in the app (see Step 10) — no CLI needed. Non-admins never see that page.

<details>
<summary>Option C — raw AWS CLI (no script)</summary>

```bash
POOL_ID=PASTE_UserPoolId    # from Step 5
aws cognito-idp admin-create-user --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --password 'ChangeMe123!' --permanent
# make them an admin (so the Members page is available)
aws cognito-idp admin-add-user-to-group --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --group-name admins
```
</details>

## Step 10 — Log in

Open the CloudFront URL from Step 8, log in with the email/password from Step 9. **The first page you land on is the Guide** — an in-app walkthrough of every feature, in your language. From there:

1. **Apps** — create an app; upload an APK/IPA/ZIP for native, or just a URL for Web.
2. **Test cases** — describe a flow in plain language; the AI turns it into a runnable case.
3. **Tasks** — pick app + case + runtime (**Web** or **Device Farm**) and submit; the coordinate model defaults to **UI-TARS 1.5 7B** (from Step 6). Watch it run live.
4. **Reports** — read the AI narrative, screenshots, step trace, and cost.
5. **Members** (admins only) — the last nav item. Add users (email + tenant + initial password), disable/enable accounts, and optionally grant admin. No CLI needed after your first admin.

> **If you don't see the Members item:** the nav only shows it to admins, and your login token carries group membership only from the moment you signed in. After making an account an admin (Step 9), **log out and log back in** so the new token includes the `admins` group.

✅ **You now have a working environment.**

More on how UI-TARS grounding works: [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md).

## Enable the Cost Analysis page

The **Cost Analysis** page (next to Knowledge) shows two things side by side:

- **Real AWS cost** — pulled live from **AWS Cost Explorer**: your actual bill, broken down by service, by the `component` tag, and by month. This includes everything (SageMaker GPU, Fargate, EC2, CloudFront, etc.).
- **Task estimated cost** — a token × price estimate summed from your tasks, grouped by app and model. It excludes infrastructure, so it is lower than the real bill; the two use different bases and should not be subtracted from each other.

The estimated side works immediately. The real side needs a **one-time account setup** (Cost Explorer is account-level and cannot be enabled by CDK):

1. **Enable Cost Explorer.** In the AWS console go to **Billing and Cost Management → Cost Explorer** and enable it. Data starts appearing roughly **24 hours** after first enabling.
2. **Activate the cost allocation tags.** In **Billing and Cost Management → Cost allocation tags → User-defined cost allocation tags**, select `project`, `stage`, `component` (and any `costCenter` / `owner` / `team` you passed at deploy time) and click **Activate**.
3. **Wait a day.** Tags only apply to cost incurred **after** activation — past cost is never backfilled, and grouping by `component` shows everything under "untagged" until then. Come back the next day.

Notes:

- Cost Explorer's API is only in `us-east-1`; the app already queries there regardless of your deploy region.
- Each query costs about **US$0.01** (charged by AWS), and data is typically ~24h delayed (not real-time).
- Only the account owner / an IAM user with billing access can activate cost allocation tags.

## Device Farm (real phones) note

The Web backend works with no extra setup. Real-device testing uses **AWS Device Farm**, whose projects live in **us-west-2** and are created automatically by the runner. The deploy credentials already include Device Farm permissions; no manual setup is needed — just pick "Device Farm" when submitting a task.

**Pick a device model:** when you choose the Device Farm backend, a device dropdown appears listing the real phones available right now (model + Android version), each with its characteristics (resolution, memory, CPU). Leave it on "Auto" to take the first available device, or pick an exact model — the run will use that specific phone. The device that actually ran a task is shown on the task detail page ("執行裝置 / Ran on device").

**No runaway runs:** if a screen stops changing — a huge APK stuck installing, a frozen app, or a login/reCAPTCHA wall — the runner waits patiently first (installs can take minutes), and if the screen is still completely unchanged past a hard limit it ends the run as `error` instead of spinning. This matters on metered real devices, where an infinite loop would keep billing.

---

## Costs, cleanup, and troubleshooting

**Rough running cost (evaluation):** the serverless control plane is a few dollars/month at low use; test runs cost per-token (cents to a couple of dollars each, shown in every report). The biggest cost is the **UI-TARS GPU endpoint** (`ml.g6e.xlarge`, ~US$1.86/hour) — it bills continuously while running, so **tear it down when you're not testing** (`node agent/sagemaker/teardownUitars.mjs <endpoint-name>`) and re-create it in a few minutes when you need it again.

**Tear everything down** (deletes the stacks; the data bucket and Cognito user pool are retained by design so you don't lose data — delete them by hand in the console if you truly want them gone):

```bash
cd infra
AWS_REGION=us-east-2 npx cdk destroy --all
# If you enabled UI-TARS, delete its endpoint first:
node ../agent/sagemaker/teardownUitars.mjs <endpoint-name>
```

**Common issues**

| Symptom | Fix |
| --- | --- |
| Deploy fails: *"not bootstrapped"* | Run Step 4 (`cdk bootstrap`) for `us-east-2`. |
| Test runs error mentioning a model / *AccessDenied* on Bedrock | Enable model access (Step 3), in **us-east-2**. |
| Login page loads but sign-in fails | `web/.env.production` values are wrong or the web wasn't rebuilt+redeployed after editing them (Steps 6–7). |
| Can't sign up | By design — create users with the CLI (Step 8). |
| Wrong region / can't see resources | Everything is in **us-east-2**; check the Console region selector (top-right). |

---

## Repository layout

```
agent/            Execution runners (run inside Fargate containers)
  explorationRunner.mjs    Device Farm real-device runner (Appium loop)
  webExplorationRunner.mjs Web runner (Playwright headless Chromium)
  imageTools.mjs           smart-resize + annotation for VLM coordinates
  uitarsClient.mjs         UI-TARS (SageMaker) grounding client
  apkMerge.mjs             XAPK / split-APK merge for Device Farm
  sagemaker/               UI-TARS deploy: vLLM BYOC container + CodeBuild scripts
infra/            AWS CDK app (foundation, control-plane, scheduling, execution, frontend)
web/              React + Vite web console (5-locale i18n, self-drawn SVG)
docs/             Architecture, design notes, and research
```

## For developers

```bash
cd infra && npm test     # CDK + unit tests
cd web   && npm run ci    # check:i18n + type-check + tests + build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).

## License

See repository settings. Provided as-is for internal evaluation.
