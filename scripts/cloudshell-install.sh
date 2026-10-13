#!/usr/bin/env bash
# PlayAgent Checker one-line installer for AWS CloudShell (no repo download, no deploy EC2).
#
#   curl -fsSL https://raw.githubusercontent.com/hoycdanny/playagent-checker/main/scripts/cloudshell-install.sh | bash -s -- --admin-email you@example.com
#
# Run it again any time to update to the latest main. What it does:
#   1. CDK-bootstraps the account/region if CDKToolkit is missing (the only step that needs admin);
#   2. creates/updates the IAM role playagent-installer (trusted by CodeBuild only) with the
#      least-privilege policy infra/iam/playagent-deployer-policy.json (no AdministratorAccess);
#   3. creates/updates the CodeBuild project playagent-installer, which clones the public GitHub
#      repo and runs scripts/deploy-latest.mjs inside AWS;
#   4. starts the build, streams its log here and prints the website URL.
# The admin account is created with a Cognito invite: a temporary password is emailed to the
# admin, who sets a new password on first sign-in. No password passes through this script.
#
# Options: --admin-email EMAIL (required, prompted if missing),
#          --region REGION (default us-west-2; also PLAYAGENT_REGION. AWS_REGION is ignored on purpose,
#                           because CloudShell sets it to whatever region the console is showing),
#          --branch NAME (main), --no-wait (start the build and exit).
# Example, another region:  ... | bash -s -- --admin-email you@example.com --region ap-northeast-1
set -euo pipefail

REPO_URL="https://github.com/hoycdanny/playagent-checker.git"
RAW_BASE="https://raw.githubusercontent.com/hoycdanny/playagent-checker"
NAME="playagent-installer"
NODE_VERSION="v22.12.0"
# 預設 us-west-2;要裝到別的區域用 --region(或 PLAYAGENT_REGION)。
# 刻意不讀 AWS_REGION:CloudShell 會自動設成主控台目前的區域,容易裝錯地方。
REGION="${PLAYAGENT_REGION:-us-west-2}"
BRANCH="main"
EMAIL=""
WAIT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-email) EMAIL="${2:-}"; shift 2 ;;
    --admin-email=*) EMAIL="${1#*=}"; shift ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --region=*) REGION="${1#*=}"; shift ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --no-wait) WAIT=0; shift ;;
    -h|--help) echo "usage: cloudshell-install.sh --admin-email EMAIL [--region us-west-2] [--branch main] [--no-wait]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$EMAIL" && -r /dev/tty ]]; then
  read -r -p "管理員 Email / Admin email: " EMAIL </dev/tty
fi
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { echo "請用 --admin-email 指定有效的 Email / a valid --admin-email is required" >&2; exit 1; }
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { echo "Invalid region: $REGION" >&2; exit 1; }
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { echo "Invalid branch: $BRANCH" >&2; exit 1; }
command -v aws >/dev/null && command -v node >/dev/null && command -v curl >/dev/null || { echo "需要 aws、node、curl(AWS CloudShell 已內建)" >&2; exit 1; }

export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || { echo "Could not resolve AWS account" >&2; exit 1; }
echo "==> 帳號 $ACCOUNT / 區域 $REGION / 分支 $BRANCH / 管理員 $EMAIL"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. CDK bootstrap (admin only, once per account/region)
STATUS="$(aws cloudformation describe-stacks --stack-name CDKToolkit --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)"
if [[ "$STATUS" == MISSING ]]; then
  echo "==> 第一次在這個區域安裝:執行 cdk bootstrap(約 2 分鐘)"
  (cd "$WORK" && npx -y aws-cdk@2 bootstrap "aws://$ACCOUNT/$REGION")
elif [[ ! "$STATUS" =~ ^(CREATE|UPDATE|UPDATE_ROLLBACK)_COMPLETE$ ]]; then
  echo "CDKToolkit 狀態是 $STATUS,請先到 CloudFormation 主控台處理" >&2; exit 1
else
  echo "==> CDKToolkit 已就緒 ($STATUS)"
fi

# 2. Least-privilege CodeBuild role (policy template from the same branch of the repo)
curl -fsSL "$RAW_BASE/$BRANCH/infra/iam/playagent-deployer-policy.json" -o "$WORK/policy.json"
sed -i -e "s/<ACCOUNT_ID>/$ACCOUNT/g" -e "s/<REGION>/$REGION/g" "$WORK/policy.json"
cat >"$WORK/logs.json" <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":["arn:aws:logs:$REGION:$ACCOUNT:log-group:/aws/codebuild/$NAME","arn:aws:logs:$REGION:$ACCOUNT:log-group:/aws/codebuild/$NAME:*"]}]}
JSON
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
NEW_ROLE=0
if ! aws iam get-role --role-name "$NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$NAME" --assume-role-policy-document "$TRUST" --description "PlayAgent Checker installer (CodeBuild, least privilege)" >/dev/null
  NEW_ROLE=1
  echo "==> 建立 IAM 角色 $NAME"
else
  aws iam update-assume-role-policy --role-name "$NAME" --policy-document "$TRUST"
fi
aws iam put-role-policy --role-name "$NAME" --policy-name PlayAgentDeployer --policy-document "file://$WORK/policy.json"
aws iam put-role-policy --role-name "$NAME" --policy-name CodeBuildLogs --policy-document "file://$WORK/logs.json"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$NAME"
LOG_GROUP="/aws/codebuild/$NAME"
aws logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30
if (( NEW_ROLE )); then echo "==> 等 IAM 角色生效"; sleep 15; fi

# 3. CodeBuild project: no source, inline buildspec clones the public repo
PA_NODE_VERSION="$NODE_VERSION" PA_REPO="$REPO_URL" PA_NAME="$NAME" PA_ROLE="$ROLE_ARN" PA_LOG_GROUP="$LOG_GROUP" \
PA_REGION="$REGION" PA_BRANCH="$BRANCH" PA_EMAIL="$EMAIL" node -e '
const e = process.env;
const buildspec = [
  "version: 0.2",
  "env:",
  "  shell: bash",
  "phases:",
  "  install:",
  "    commands:",
  "      - curl -fsSL \"https://nodejs.org/dist/$PA_NODE_VERSION/node-$PA_NODE_VERSION-linux-x64.tar.xz\" -o /tmp/node.tar.xz",
  "      - tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1",
  "      - node -v && npm -v && docker version --format \"docker {{.Server.Version}}\"",
  "  build:",
  "    commands:",
  "      - git clone --depth 1 --branch \"$PA_BRANCH\" \"$PA_REPO\" /tmp/src",
  "      - cd /tmp/src && node scripts/deploy-latest.mjs --non-interactive --repository-url \"$PA_REPO\" --branch \"$PA_BRANCH\" --region \"$PA_REGION\" --admin-email \"$PA_ADMIN_EMAIL\" --admin-invite",
].join("\n");
const env = (name, value) => ({ name, value, type: "PLAINTEXT" });
const project = {
  name: e.PA_NAME,
  description: "PlayAgent Checker installer: clones GitHub and deploys (started from CloudShell)",
  source: { type: "NO_SOURCE", buildspec },
  artifacts: { type: "NO_ARTIFACTS" },
  environment: {
    type: "LINUX_CONTAINER",
    image: "aws/codebuild/standard:7.0",
    computeType: "BUILD_GENERAL1_LARGE",
    privilegedMode: true,
    environmentVariables: [
      env("PA_NODE_VERSION", e.PA_NODE_VERSION), env("PA_REPO", e.PA_REPO), env("PA_REGION", e.PA_REGION),
      env("PA_BRANCH", e.PA_BRANCH), env("PA_ADMIN_EMAIL", e.PA_EMAIL),
    ],
  },
  serviceRole: e.PA_ROLE,
  timeoutInMinutes: 120,
  logsConfig: { cloudWatchLogs: { status: "ENABLED", groupName: e.PA_LOG_GROUP } },
};
require("fs").writeFileSync(process.argv[1], JSON.stringify(project));
' "$WORK/project.json"

upsert_project() {
  if aws codebuild batch-get-projects --names "$NAME" --query 'projects[0].name' --output text 2>/dev/null | grep -qx "$NAME"; then
    aws codebuild update-project --cli-input-json "file://$WORK/project.json" >/dev/null
  else
    aws codebuild create-project --cli-input-json "file://$WORK/project.json" >/dev/null
  fi
}
for i in 1 2 3 4 5 6; do
  if upsert_project 2>"$WORK/err"; then break; fi
  # A brand-new role can take a few seconds before CodeBuild is allowed to assume it.
  if (( i == 6 )) || ! grep -qiE 'not authorized to perform: ?sts:AssumeRole|InvalidInputException' "$WORK/err"; then cat "$WORK/err" >&2; exit 1; fi
  sleep 10
done
echo "==> CodeBuild 專案 $NAME 已就緒"

# 4. Start the build and follow it
BUILD_ID="$(aws codebuild start-build --project-name "$NAME" \
  --environment-variables-override "name=PA_ADMIN_EMAIL,value=$EMAIL,type=PLAINTEXT" "name=PA_REGION,value=$REGION,type=PLAINTEXT" "name=PA_BRANCH,value=$BRANCH,type=PLAINTEXT" \
  --query 'build.id' --output text)"
echo "==> 開始部署:$BUILD_ID"
echo "    主控台:https://$REGION.console.aws.amazon.com/codesuite/codebuild/projects/$NAME/history?region=$REGION"
if (( ! WAIT )); then exit 0; fi
echo "==> 下面是部署紀錄(約 30–60 分鐘;關掉 CloudShell 也會繼續在 AWS 上跑)"

aws logs tail "$LOG_GROUP" --follow --format short --since 1m --log-stream-name-prefix "${BUILD_ID#*:}" &
TAIL_PID=$!
trap 'kill "$TAIL_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT
STATE=IN_PROGRESS
while [[ "$STATE" == IN_PROGRESS ]]; do
  sleep 20
  STATE="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text 2>/dev/null || echo IN_PROGRESS)"
done
sleep 10
kill "$TAIL_PID" 2>/dev/null || true

echo
if [[ "$STATE" != SUCCEEDED ]]; then
  echo "部署失敗($STATE)。看上面的紀錄,或到 CodeBuild 主控台查看 $BUILD_ID;修好後重新執行同一行指令即可。" >&2
  exit 1
fi
SITE="$(aws cloudformation describe-stacks --stack-name PlayAgentDev-Frontend --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue | [0]" --output text 2>/dev/null || true)"
echo "========================================"
echo " PlayAgent Checker 部署完成"
echo " 網址 URL : $SITE"
echo " 管理員   : $EMAIL"
echo " 第一次登入:到信箱找臨時密碼,登入後會要求設定新密碼。"
echo " 之後要更新:再執行同一行指令即可。"
echo "========================================"
