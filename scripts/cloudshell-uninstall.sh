#!/usr/bin/env bash
# PlayAgent Checker uninstaller for AWS CloudShell. Removes the environment this project created,
# and nothing else. The matching installer is scripts/cloudshell-install.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/hoycdanny/playagent-checker/main/scripts/cloudshell-uninstall.sh | bash -s -- --region us-west-2
#
# What it removes (only PlayAgent's own resources):
#   - the 6 CloudFormation stacks PlayAgentDev-{Updater,Frontend,ControlPlane,Scheduling,Execution,Foundation}
#   - the retained data bucket, Cognito user pool and runner ECR repos (read from the stacks before deletion,
#     so only those exact resources are touched)
#   - the installer CodeBuild project and IAM role, PlayAgent SSM parameters and CloudWatch log groups
# What it KEEPS (shared with the account / other apps):
#   - the CDK bootstrap (CDKToolkit) and the cdk-hnb659fds-* assets bucket / ECR
#
# Messages default to English; pick another with --lang (en, zh-Hant, zh-Hans, ja, ko) or PLAYAGENT_LANG.
# Options: --region REGION (default us-west-2; also PLAYAGENT_REGION), --lang CODE, --yes (skip the typed confirmation).
set -euo pipefail

PREFIX="PlayAgentDev"
NAME="playagent-installer"
REGION="${PLAYAGENT_REGION:-us-west-2}"
LANG_CODE="${PLAYAGENT_LANG:-en}"
LANG_SET=0
[[ -n "${PLAYAGENT_LANG:-}" ]] && LANG_SET=1
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="${2:-}"; shift 2 ;;
    --region=*) REGION="${1#*=}"; shift ;;
    --lang) LANG_CODE="${2:-}"; LANG_SET=1; shift 2 ;;
    --lang=*) LANG_CODE="${1#*=}"; LANG_SET=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) echo "usage: cloudshell-uninstall.sh [--region us-west-2] [--lang en|zh-Hant|zh-Hans|ja|ko] [--yes]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# 第一次使用的人不會知道 --lang;沒指定語言又有終端機時,先跳一個選單讓他選(預設英文)。
choose_language() {
  (( LANG_SET )) && return 0
  [[ -r /dev/tty ]] || return 0
  {
    printf '\n'
    printf 'Select language / 選擇語言 / 言語を選択 / 언어 선택:\n'
    printf '  1) English\n  2) 繁體中文\n  3) 简体中文\n  4) 日本語\n  5) 한국어\n'
    printf 'Choice [1]: '
  } >/dev/tty
  local choice=''
  read -r -t 120 choice </dev/tty || choice=1
  case "$choice" in
    2) LANG_CODE=zh-Hant ;;
    3) LANG_CODE=zh-Hans ;;
    4) LANG_CODE=ja ;;
    5) LANG_CODE=ko ;;
    *) LANG_CODE=en ;;
  esac
}
choose_language

case "$LANG_CODE" in
  en|english|EN) LANG_CODE=en ;;
  zh-Hant|zh-hant|zh-TW|zh_TW|zh-tw|hant|TW) LANG_CODE=zh-Hant ;;
  zh-Hans|zh-hans|zh-CN|zh_CN|zh-cn|zh|hans|CN) LANG_CODE=zh-Hans ;;
  ja|jp|JP|japanese) LANG_CODE=ja ;;
  ko|kr|KR|korean) LANG_CODE=ko ;;
  *) LANG_CODE=en ;;
esac

declare -A T
T[en.bad_region]="Invalid region: %s"
T[zh-Hant.bad_region]="區域格式錯誤: %s"
T[zh-Hans.bad_region]="区域格式错误: %s"
T[ja.bad_region]="リージョンが不正です: %s"
T[ko.bad_region]="잘못된 리전: %s"
T[en.need_aws]="aws is required (built into AWS CloudShell)"
T[zh-Hant.need_aws]="需要 aws(AWS CloudShell 已內建)"
T[zh-Hans.need_aws]="需要 aws(AWS CloudShell 已内置)"
T[ja.need_aws]="aws が必要です(AWS CloudShell に標準装備)"
T[ko.need_aws]="aws 가 필요합니다(AWS CloudShell 기본 제공)"
T[en.no_account]="Could not resolve the AWS account"
T[zh-Hant.no_account]="無法取得 AWS 帳號"
T[zh-Hans.no_account]="无法获取 AWS 账号"
T[ja.no_account]="AWS アカウントを取得できません"
T[ko.no_account]="AWS 계정을 확인할 수 없습니다"
T[en.scan]="==> Scanning PlayAgent resources in account %s / region %s…"
T[zh-Hant.scan]="==> 掃描帳號 %s / 區域 %s 的 PlayAgent 資源…"
T[zh-Hans.scan]="==> 扫描账号 %s / 区域 %s 的 PlayAgent 资源…"
T[ja.scan]="==> アカウント %s / リージョン %s の PlayAgent リソースを調査中…"
T[ko.scan]="==> 계정 %s / 리전 %s 의 PlayAgent 리소스 확인 중…"
T[en.nothing]="==> Nothing to remove: no PlayAgent stacks or retained resources found in this region."
T[zh-Hant.nothing]="==> 沒有東西可刪:這個區域找不到 PlayAgent 的 stack 或殘留資源。"
T[zh-Hans.nothing]="==> 没有东西可删:这个区域找不到 PlayAgent 的 stack 或残留资源。"
T[ja.nothing]="==> 削除対象なし:このリージョンに PlayAgent のスタックや残存リソースはありません。"
T[ko.nothing]="==> 삭제할 것이 없습니다: 이 리전에 PlayAgent 스택이나 잔존 리소스가 없습니다."
T[en.will]="==> This will DELETE the PlayAgent Checker environment in account %s / region %s:"
T[zh-Hant.will]="==> 這會刪除帳號 %s / 區域 %s 的 PlayAgent Checker 環境:"
T[zh-Hans.will]="==> 这会删除账号 %s / 区域 %s 的 PlayAgent Checker 环境:"
T[ja.will]="==> アカウント %s / リージョン %s の PlayAgent Checker 環境を削除します:"
T[ko.will]="==> 계정 %s / 리전 %s 의 PlayAgent Checker 환경을 삭제합니다:"
T[en.will_stacks]="    - CloudFormation stacks: %s"
T[zh-Hant.will_stacks]="    - CloudFormation stacks: %s"
T[zh-Hans.will_stacks]="    - CloudFormation stacks: %s"
T[ja.will_stacks]="    - CloudFormation スタック: %s"
T[ko.will_stacks]="    - CloudFormation 스택: %s"
T[en.will_retained]="    - the retained data bucket / Cognito user pool / runner ECR repos (if present)"
T[zh-Hant.will_retained]="    - 保留性質的資料桶 / Cognito 使用者池 / runner ECR(若存在)"
T[zh-Hans.will_retained]="    - 保留性质的数据桶 / Cognito 用户池 / runner ECR(若存在)"
T[ja.will_retained]="    - 保持されたデータバケット / Cognito ユーザープール / ランナー ECR(存在する場合)"
T[ko.will_retained]="    - 보존된 데이터 버킷 / Cognito 사용자 풀 / 러너 ECR(있는 경우)"
T[en.will_installer]="    - the installer CodeBuild project and IAM role, PlayAgent SSM parameters and log groups"
T[zh-Hant.will_installer]="    - 安裝器的 CodeBuild 專案與 IAM 角色、PlayAgent 的 SSM 參數與 log group"
T[zh-Hans.will_installer]="    - 安装器的 CodeBuild 项目与 IAM 角色、PlayAgent 的 SSM 参数与 log group"
T[ja.will_installer]="    - インストーラの CodeBuild プロジェクトと IAM ロール、PlayAgent の SSM パラメータとロググループ"
T[ko.will_installer]="    - 설치기의 CodeBuild 프로젝트와 IAM 역할, PlayAgent 의 SSM 파라미터와 로그 그룹"
T[en.keep]="    Kept: the CDK bootstrap (CDKToolkit) and shared cdk-hnb659fds-* assets."
T[zh-Hant.keep]="    保留:CDK bootstrap(CDKToolkit)與共用的 cdk-hnb659fds-* 資產。"
T[zh-Hans.keep]="    保留:CDK bootstrap(CDKToolkit)与共用的 cdk-hnb659fds-* 资产。"
T[ja.keep]="    保持:CDK bootstrap(CDKToolkit)と共有の cdk-hnb659fds-* アセット。"
T[ko.keep]="    유지: CDK bootstrap(CDKToolkit)과 공유 cdk-hnb659fds-* 자산."
T[en.confirm]="Type the account id (%s) to confirm, or anything else to abort: "
T[zh-Hant.confirm]="輸入帳號 id(%s)以確認刪除,輸入其他則取消: "
T[zh-Hans.confirm]="输入账号 id(%s)以确认删除,输入其他则取消: "
T[ja.confirm]="削除するにはアカウント id(%s)を入力、それ以外で中止: "
T[ko.confirm]="삭제하려면 계정 id(%s)를 입력, 그 외는 취소: "
T[en.need_tty]="No terminal for confirmation. Re-run with --yes to confirm deletion non-interactively."
T[zh-Hant.need_tty]="沒有終端機可確認。請加 --yes 以非互動方式確認刪除。"
T[zh-Hans.need_tty]="没有终端可确认。请加 --yes 以非交互方式确认删除。"
T[ja.need_tty]="確認用の端末がありません。--yes を付けて非対話で削除を確認してください。"
T[ko.need_tty]="확인용 터미널이 없습니다. --yes 를 붙여 비대화식으로 삭제를 확인하세요."
T[en.abort]="Aborted. Nothing was deleted."
T[zh-Hant.abort]="已取消,沒有刪除任何東西。"
T[zh-Hans.abort]="已取消,没有删除任何东西。"
T[ja.abort]="中止しました。何も削除していません。"
T[ko.abort]="취소했습니다. 아무것도 삭제하지 않았습니다."
T[en.del_stack]="==> Deleting stack %s"
T[zh-Hant.del_stack]="==> 刪除 stack %s"
T[zh-Hans.del_stack]="==> 删除 stack %s"
T[ja.del_stack]="==> スタック %s を削除"
T[ko.del_stack]="==> 스택 %s 삭제"
T[en.wait_stack]="    waiting for %s…"
T[zh-Hant.wait_stack]="    等待 %s…"
T[zh-Hans.wait_stack]="    等待 %s…"
T[ja.wait_stack]="    %s を待機中…"
T[ko.wait_stack]="    %s 대기 중…"
T[en.stack_done]="    deleted %s"
T[zh-Hant.stack_done]="    已刪除 %s"
T[zh-Hans.stack_done]="    已删除 %s"
T[ja.stack_done]="    削除完了 %s"
T[ko.stack_done]="    삭제됨 %s"
T[en.stack_state]="    %s ended with status %s (check the CloudFormation console)"
T[zh-Hant.stack_state]="    %s 停在狀態 %s(請到 CloudFormation 主控台查看)"
T[zh-Hans.stack_state]="    %s 停在状态 %s(请到 CloudFormation 控制台查看)"
T[ja.stack_state]="    %s は状態 %s で終了(CloudFormation コンソールを確認)"
T[ko.stack_state]="    %s 가 상태 %s 로 종료(CloudFormation 콘솔 확인)"
T[en.empty]="==> Emptying bucket %s"
T[zh-Hant.empty]="==> 清空桶 %s"
T[zh-Hans.empty]="==> 清空桶 %s"
T[ja.empty]="==> バケット %s を空に"
T[ko.empty]="==> 버킷 %s 비우기"
T[en.del_bucket]="==> Deleting bucket %s"
T[zh-Hant.del_bucket]="==> 刪除桶 %s"
T[zh-Hans.del_bucket]="==> 删除桶 %s"
T[ja.del_bucket]="==> バケット %s を削除"
T[ko.del_bucket]="==> 버킷 %s 삭제"
T[en.del_pool]="==> Deleting Cognito user pool %s"
T[zh-Hant.del_pool]="==> 刪除 Cognito 使用者池 %s"
T[zh-Hans.del_pool]="==> 删除 Cognito 用户池 %s"
T[ja.del_pool]="==> Cognito ユーザープール %s を削除"
T[ko.del_pool]="==> Cognito 사용자 풀 %s 삭제"
T[en.del_ecr]="==> Deleting ECR repo %s"
T[zh-Hant.del_ecr]="==> 刪除 ECR repo %s"
T[zh-Hans.del_ecr]="==> 删除 ECR repo %s"
T[ja.del_ecr]="==> ECR リポジトリ %s を削除"
T[ko.del_ecr]="==> ECR 리포지토리 %s 삭제"
T[en.del_proj]="==> Deleting CodeBuild project %s"
T[zh-Hant.del_proj]="==> 刪除 CodeBuild 專案 %s"
T[zh-Hans.del_proj]="==> 删除 CodeBuild 项目 %s"
T[ja.del_proj]="==> CodeBuild プロジェクト %s を削除"
T[ko.del_proj]="==> CodeBuild 프로젝트 %s 삭제"
T[en.del_role]="==> Deleting IAM role %s"
T[zh-Hant.del_role]="==> 刪除 IAM 角色 %s"
T[zh-Hans.del_role]="==> 删除 IAM 角色 %s"
T[ja.del_role]="==> IAM ロール %s を削除"
T[ko.del_role]="==> IAM 역할 %s 삭제"
T[en.del_ssm]="==> Deleting SSM parameter %s"
T[zh-Hant.del_ssm]="==> 刪除 SSM 參數 %s"
T[zh-Hans.del_ssm]="==> 删除 SSM 参数 %s"
T[ja.del_ssm]="==> SSM パラメータ %s を削除"
T[ko.del_ssm]="==> SSM 파라미터 %s 삭제"
T[en.del_log]="==> Deleting log group %s"
T[zh-Hant.del_log]="==> 刪除 log group %s"
T[zh-Hans.del_log]="==> 删除 log group %s"
T[ja.del_log]="==> ロググループ %s を削除"
T[ko.del_log]="==> 로그 그룹 %s 삭제"
T[en.done]="==> Done. PlayAgent Checker removed from %s. The CDK bootstrap was kept, so a reinstall skips bootstrap."
T[zh-Hant.done]="==> 完成。已從 %s 移除 PlayAgent Checker。CDK bootstrap 保留著,重裝會跳過 bootstrap。"
T[zh-Hans.done]="==> 完成。已从 %s 移除 PlayAgent Checker。CDK bootstrap 保留着,重装会跳过 bootstrap。"
T[ja.done]="==> 完了。%s から PlayAgent Checker を削除しました。CDK bootstrap は保持したので再インストールは bootstrap を省略します。"
T[ko.done]="==> 완료. %s 에서 PlayAgent Checker 를 제거했습니다. CDK bootstrap 는 유지되어 재설치 시 bootstrap 를 건너뜁니다."

t(){ local k="${LANG_CODE}.$1"; printf '%s' "${T[$k]:-${T[en.$1]:-$1}}"; }
say(){ printf '%s\n' "$(t "$1")"; }
sayf(){ local f; f="$(t "$1")"; shift; printf "$f\n" "$@"; }

[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { sayf bad_region "$REGION" >&2; exit 1; }
command -v aws >/dev/null || { say need_aws >&2; exit 1; }

export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || { say no_account >&2; exit 1; }
sayf scan "$ACCOUNT" "$REGION"

STACKS=(Updater Frontend ControlPlane Scheduling Execution Foundation)

# Capture retained resources from the stacks BEFORE deleting them, so we only touch exactly
# the resources these stacks own (no name guessing against other apps).
stack_exists(){ aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1; }
res_ids(){ aws cloudformation list-stack-resources --stack-name "$1" \
  --query "StackResourceSummaries[?ResourceType=='$2'].PhysicalResourceId" --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'; }

PRESENT=()
for s in "${STACKS[@]}"; do stack_exists "$PREFIX-$s" && PRESENT+=("$PREFIX-$s"); done

DATA_BUCKETS=(); POOL_IDS=(); ECR_REPOS=()
if stack_exists "$PREFIX-Foundation"; then
  while IFS= read -r b; do [[ -n "$b" ]] && DATA_BUCKETS+=("$b"); done < <(res_ids "$PREFIX-Foundation" 'AWS::S3::Bucket')
  while IFS= read -r p; do [[ -n "$p" ]] && POOL_IDS+=("$p"); done < <(res_ids "$PREFIX-Foundation" 'AWS::Cognito::UserPool')
fi
if stack_exists "$PREFIX-Execution"; then
  while IFS= read -r r; do [[ -n "$r" ]] && ECR_REPOS+=("$r"); done < <(res_ids "$PREFIX-Execution" 'AWS::ECR::Repository')
fi
# Installer-created (non-CDK) pieces.
INSTALLER_PROJECT=""; aws codebuild batch-get-projects --names "$NAME" --query 'projects[0].name' --output text 2>/dev/null | grep -qx "$NAME" && INSTALLER_PROJECT="$NAME"
INSTALLER_ROLE=""; aws iam get-role --role-name "$NAME" >/dev/null 2>&1 && INSTALLER_ROLE="$NAME"

if (( ${#PRESENT[@]} == 0 )) && (( ${#DATA_BUCKETS[@]} == 0 )) && (( ${#POOL_IDS[@]} == 0 )) && (( ${#ECR_REPOS[@]} == 0 )) && [[ -z "$INSTALLER_PROJECT" && -z "$INSTALLER_ROLE" ]]; then
  say nothing
  exit 0
fi

# Plan + confirmation.
sayf will "$ACCOUNT" "$REGION"
(( ${#PRESENT[@]} )) && sayf will_stacks "$(printf '%s ' "${PRESENT[@]}")"
say will_retained
say will_installer
say keep
if (( ! ASSUME_YES )); then
  if [[ ! -r /dev/tty ]]; then say need_tty >&2; exit 1; fi
  read -r -p "$(printf "$(t confirm)" "$ACCOUNT")" REPLY </dev/tty
  [[ "$REPLY" == "$ACCOUNT" ]] || { say abort; exit 1; }
fi

# 1. Delete the app stacks in dependency-safe order (consumers before producers).
for s in "${STACKS[@]}"; do
  name="$PREFIX-$s"
  stack_exists "$name" || continue
  sayf del_stack "$name"
  aws cloudformation delete-stack --stack-name "$name"
  sayf wait_stack "$name"
  if aws cloudformation wait stack-delete-complete --stack-name "$name" 2>/dev/null; then
    sayf stack_done "$name"
  else
    st="$(aws cloudformation describe-stacks --stack-name "$name" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo GONE)"
    [[ "$st" == GONE ]] && sayf stack_done "$name" || sayf stack_state "$name" "$st"
  fi
done

# 2. Retained resources (survive stack deletion) — only the exact ids captured above.
empty_bucket(){
  local b="$1" vers
  for _ in $(seq 1 200); do
    vers="$(aws s3api list-object-versions --bucket "$b" --max-items 500 \
      --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][]}' \
      --output json 2>/dev/null || true)"
    grep -q '"Key"' <<<"${vers:-}" || break
    aws s3api delete-objects --bucket "$b" --delete "$vers" >/dev/null 2>&1 || break
  done
}
for b in "${DATA_BUCKETS[@]}"; do
  aws s3api head-bucket --bucket "$b" >/dev/null 2>&1 || continue
  sayf empty "$b"; empty_bucket "$b"
  sayf del_bucket "$b"; aws s3api delete-bucket --bucket "$b" >/dev/null 2>&1 || true
done
for p in "${POOL_IDS[@]}"; do
  sayf del_pool "$p"; aws cognito-idp delete-user-pool --user-pool-id "$p" >/dev/null 2>&1 || true
done
for r in "${ECR_REPOS[@]}"; do
  sayf del_ecr "$r"; aws ecr delete-repository --repository-name "$r" --force >/dev/null 2>&1 || true
done

# 3. Installer-created pieces (CodeBuild project + IAM role).
if [[ -n "$INSTALLER_PROJECT" ]]; then sayf del_proj "$NAME"; aws codebuild delete-project --name "$NAME" >/dev/null 2>&1 || true; fi
if [[ -n "$INSTALLER_ROLE" ]]; then
  sayf del_role "$NAME"
  for pol in $(aws iam list-role-policies --role-name "$NAME" --query 'PolicyNames' --output text 2>/dev/null || true); do
    aws iam delete-role-policy --role-name "$NAME" --policy-name "$pol" >/dev/null 2>&1 || true
  done
  for arn in $(aws iam list-attached-role-policies --role-name "$NAME" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true); do
    aws iam detach-role-policy --role-name "$NAME" --policy-arn "$arn" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "$NAME" >/dev/null 2>&1 || true
fi

# 4. PlayAgent SSM parameter (keep /cdk-bootstrap).
if aws ssm get-parameter --name "/playagent/$PREFIX/deployed-version" >/dev/null 2>&1; then
  sayf del_ssm "/playagent/$PREFIX/deployed-version"
  aws ssm delete-parameter --name "/playagent/$PREFIX/deployed-version" >/dev/null 2>&1 || true
fi

# 5. PlayAgent CloudWatch log groups.
for pre in "/playagent/$PREFIX" "/aws/lambda/$PREFIX" "/aws/codebuild/$NAME"; do
  for lg in $(aws logs describe-log-groups --log-group-name-prefix "$pre" --query 'logGroups[].logGroupName' --output text 2>/dev/null || true); do
    sayf del_log "$lg"; aws logs delete-log-group --log-group-name "$lg" >/dev/null 2>&1 || true
  done
done

sayf done "$REGION"
