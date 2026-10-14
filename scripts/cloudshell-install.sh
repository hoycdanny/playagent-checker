#!/usr/bin/env bash
# PlayAgent Checker one-line installer for AWS CloudShell (no repo download, no deploy EC2).
#
#   curl -fsSL https://raw.githubusercontent.com/hoycdanny/playagent-checker/main/scripts/cloudshell-install.sh | bash -s -- --admin-email you@example.com
#
# Messages default to English; pick another with --lang (en, zh-Hant, zh-Hans, ja, ko) or PLAYAGENT_LANG.
# To remove everything later, use the matching uninstaller: scripts/cloudshell-uninstall.sh.
#
# Run it again any time to update to the latest main. What it does:
#   0. Preflight: scan tools, that the policy template is reachable on the chosen branch, whether the
#      current identity has the permissions the install needs, whether an install is already running,
#      and Bedrock reachability. Any blocker stops BEFORE creating anything, so you never fail halfway.
#   1. CDK-bootstraps the account/region if CDKToolkit is missing (the only step that needs admin);
#   2. creates/updates the IAM role playagent-installer (trusted by CodeBuild only) with the
#      least-privilege policy infra/iam/playagent-deployer-policy.json (no AdministratorAccess);
#   3. creates/updates the CodeBuild project playagent-installer, which clones the public GitHub
#      repo and runs scripts/deploy-latest.mjs inside AWS;
#   4. starts the build, streams its log here and prints the website URL.
# The admin account is created with a Cognito invite: a temporary password is emailed to the
# admin, who sets a new password on first sign-in. No secret passes through this script.
#
# Options: --admin-email EMAIL (required, prompted if missing),
#          --region REGION (default us-west-2; also PLAYAGENT_REGION. AWS_REGION is ignored on purpose,
#                           because CloudShell sets it to whatever region the console is showing),
#          --lang CODE (en | zh-Hant | zh-Hans | ja | ko; default en; also PLAYAGENT_LANG),
#          --branch NAME (main), --no-wait (start the build and exit),
#          --skip-preflight (bypass the pre-install checks).
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
SKIP_PREFLIGHT=0
LANG_CODE="${PLAYAGENT_LANG:-en}"
LANG_SET=0
[[ -n "${PLAYAGENT_LANG:-}" ]] && LANG_SET=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-email) EMAIL="${2:-}"; shift 2 ;;
    --admin-email=*) EMAIL="${1#*=}"; shift ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --region=*) REGION="${1#*=}"; shift ;;
    --lang) LANG_CODE="${2:-}"; LANG_SET=1; shift 2 ;;
    --lang=*) LANG_CODE="${1#*=}"; LANG_SET=1; shift ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --no-wait) WAIT=0; shift ;;
    --skip-preflight) SKIP_PREFLIGHT=1; shift ;;
    -h|--help) echo "usage: cloudshell-install.sh --admin-email EMAIL [--region us-west-2] [--lang en|zh-Hant|zh-Hans|ja|ko] [--branch main] [--no-wait] [--skip-preflight]"; exit 0 ;;
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

# ── i18n: default English, selectable via menu / --lang / PLAYAGENT_LANG ───────
case "$LANG_CODE" in
  en|english|EN) LANG_CODE=en ;;
  zh-Hant|zh-hant|zh-TW|zh_TW|zh-tw|hant|TW) LANG_CODE=zh-Hant ;;
  zh-Hans|zh-hans|zh-CN|zh_CN|zh-cn|zh|hans|CN) LANG_CODE=zh-Hans ;;
  ja|jp|JP|japanese) LANG_CODE=ja ;;
  ko|kr|KR|korean) LANG_CODE=ko ;;
  *) LANG_CODE=en ;;
esac

declare -A T
T[en.ask_email]="Admin email: "
T[zh-Hant.ask_email]="管理員 Email: "
T[zh-Hans.ask_email]="管理员 Email: "
T[ja.ask_email]="管理者メール: "
T[ko.ask_email]="관리자 이메일: "
T[en.bad_email]="A valid --admin-email is required"
T[zh-Hant.bad_email]="請用 --admin-email 指定有效的 Email"
T[zh-Hans.bad_email]="请用 --admin-email 指定有效的 Email"
T[ja.bad_email]="有効な --admin-email を指定してください"
T[ko.bad_email]="유효한 --admin-email 이 필요합니다"
T[en.bad_region]="Invalid region: %s"
T[zh-Hant.bad_region]="區域格式錯誤: %s"
T[zh-Hans.bad_region]="区域格式错误: %s"
T[ja.bad_region]="リージョンが不正です: %s"
T[ko.bad_region]="잘못된 리전: %s"
T[en.bad_branch]="Invalid branch: %s"
T[zh-Hant.bad_branch]="分支名稱錯誤: %s"
T[zh-Hans.bad_branch]="分支名称错误: %s"
T[ja.bad_branch]="ブランチ名が不正です: %s"
T[ko.bad_branch]="잘못된 브랜치: %s"
T[en.need_tools]="aws, node and curl are required (built into AWS CloudShell)"
T[zh-Hant.need_tools]="需要 aws、node、curl(AWS CloudShell 已內建)"
T[zh-Hans.need_tools]="需要 aws、node、curl(AWS CloudShell 已内置)"
T[ja.need_tools]="aws、node、curl が必要です(AWS CloudShell に標準装備)"
T[ko.need_tools]="aws, node, curl 가 필요합니다(AWS CloudShell 기본 제공)"
T[en.no_account]="Could not resolve the AWS account"
T[zh-Hant.no_account]="無法取得 AWS 帳號"
T[zh-Hans.no_account]="无法获取 AWS 账号"
T[ja.no_account]="AWS アカウントを取得できません"
T[ko.no_account]="AWS 계정을 확인할 수 없습니다"
T[en.summary]="==> Account %s / region %s / branch %s / admin %s"
T[zh-Hant.summary]="==> 帳號 %s / 區域 %s / 分支 %s / 管理員 %s"
T[zh-Hans.summary]="==> 账号 %s / 区域 %s / 分支 %s / 管理员 %s"
T[ja.summary]="==> アカウント %s / リージョン %s / ブランチ %s / 管理者 %s"
T[ko.summary]="==> 계정 %s / 리전 %s / 브랜치 %s / 관리자 %s"
T[en.pf_run]="==> Preflight checks…"
T[zh-Hant.pf_run]="==> 安裝前檢查(preflight)…"
T[zh-Hans.pf_run]="==> 安装前检查(preflight)…"
T[ja.pf_run]="==> インストール前チェック(preflight)…"
T[ko.pf_run]="==> 설치 전 점검(preflight)…"
T[en.pf_miss_cmd]="Missing command: %s"
T[zh-Hant.pf_miss_cmd]="缺少指令: %s"
T[zh-Hans.pf_miss_cmd]="缺少命令: %s"
T[ja.pf_miss_cmd]="コマンドがありません: %s"
T[ko.pf_miss_cmd]="명령이 없습니다: %s"
T[en.pf_miss_npx]="Missing npx (needed by cdk bootstrap on a first install)"
T[zh-Hant.pf_miss_npx]="缺少 npx(第一次安裝的 cdk bootstrap 需要)"
T[zh-Hans.pf_miss_npx]="缺少 npx(首次安装的 cdk bootstrap 需要)"
T[ja.pf_miss_npx]="npx がありません(初回の cdk bootstrap に必要)"
T[ko.pf_miss_npx]="npx 가 없습니다(첫 설치의 cdk bootstrap 에 필요)"
T[en.pf_policy]="Cannot fetch the permission policy template: %s (is the branch name correct?)"
T[zh-Hant.pf_policy]="抓不到權限政策範本: %s(分支名正確嗎?)"
T[zh-Hans.pf_policy]="拉不到权限策略模板: %s(分支名正确吗?)"
T[ja.pf_policy]="権限ポリシーのテンプレートを取得できません: %s(ブランチ名は正しいですか?)"
T[ko.pf_policy]="권한 정책 템플릿을 가져올 수 없습니다: %s(브랜치 이름이 맞나요?)"
T[en.pf_perm_ok]="    OK permission check passed (%s)"
T[zh-Hant.pf_perm_ok]="    OK 權限檢查通過(%s)"
T[zh-Hans.pf_perm_ok]="    OK 权限检查通过(%s)"
T[ja.pf_perm_ok]="    OK 権限チェック通過(%s)"
T[ko.pf_perm_ok]="    OK 권한 점검 통과(%s)"
T[en.pf_perm_skip]="Could not verify permissions (skipped): %s"
T[zh-Hant.pf_perm_skip]="無法自動驗證權限(略過): %s"
T[zh-Hans.pf_perm_skip]="无法自动验证权限(跳过): %s"
T[ja.pf_perm_skip]="権限を自動検証できません(スキップ): %s"
T[ko.pf_perm_skip]="권한을 자동 확인할 수 없습니다(건너뜀): %s"
T[en.pf_perm_deny]="Your current identity is missing these permissions: %s"
T[zh-Hant.pf_perm_deny]="目前身分缺少這些權限: %s"
T[zh-Hans.pf_perm_deny]="当前身份缺少这些权限: %s"
T[ja.pf_perm_deny]="現在の権限では次が不足しています: %s"
T[ko.pf_perm_deny]="현재 자격 증명에 다음 권한이 없습니다: %s"
T[en.pf_boot_admin]="A first install runs cdk bootstrap, which usually needs near-admin permissions"
T[zh-Hant.pf_boot_admin]="第一次安裝需要 cdk bootstrap,通常需要接近管理員的權限"
T[zh-Hans.pf_boot_admin]="首次安装需要 cdk bootstrap,通常需要接近管理员的权限"
T[ja.pf_boot_admin]="初回は cdk bootstrap が必要で、通常は管理者に近い権限が要ります"
T[ko.pf_boot_admin]="첫 설치는 cdk bootstrap 가 필요하며 보통 관리자급 권한이 필요합니다"
T[en.pf_running]="An install/update is already running (%s); wait for it to finish or stop it in the CodeBuild console"
T[zh-Hant.pf_running]="已有一個安裝/更新正在執行(%s),請等它結束或到 CodeBuild 主控台停止"
T[zh-Hans.pf_running]="已有一个安装/更新正在执行(%s),请等它结束或到 CodeBuild 控制台停止"
T[ja.pf_running]="インストール/更新が既に実行中です(%s)。終了を待つか CodeBuild コンソールで停止してください"
T[ko.pf_running]="설치/업데이트가 이미 실행 중입니다(%s). 끝날 때까지 기다리거나 CodeBuild 콘솔에서 중지하세요"
T[en.pf_bedrock]="Bedrock is not callable in this region or not enabled: the deploy will still succeed, but enable model access in the Bedrock console before running tests"
T[zh-Hant.pf_bedrock]="這個區域呼叫不到 Bedrock 或尚未開通:部署仍會成功,但實際測試前要先在 Bedrock 主控台開啟模型存取"
T[zh-Hans.pf_bedrock]="这个区域调用不到 Bedrock 或尚未开通:部署仍会成功,但实际测试前要先在 Bedrock 控制台开启模型访问"
T[ja.pf_bedrock]="このリージョンで Bedrock を呼び出せないか未有効化です。デプロイは成功しますが、テスト前に Bedrock コンソールでモデルアクセスを有効化してください"
T[ko.pf_bedrock]="이 리전에서 Bedrock 를 호출할 수 없거나 미활성화 상태입니다. 배포는 성공하지만 테스트 전에 Bedrock 콘솔에서 모델 액세스를 켜세요"
T[en.pf_nonus]="Non-US region: default models use us. cross-region inference profiles, so you may need region-specific model IDs; Device Farm real devices are always in us-west-2"
T[zh-Hant.pf_nonus]="非美國區域:預設模型用 us. 跨區推論設定檔,可能要改用該區的模型 ID;Device Farm 真機一律在 us-west-2"
T[zh-Hans.pf_nonus]="非美国区域:默认模型用 us. 跨区推理配置文件,可能要改用该区的模型 ID;Device Farm 真机一律在 us-west-2"
T[ja.pf_nonus]="米国外リージョン:既定モデルは us. のクロスリージョン推論プロファイルを使うため、リージョン別のモデル ID が必要な場合があります。Device Farm 実機は常に us-west-2 です"
T[ko.pf_nonus]="미국 외 리전: 기본 모델은 us. 교차 리전 추론 프로필을 사용하므로 리전별 모델 ID가 필요할 수 있습니다. Device Farm 실기기는 항상 us-west-2 입니다"
T[en.pf_blocked]="Preflight failed; stopping before anything is created:"
T[zh-Hant.pf_blocked]="安裝前檢查沒通過,為避免部署到一半失敗,先停在這裡:"
T[zh-Hans.pf_blocked]="安装前检查未通过,为避免部署到一半失败,先停在这里:"
T[ja.pf_blocked]="プレフライトに失敗。何も作成する前に停止します:"
T[ko.pf_blocked]="프리플라이트 실패. 아무것도 만들기 전에 중단합니다:"
T[en.pf_fix]="Fix the above and run the same command again. (Add --skip-preflight to bypass.)"
T[zh-Hant.pf_fix]="修正上述問題後再執行同一行指令。(確定要略過檢查可加 --skip-preflight)"
T[zh-Hans.pf_fix]="修正上述问题后再执行同一行命令。(确定要跳过检查可加 --skip-preflight)"
T[ja.pf_fix]="上記を修正して同じコマンドを再実行してください。(スキップは --skip-preflight)"
T[ko.pf_fix]="위 문제를 고친 뒤 같은 명령을 다시 실행하세요. (건너뛰려면 --skip-preflight)"
T[en.pf_pass]="==> Checks passed, starting install"
T[zh-Hant.pf_pass]="==> 檢查通過,開始安裝"
T[zh-Hans.pf_pass]="==> 检查通过,开始安装"
T[ja.pf_pass]="==> チェック通過、インストールを開始します"
T[ko.pf_pass]="==> 점검 통과, 설치를 시작합니다"
T[en.boot_first]="==> First install in this region: running cdk bootstrap (~2 min)"
T[zh-Hant.boot_first]="==> 第一次在這個區域安裝:執行 cdk bootstrap(約 2 分鐘)"
T[zh-Hans.boot_first]="==> 首次在这个区域安装:执行 cdk bootstrap(约 2 分钟)"
T[ja.boot_first]="==> このリージョン初回:cdk bootstrap を実行(約 2 分)"
T[ko.boot_first]="==> 이 리전 첫 설치: cdk bootstrap 실행(약 2분)"
T[en.boot_bad]="CDKToolkit status is %s; please fix it in the CloudFormation console first"
T[zh-Hant.boot_bad]="CDKToolkit 狀態是 %s,請先到 CloudFormation 主控台處理"
T[zh-Hans.boot_bad]="CDKToolkit 状态是 %s,请先到 CloudFormation 控制台处理"
T[ja.boot_bad]="CDKToolkit の状態が %s です。先に CloudFormation コンソールで対処してください"
T[ko.boot_bad]="CDKToolkit 상태가 %s 입니다. 먼저 CloudFormation 콘솔에서 조치하세요"
T[en.boot_ready]="==> CDKToolkit ready (%s)"
T[zh-Hant.boot_ready]="==> CDKToolkit 已就緒(%s)"
T[zh-Hans.boot_ready]="==> CDKToolkit 已就绪(%s)"
T[ja.boot_ready]="==> CDKToolkit 準備完了(%s)"
T[ko.boot_ready]="==> CDKToolkit 준비됨(%s)"
T[en.role_new]="==> Creating IAM role %s"
T[zh-Hant.role_new]="==> 建立 IAM 角色 %s"
T[zh-Hans.role_new]="==> 创建 IAM 角色 %s"
T[ja.role_new]="==> IAM ロール %s を作成"
T[ko.role_new]="==> IAM 역할 %s 생성"
T[en.role_wait]="==> Waiting for the IAM role to take effect"
T[zh-Hant.role_wait]="==> 等 IAM 角色生效"
T[zh-Hans.role_wait]="==> 等 IAM 角色生效"
T[ja.role_wait]="==> IAM ロールの反映を待機"
T[ko.role_wait]="==> IAM 역할 적용 대기"
T[en.proj_ready]="==> CodeBuild project %s ready"
T[zh-Hant.proj_ready]="==> CodeBuild 專案 %s 已就緒"
T[zh-Hans.proj_ready]="==> CodeBuild 项目 %s 已就绪"
T[ja.proj_ready]="==> CodeBuild プロジェクト %s 準備完了"
T[ko.proj_ready]="==> CodeBuild 프로젝트 %s 준비됨"
T[en.dep_start]="==> Deploy started: %s"
T[zh-Hant.dep_start]="==> 開始部署: %s"
T[zh-Hans.dep_start]="==> 开始部署: %s"
T[ja.dep_start]="==> デプロイ開始: %s"
T[ko.dep_start]="==> 배포 시작: %s"
T[en.dep_console]="    Console: %s"
T[zh-Hant.dep_console]="    主控台: %s"
T[zh-Hans.dep_console]="    控制台: %s"
T[ja.dep_console]="    コンソール: %s"
T[ko.dep_console]="    콘솔: %s"
T[en.dep_follow]="==> Deployment log below (~30-60 min; closing CloudShell keeps it running in AWS)"
T[zh-Hant.dep_follow]="==> 下面是部署紀錄(約 30–60 分鐘;關掉 CloudShell 也會繼續在 AWS 上跑)"
T[zh-Hans.dep_follow]="==> 下面是部署日志(约 30–60 分钟;关掉 CloudShell 也会继续在 AWS 上跑)"
T[ja.dep_follow]="==> 以下はデプロイログ(約30〜60分。CloudShell を閉じても AWS 上で継続します)"
T[ko.dep_follow]="==> 아래는 배포 로그(약 30~60분. CloudShell 을 닫아도 AWS 에서 계속 실행됩니다)"
T[en.dep_fail]="Deploy failed (%s). See the log above, or the CodeBuild console for %s; fix it and run the same command again."
T[zh-Hant.dep_fail]="部署失敗(%s)。看上面的紀錄,或到 CodeBuild 主控台查看 %s;修好後重新執行同一行指令即可。"
T[zh-Hans.dep_fail]="部署失败(%s)。看上面的日志,或到 CodeBuild 控制台查看 %s;修好后重新执行同一行命令即可。"
T[ja.dep_fail]="デプロイ失敗(%s)。上のログ、または CodeBuild コンソールで %s を確認し、修正後に同じコマンドを再実行してください。"
T[ko.dep_fail]="배포 실패(%s). 위 로그 또는 CodeBuild 콘솔에서 %s 를 확인하고, 수정 후 같은 명령을 다시 실행하세요."
T[en.done_title]=" PlayAgent Checker deployed"
T[zh-Hant.done_title]=" PlayAgent Checker 部署完成"
T[zh-Hans.done_title]=" PlayAgent Checker 部署完成"
T[ja.done_title]=" PlayAgent Checker デプロイ完了"
T[ko.done_title]=" PlayAgent Checker 배포 완료"
T[en.done_url]=" URL   : %s"
T[zh-Hant.done_url]=" 網址  : %s"
T[zh-Hans.done_url]=" 网址  : %s"
T[ja.done_url]=" URL   : %s"
T[ko.done_url]=" URL   : %s"
T[en.done_admin]=" Admin : %s"
T[zh-Hant.done_admin]=" 管理員: %s"
T[zh-Hans.done_admin]=" 管理员: %s"
T[ja.done_admin]=" 管理者: %s"
T[ko.done_admin]=" 관리자: %s"
T[en.done_first]=" First sign-in: check your email for the temporary password; you set a new one on first login."
T[zh-Hant.done_first]=" 第一次登入:到信箱找臨時密碼,登入後會要求設定新的。"
T[zh-Hans.done_first]=" 第一次登录:到邮箱找临时密码,登录后会要求设置新的。"
T[ja.done_first]=" 初回ログイン:メールの仮パスワードでログインし、新しいものを設定します。"
T[ko.done_first]=" 첫 로그인: 이메일의 임시 비밀번호로 로그인한 뒤 새로 설정합니다."
T[en.done_update]=" To update later: run the same command again."
T[zh-Hant.done_update]=" 之後要更新:再執行同一行指令即可。"
T[zh-Hans.done_update]=" 之后要更新:再执行同一行命令即可。"
T[ja.done_update]=" 後で更新:同じコマンドを再実行するだけです。"
T[ko.done_update]=" 나중에 업데이트: 같은 명령을 다시 실행하면 됩니다."

T[en.inst_running]="==> Installing. Progress below (each step; closing CloudShell keeps it running in AWS):"
T[zh-Hant.inst_running]="==> 安裝中,下面是進度(逐步顯示;關掉 CloudShell 也會繼續在 AWS 上跑):"
T[zh-Hans.inst_running]="==> 安装中,下面是进度(逐步显示;关掉 CloudShell 也会继续在 AWS 上跑):"
T[ja.inst_running]="==> インストール中。以下は進捗(各ステップ。CloudShell を閉じても AWS 上で継続します):"
T[ko.inst_running]="==> 설치 중. 아래는 진행 상황(각 단계. CloudShell 을 닫아도 AWS 에서 계속 실행됩니다):"
T[en.s_prepare]="Preparing the latest source"
T[zh-Hant.s_prepare]="準備最新版原始碼"
T[zh-Hans.s_prepare]="准备最新版源码"
T[ja.s_prepare]="最新ソースを準備"
T[ko.s_prepare]="최신 소스 준비"
T[en.s_tools]="Check tools & AWS identity"
T[zh-Hant.s_tools]="檢查工具與 AWS 身分"
T[zh-Hans.s_tools]="检查工具与 AWS 身份"
T[ja.s_tools]="ツールと AWS ID を確認"
T[ko.s_tools]="도구와 AWS 자격 증명 확인"
T[en.s_deps]="Install dependencies (lockfile)"
T[zh-Hant.s_deps]="安裝相依套件(lockfile)"
T[zh-Hans.s_deps]="安装依赖(lockfile)"
T[ja.s_deps]="依存関係をインストール(lockfile)"
T[ko.s_deps]="의존성 설치(lockfile)"
T[en.s_tests]="Run pre-deploy checks"
T[zh-Hant.s_tests]="執行部署前檢查"
T[zh-Hans.s_tests]="执行部署前检查"
T[ja.s_tests]="デプロイ前チェック"
T[ko.s_tests]="배포 전 점검 실행"
T[en.s_bootstrap]="CDK bootstrap"
T[zh-Hant.s_bootstrap]="CDK bootstrap"
T[zh-Hans.s_bootstrap]="CDK bootstrap"
T[ja.s_bootstrap]="CDK bootstrap"
T[ko.s_bootstrap]="CDK bootstrap"
T[en.s_foundation]="Deploy Foundation, Execution & ECR"
T[zh-Hant.s_foundation]="部署 Foundation、Execution 與 ECR"
T[zh-Hans.s_foundation]="部署 Foundation、Execution 与 ECR"
T[ja.s_foundation]="Foundation・Execution・ECR をデプロイ"
T[ko.s_foundation]="Foundation, Execution, ECR 배포"
T[en.s_admin]="Create the admin account"
T[zh-Hant.s_admin]="建立管理員帳號"
T[zh-Hans.s_admin]="创建管理员账号"
T[ja.s_admin]="管理者アカウントを作成"
T[ko.s_admin]="관리자 계정 생성"
T[en.s_images]="Build & push runner images"
T[zh-Hant.s_images]="建置並推送 runner 映像"
T[zh-Hans.s_images]="构建并推送 runner 镜像"
T[ja.s_images]="ランナーイメージをビルド&プッシュ"
T[ko.s_images]="러너 이미지 빌드 및 푸시"
T[en.s_pin_ecs]="Pin ECS task definitions"
T[zh-Hant.s_pin_ecs]="鎖定 ECS task definitions"
T[zh-Hans.s_pin_ecs]="锁定 ECS task definitions"
T[ja.s_pin_ecs]="ECS タスク定義を固定"
T[ko.s_pin_ecs]="ECS 작업 정의 고정"
T[en.s_scheduling]="Deploy Scheduling & ControlPlane"
T[zh-Hant.s_scheduling]="部署 Scheduling 與 ControlPlane"
T[zh-Hans.s_scheduling]="部署 Scheduling 与 ControlPlane"
T[ja.s_scheduling]="Scheduling と ControlPlane をデプロイ"
T[ko.s_scheduling]="Scheduling 과 ControlPlane 배포"
T[en.s_frontend_build]="Build the web frontend"
T[zh-Hant.s_frontend_build]="建置前端網站"
T[zh-Hans.s_frontend_build]="构建前端网站"
T[ja.s_frontend_build]="フロントエンドをビルド"
T[ko.s_frontend_build]="프런트엔드 빌드"
T[en.s_frontend]="Deploy the frontend"
T[zh-Hant.s_frontend]="部署前端"
T[zh-Hans.s_frontend]="部署前端"
T[ja.s_frontend]="フロントエンドをデプロイ"
T[ko.s_frontend]="프런트엔드 배포"
T[en.s_updater]="Deploy the Updater (one-click update)"
T[zh-Hant.s_updater]="部署更新器(一鍵更新)"
T[zh-Hans.s_updater]="部署更新器(一键更新)"
T[ja.s_updater]="アップデータをデプロイ(ワンクリック更新)"
T[ko.s_updater]="업데이터 배포(원클릭 업데이트)"
T[en.s_verify]="Verify the deployment"
T[zh-Hant.s_verify]="部署後驗證"
T[zh-Hans.s_verify]="部署后验证"
T[ja.s_verify]="デプロイを検証"
T[ko.s_verify]="배포 검증"
T[en.done_pw]=" Temp password : %s"
T[zh-Hant.done_pw]=" 臨時密碼: %s"
T[zh-Hans.done_pw]=" 临时密码: %s"
T[ja.done_pw]=" 仮パスワード: %s"
T[ko.done_pw]=" 임시 비밀번호: %s"
T[en.done_pw_note]=" (also emailed to the admin; you must change it on first sign-in)"
T[zh-Hant.done_pw_note]=" (也已寄到管理員信箱;第一次登入時必須改掉)"
T[zh-Hans.done_pw_note]=" (也已发到管理员邮箱;第一次登录时必须改掉)"
T[ja.done_pw_note]=" (管理者宛てにメールも送信済み。初回ログインで必ず変更してください)"
T[ko.done_pw_note]=" (관리자 이메일로도 발송됨. 첫 로그인 시 반드시 변경하세요)"
T[en.done_pw_existing]=" Admin already existed — temporary password unchanged (reset it on the Members page if needed)"
T[zh-Hant.done_pw_existing]=" 管理員原本就存在 — 臨時密碼未變更(需要的話到成員管理頁重設)"
T[zh-Hans.done_pw_existing]=" 管理员原本就存在 — 临时密码未变更(需要的话到成员管理页重置)"
T[ja.done_pw_existing]=" 管理者は既に存在 — 仮パスワードは変更なし(必要ならメンバー管理ページで再設定)"
T[ko.done_pw_existing]=" 관리자가 이미 존재 — 임시 비밀번호 변경 없음(필요하면 멤버 관리 페이지에서 재설정)"

t(){ local k="${LANG_CODE}.$1"; printf '%s' "${T[$k]:-${T[en.$1]:-$1}}"; }
say(){ printf '%s\n' "$(t "$1")"; }
sayf(){ local f; f="$(t "$1")"; shift; printf "$f\n" "$@"; }

if [[ -z "$EMAIL" && -r /dev/tty ]]; then
  read -r -p "$(t ask_email)" EMAIL </dev/tty
fi
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { say bad_email >&2; exit 1; }
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { sayf bad_region "$REGION" >&2; exit 1; }
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { sayf bad_branch "$BRANCH" >&2; exit 1; }
command -v aws >/dev/null && command -v node >/dev/null && command -v curl >/dev/null || { say need_tools >&2; exit 1; }

# 安裝前檢查:掃描必備工具、政策範本、呼叫者權限、是否已有安裝在跑、Bedrock 可用性。
# 有任何阻擋項就在建立任何資源「之前」停下,一次列出所有問題,避免部署到一半才失敗。
preflight() {
  local toolkit="$1"
  local blockers=() warnings=()
  say pf_run

  # 必備工具(CloudShell 內建;第一次安裝的 cdk bootstrap 需要 npx)。
  for c in aws node curl; do command -v "$c" >/dev/null || blockers+=("$(printf "$(t pf_miss_cmd)" "$c")"); done
  if [[ "$toolkit" == MISSING ]]; then command -v npx >/dev/null || blockers+=("$(t pf_miss_npx)"); fi

  # 權限政策範本要抓得到(順便驗證分支名正確)。
  if ! curl -fsIL "$RAW_BASE/$BRANCH/infra/iam/playagent-deployer-policy.json" >/dev/null 2>&1; then
    blockers+=("$(printf "$(t pf_policy)" "$RAW_BASE/$BRANCH/infra/iam/playagent-deployer-policy.json")")
  fi

  # 用呼叫者身分模擬這支腳本需要的動作(identity policy 層級;不含 SCP/權限邊界,但能擋掉大多數權限不足)。
  local caller principal role_name
  caller="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)"
  principal="$caller"
  if [[ "$caller" == *:assumed-role/* ]]; then
    role_name="$(sed -E 's#.*:assumed-role/([^/]+)/.*#\1#' <<<"$caller")"
    principal="arn:aws:iam::$ACCOUNT:role/$role_name"
  fi
  local actions=(iam:GetRole iam:CreateRole iam:PutRolePolicy iam:UpdateAssumeRolePolicy iam:PassRole \
    codebuild:CreateProject codebuild:UpdateProject codebuild:BatchGetProjects codebuild:StartBuild \
    logs:CreateLogGroup logs:PutRetentionPolicy cloudformation:DescribeStacks)
  if [[ "$toolkit" == MISSING ]]; then
    actions+=(cloudformation:CreateStack s3:CreateBucket ecr:CreateRepository ssm:PutParameter iam:AttachRolePolicy)
  fi
  local denied
  denied="$(aws iam simulate-principal-policy --policy-source-arn "$principal" \
      --action-names "${actions[@]}" \
      --query 'EvaluationResults[?EvalDecision!=`allowed`].EvalActionName' --output text 2>"$WORK/sim.err" || true)"
  if [[ -s "$WORK/sim.err" ]]; then
    warnings+=("$(printf "$(t pf_perm_skip)" "$(head -1 "$WORK/sim.err")")")
  elif [[ -n "$denied" ]]; then
    blockers+=("$(printf "$(t pf_perm_deny)" "$(tr '\t' ' ' <<<"$denied")")")
    [[ "$toolkit" == MISSING ]] && warnings+=("$(t pf_boot_admin)")
  else
    printf "$(t pf_perm_ok)\n" "$principal"
  fi

  # 已經有安裝/更新在跑?避免同時部署互相打架。
  local running rstate
  running="$(aws codebuild list-builds-for-project --project-name "$NAME" --query 'ids[0]' --output text 2>/dev/null || true)"
  if [[ -n "$running" && "$running" != None ]]; then
    rstate="$(aws codebuild batch-get-builds --ids "$running" --query 'builds[0].buildStatus' --output text 2>/dev/null || true)"
    [[ "$rstate" == IN_PROGRESS ]] && blockers+=("$(printf "$(t pf_running)" "$running")")
  fi

  # Bedrock(非阻擋):部署不需要,但實際測試需要先在這個區域開通模型存取。
  if ! aws bedrock list-foundation-models --query 'modelSummaries[0].modelId' --output text >/dev/null 2>&1; then
    warnings+=("$(t pf_bedrock)")
  fi
  case "$REGION" in
    us-*) : ;;
    *) warnings+=("$(t pf_nonus)") ;;
  esac

  for w in "${warnings[@]:-}"; do [[ -n "$w" ]] && echo "    ⚠ $w"; done
  if (( ${#blockers[@]} )); then
    { echo ""; say pf_blocked
      for b in "${blockers[@]}"; do echo "  ✗ $b"; done
      echo ""; say pf_fix
    } >&2
    exit 1
  fi
  say pf_pass
}

export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || { say no_account >&2; exit 1; }
sayf summary "$ACCOUNT" "$REGION" "$BRANCH" "$EMAIL"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 0. Preflight:在建立任何資源「之前」掃描前置條件與權限,fail fast(可用 --skip-preflight 略過)。
TOOLKIT_STATUS="$(aws cloudformation describe-stacks --stack-name CDKToolkit --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)"
if (( ! SKIP_PREFLIGHT )); then preflight "$TOOLKIT_STATUS"; fi

# 1. CDK bootstrap (admin only, once per account/region)
if [[ "$TOOLKIT_STATUS" == MISSING ]]; then
  say boot_first
  (cd "$WORK" && npx -y aws-cdk@2 bootstrap "aws://$ACCOUNT/$REGION")
elif [[ ! "$TOOLKIT_STATUS" =~ ^(CREATE|UPDATE|UPDATE_ROLLBACK)_COMPLETE$ ]]; then
  sayf boot_bad "$TOOLKIT_STATUS" >&2; exit 1
else
  sayf boot_ready "$TOOLKIT_STATUS"
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
  sayf role_new "$NAME"
else
  aws iam update-assume-role-policy --role-name "$NAME" --policy-document "$TRUST"
fi
aws iam put-role-policy --role-name "$NAME" --policy-name PlayAgentDeployer --policy-document "file://$WORK/policy.json"
aws iam put-role-policy --role-name "$NAME" --policy-name CodeBuildLogs --policy-document "file://$WORK/logs.json"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$NAME"
LOG_GROUP="/aws/codebuild/$NAME"
aws logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30
if (( NEW_ROLE )); then say role_wait; sleep 15; fi

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
  "      - cd /tmp/src && PA_PROGRESS=1 node scripts/deploy-latest.mjs --non-interactive --repository-url \"$PA_REPO\" --branch \"$PA_BRANCH\" --region \"$PA_REGION\" --admin-email \"$PA_ADMIN_EMAIL\" --admin-invite",
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
sayf proj_ready "$NAME"

# 4. Start the build and follow it
BUILD_ID="$(aws codebuild start-build --project-name "$NAME" \
  --environment-variables-override "name=PA_ADMIN_EMAIL,value=$EMAIL,type=PLAINTEXT" "name=PA_REGION,value=$REGION,type=PLAINTEXT" "name=PA_BRANCH,value=$BRANCH,type=PLAINTEXT" \
  --query 'build.id' --output text)"
sayf dep_start "$BUILD_ID"
sayf dep_console "https://$REGION.console.aws.amazon.com/codesuite/codebuild/projects/$NAME/history?region=$REGION"
if (( ! WAIT )); then exit 0; fi
say inst_running

# 進度顯示:只呈現步驟進度([i/N]),不把 CodeBuild 原始 log 洗版到畫面上;
# 失敗時才印出 log 末段幫忙除錯。原始 log 寫到檔案,從裡面挑 PA_STEP / PA_PREPARE 標記來呈現。
LOGF="$WORK/build.log"
: > "$LOGF"
aws logs tail "$LOG_GROUP" --follow --format short --since 1m --log-stream-name-prefix "${BUILD_ID#*:}" > "$LOGF" 2>/dev/null &
TAIL_PID=$!
trap 'kill "$TAIL_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

LAST=0; PREPARED=0
render_steps() {
  while IFS='|' read -r key idx total; do
    [[ -z "${idx:-}" ]] && continue
    if (( idx > LAST )); then LAST=$idx; printf '  [%s/%s] %s\n' "$idx" "$total" "$(t "s_$key")"; fi
  done < <(grep -ao 'PA_STEP|[a-z_]*|[0-9][0-9]*|[0-9][0-9]*' "$LOGF" 2>/dev/null | sed 's/^PA_STEP|//')
}
STATE=IN_PROGRESS
while [[ "$STATE" == IN_PROGRESS ]]; do
  sleep 15
  if (( ! PREPARED )) && grep -aq 'PA_PREPARE|' "$LOGF" 2>/dev/null; then PREPARED=1; echo "  $(t s_prepare)"; fi
  render_steps
  STATE="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text 2>/dev/null || echo IN_PROGRESS)"
done
sleep 6
render_steps
kill "$TAIL_PID" 2>/dev/null || true

echo
if [[ "$STATE" != SUCCEEDED ]]; then
  sayf dep_fail "$STATE" "$BUILD_ID" >&2
  echo "---- log tail ----" >&2
  # 優先用 follow 到的檔案;若為空(例如 log stream 尚未出現時才啟動 tail),直接向 CloudWatch 取。
  if [[ -s "$LOGF" ]]; then
    tail -n 30 "$LOGF" >&2
  else
    aws logs get-log-events --region "$REGION" --log-group-name "$LOG_GROUP" --log-stream-name "${BUILD_ID#*:}" \
      --limit 40 --no-start-from-head --query 'events[*].message' --output text >&2 2>/dev/null || true
  fi
  exit 1
fi

SITE="$(aws cloudformation describe-stacks --stack-name PlayAgentDev-Frontend --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue | [0]" --output text 2>/dev/null || true)"
# 讀取安裝器在部署期間暫存的臨時密碼,顯示後立刻刪除(值不會留在 SSM)。
PW="$(aws ssm get-parameter --name "/playagent/PlayAgentDev/admin-temp-password" --query Parameter.Value --output text 2>/dev/null || true)"
if [[ -n "$PW" && "$PW" != None ]]; then aws ssm delete-parameter --name "/playagent/PlayAgentDev/admin-temp-password" >/dev/null 2>&1 || true; fi
echo "========================================"
say done_title
sayf done_url "$SITE"
sayf done_admin "$EMAIL"
if [[ -n "$PW" && "$PW" != None ]]; then
  sayf done_pw "$PW"
  say done_pw_note
else
  say done_pw_existing
fi
say done_update
echo "========================================"
