# Contributing

Thanks for your interest in PlayAgent Checker. This guide covers the essentials for working in the repo.

## Project layout

- `agent/` — execution runners that run inside Fargate containers (Device Farm + Web) and the SageMaker/UI-TARS deploy scripts.
- `infra/` — AWS CDK app (stacks + Lambda source + tests).
- `web/` — React + Vite web console.
- `docs/` — architecture, design notes, research.

## Local checks (run before opening a PR)

```bash
# Infra: CDK synth + unit tests
cd infra && npm install && npm test

# Web: i18n completeness + type-check + tests + build
cd ../web && npm install && npm run ci
```

Both must pass. The web `ci` script includes `check:i18n`, which enforces that the primary locales (zh-Hant, en) have every message key — do not merge with missing keys.

## Conventions

- **Internationalization:** all user-facing strings go through the i18n catalog (`web/src/i18n/messages.ts`). The app supports 5 locales: zh-Hant, en, zh-Hans, ja, ko. zh-Hant is the authoritative key set; en must be complete.
- **Icons/graphics:** use self-drawn inline SVG; do not add binary image assets for icons.
- **Secrets:** never commit credentials. Test cases must use `${ENV}` placeholders / secret references, not literal passwords.
- **Honesty in docs & UI:** architecture diagrams and the in-app Guide must reflect what is actually verified end-to-end. Mark scaffolded-but-unverified pieces as such.
- **Cost-sensitive resources:** anything that bills continuously (e.g. the SageMaker UI-TARS endpoint) must have a teardown path and be documented.

## Commit & PR

- Keep changes focused; describe what changed, what you tested, and any follow-ups.
- Push to a feature branch and open a PR against `main` (do not push directly to `main`).
- Do not modify git hooks or config as part of a feature PR.

## Deploying

For a complete verified deployment of your current folder (git checkout or extracted ZIP), use the platform launcher for your operating system:

```text
Windows: double-click Install-Latest.cmd
macOS:   double-click Install-Latest.command
Linux:   run scripts/deploy-latest.sh
```

All three launchers use the shared deployment core and default to **`us-west-2` (Oregon)** (change it with `--region`). For a browser-only install, see the AWS CloudShell one-liner in the README.

It deploys the current folder as-is (it never fetches a newer version), tags it with the Git commit SHA (or `local-<UTC time>` for a ZIP without `.git`), builds and pushes both runner images, pins ECS task definitions to that tag, builds the frontend from stack outputs, and verifies CloudFormation/ECR/ECS/CloudFront. Uncommitted changes are included, with a warning and a `<sha12>-dirty-<UTC time>` tag. Use `npm run deploy:latest -- --expected-account-id 123456789012` for account safety. Windows, macOS and Linux share `scripts/deploy-latest.mjs`; the `.cmd`, `.command`, `.sh`, and `.ps1` files are launchers only.

### Deployment secret safety

- Never pass a password in argv, including deploy, CDK, AWS CLI, or helper-script command-line options.
- Never put a password in CDK context, generated CloudFormation templates, or logs.
- Interactive tools must use hidden password input. Automation must read the password from stdin, for example by piping a secret manager to `npm run deploy:latest -- --non-interactive --admin-email admin@example.com --admin-password-stdin`.
- Use `us-west-2` by default unless a documented service-specific exception requires another region.

For targeted development deployments, deploy only the affected stack explicitly from `infra/`. Do **not** use `cdk deploy --all` as a substitute for the installer: that neither guarantees runner images were rebuilt nor that `web/dist` matches the deployed API.

The manual cloud-image workflow remains available through `agent/sagemaker/cloudBuildRunner.mjs` and `cloudBuildWebRunner.mjs`; see README Step 6.
