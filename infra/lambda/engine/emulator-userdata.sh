#!/bin/bash
# 每任務 Redroid 主機 userdata(自驅動)。Graviton(arm64)上用 Docker 跑 Redroid(開源 Android 容器)。
# 主機起來後:裝 docker+binder → Redroid → 裝 APK → 跑 AI runner(與 Device Farm 同一套:三個 Agent、證據、報告;
# runner 在本機直接呼叫 Bedrock)→ 自我終結。per-job 輸入經 EC2 tag 與 job.json 讀取。
# ⚠ 行尾必須 LF;長度需 < 16384 原始位元組。
exec > >(tee /var/log/emulator-bootstrap.log) 2>&1
# 每行 trace 帶 UTC 時間:前置作業(apt / docker pull / APK 安裝)各段實際花多久。
# 沒有這個就只能靠 log 行數反推,而行數不等於時間 —— 要優化哪一段得先量得到。
export PS4='+[$(date -u +%H:%M:%S)] '
set -x
export DEBIAN_FRONTEND=noninteractive

# --- 0. 中和 unattended-upgrades(防 first-boot 裝核心後 reboot 打斷 userdata)---
systemctl kill --signal=SIGKILL unattended-upgrades apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
pkill -9 -f unattended-upgrade 2>/dev/null || true
for i in $(seq 1 12); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; sleep 5; done
dpkg --configure -a 2>/dev/null || true
apt-get -y --fix-broken install 2>/dev/null || true
for i in $(seq 1 30); do apt-get update -y && break; sleep 5; done
retry() { local n="$1"; shift; for i in $(seq 1 "$n"); do "$@" && return 0; sleep 5; done; return 1; }
# 分開裝並重試(Ubuntu noble first-boot apt 抖動);docker 必須確實裝上,否則後面 docker run 靜默失敗。
retry 10 apt-get install -y jq unzip curl
retry 10 apt-get install -y awscli || retry 10 snap install aws-cli --classic || true
retry 10 apt-get install -y docker.io
retry 10 apt-get install -y android-tools-adb
command -v docker >/dev/null || { echo "!!! docker 安裝失敗"; sleep 5; }

# --- 1. IMDSv2 讀 region 與 per-job tag(加重試等 tag 傳播)---
TOKEN=$(curl -sS -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
imds() { curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/$1"; }
export AWS_DEFAULT_REGION=$(imds meta-data/placement/region)
IID=$(imds meta-data/instance-id)
tag() { aws ec2 describe-tags --region "$AWS_DEFAULT_REGION" --filters "Name=resource-id,Values=$IID" "Name=key,Values=$1" --query 'Tags[0].Value' --output text 2>/dev/null; }
# tag 可能於 RunInstances 後短暫未傳播;輪詢直到 jobId 非空(最多 ~60s)。
for i in $(seq 1 20); do
  JOB_ID=$(tag 'playagent:jobId')
  [ -n "$JOB_ID" ] && [ "$JOB_ID" != "None" ] && break
  sleep 3
done
TENANT_ID=$(tag 'playagent:tenantId'); BUCKET=$(tag 'playagent:bucket')
VLM_MODEL=$(tag 'playagent:vlmModel'); TENANT_ROLE=$(tag 'playagent:tenantRole'); BUDGET=$(tag 'playagent:budget')
AGENT_MODEL=$(tag 'playagent:agentModel'); SUBAGENT_MODEL=$(tag 'playagent:subagentModel')
MAX_STEPS=$(tag 'playagent:maxSteps'); TTL_MIN=$(tag 'playagent:ttlMinutes')
for v in AGENT_MODEL SUBAGENT_MODEL MAX_STEPS TTL_MIN; do [ "${!v}" = "None" ] && eval "$v=''"; done
PREFIX="tenants/$TENANT_ID/jobs/$JOB_ID"

selfterm() { aws ec2 terminate-instances --instance-ids "$IID" 2>/dev/null || true; }
writestatus() { # $1=state $2=message $3=steps
  printf '{"jobId":"%s","state":"%s","message":"%s","steps":%s,"updatedAt":"%s"}' \
    "$JOB_ID" "$1" "$2" "${3:-0}" "$(date -u +%FT%TZ)" \
    | aws s3 cp - "s3://$BUCKET/$PREFIX/status.json" --content-type application/json 2>/dev/null || true
}
trap 'writestatus error "userdata failed line $LINENO" 0; selfterm' ERR
# TTL 保險回收(長時測試可跑很久;預設 12 小時,engine 依任務時長 + 15 分鐘帶 ttlMinutes)。關機 = 終止實例。
# runner 會在 TTL 前 15 分鐘自己收尾寫報告(PA_DEADLINE_MS);這裡是最後防線:
# 時間到還沒有終態就先寫 error + 上傳 log,再關機 —— 任務絕不會永遠卡在「執行中」。
TTL_MIN=${TTL_MIN:-720}
DEADLINE_MS=$(( ( $(date +%s) + (TTL_MIN > 30 ? TTL_MIN - 15 : TTL_MIN) * 60 ) * 1000 ))
(
  sleep $(( TTL_MIN * 60 ))
  CUR=$(aws s3 cp "s3://$BUCKET/$PREFIX/status.json" - 2>/dev/null | jq -r '.state // empty' || true)
  if [ "$CUR" = "running" ] || [ -z "$CUR" ]; then
    printf '{"jobId":"%s","state":"error","message":"%s","steps":0,"updatedAt":"%s"}' \
      "$JOB_ID" "已達主機保險回收時間(${TTL_MIN} 分鐘),runner 未能正常收尾;已完成的步驟仍保留在執行軌跡中。" "$(date -u +%FT%TZ)" \
      | aws s3 cp - "s3://$BUCKET/$PREFIX/status.json" --content-type application/json 2>/dev/null || true
  fi
  aws s3 cp /var/log/runner.log "s3://$BUCKET/$PREFIX/runner.log" 2>/dev/null || true
  aws s3 cp /var/log/emulator-bootstrap.log "s3://$BUCKET/$PREFIX/bootstrap.log" 2>/dev/null || true
  shutdown -h now
) &

# 註:本主機專屬單一 job,直接用實例 profile 憑證存取 S3(該租戶前綴)與 Bedrock,
# 不另扮租戶角色(主機生命週期即一個 job,實例 profile 權限已限本資料桶)。

# --- 3. binder 核心模組(Ubuntu linux-modules-extra 提供)---
apt-get install -y "linux-modules-extra-$(uname -r)" || echo "modules-extra unavailable"
systemctl enable --now docker
modprobe binder_linux devices="binder,hwbinder,vndbinder" || true
mkdir -p /dev/binderfs
mount -t binder binder /dev/binderfs 2>/dev/null || true
if ! mountpoint -q /dev/binderfs && [ ! -e /dev/binder ]; then
  writestatus error "binder unavailable on this kernel" 0; selfterm; exit 1
fi

uplog() { aws s3 cp /var/log/emulator-bootstrap.log "s3://$BUCKET/$PREFIX/bootstrap.log" 2>/dev/null || true; }

# --- 4. Redroid(host 架構自動拉對應 image)---
# 網路:沿用 Docker 預設 bridge + Docker daemon 自己管理的 NAT(已在 game-ai-qa 真機驗證可連外網)。
# 「不」手動改 iptables MASQUERADE/FORWARD、「不」覆寫 --dns、「不」設 Redroid net_dns 參數——
# 那些客製反而會覆蓋 Docker 自己的規則、把原本能通的網路弄壞(playagent 舊版連不上網的根因)。
aws s3 cp "s3://$BUCKET/$PREFIX/job.json" /tmp/job.json || true
RW=$(jq -r '.display.width // 1080' /tmp/job.json 2>/dev/null || echo 1080); RH=$(jq -r '.display.height // 1920' /tmp/job.json 2>/dev/null || echo 1920)
# Android 版本:使用者在送出任務時選的。
# 映像名由 API 端解析好寫進 job.json(lambda/api/deviceOptions.ts 的白名單)——
# 這裡「不」自己用版本號組 tag:版本與 tag 之間沒有通用公式(8.1 的 tag 是 8.1.0-latest,
# 不是 8.1.0.0),自己組會悄悄拉到不存在的映像,主機只會回報「開機逾時」。
AV=$(jq -r '.androidVersion // "15"' /tmp/job.json 2>/dev/null || echo 15)
IMG=$(jq -r '.androidImage // "redroid/redroid:15.0.0-latest"' /tmp/job.json 2>/dev/null || echo "redroid/redroid:15.0.0-latest")
# 防呆:只接受 redroid 官方 repo 的合法形狀,擋掉被竄改的 job.json 指向任意映像。
echo "$IMG" | grep -Eq '^redroid/redroid:[0-9]+(\.[0-9]+)*-latest$' || IMG="redroid/redroid:15.0.0-latest"
writestatus running "pulling Android $AV image" 0; uplog
# 拉不到就「失敗」,不退回其他版本:穩定度測試若實際跑了別的 OS 版本,結果就是假的。
if ! retry 5 docker pull "$IMG"; then
  echo "!!! 拉不到 $IMG"; uplog
  writestatus error "找不到 Android $AV 的容器映像($IMG)。請改選其他版本。" 0; selfterm; exit 1
fi
docker rm -f android 2>/dev/null || true
docker run -d --privileged --name android --restart unless-stopped -m 12g \
  -p 0.0.0.0:5555:5555 "$IMG" \
  androidboot.redroid_gpu_mode=guest androidboot.redroid_width="$RW" androidboot.redroid_height="$RH" \
  ro.setupwizard.mode=OPTIONAL
sleep 5
if ! docker ps --filter name=android --filter status=running | grep -q android; then
  echo "!!! redroid 容器未運行"; docker logs android 2>&1 | tail -20; uplog
  writestatus error "redroid container failed to start" 0; selfterm; exit 1
fi

# --- 5. 等 boot_completed(首次 boot 可能較久,上限 600s)---
writestatus running "waiting android boot" 0; uplog
adb start-server
deadline=$(( $(date +%s) + 600 ))
until adb connect 127.0.0.1:5555 >/dev/null 2>&1 && \
      [ "$(adb -s 127.0.0.1:5555 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  [ $(date +%s) -gt $deadline ] && { docker logs android 2>&1 | tail -20; uplog; writestatus error "redroid boot timeout" 0; selfterm; exit 1; }
  sleep 8
done
ADB="adb -s 127.0.0.1:5555"

# --- 5b. 連網自檢(僅記錄,不改設定、不阻斷)---
# 沿用 Docker 預設網路;此處只做 ping/DNS 自測並寫 log,方便判斷「遊戲連不上」是 guest 網路
# 問題還是遊戲後端封鎖。不再手動改 guest resolver(那會破壞 Docker 預設 NAT/DNS)。
NET_PING=$($ADB shell ping -c1 -W2 8.8.8.8 2>&1 | tr -d '\r' | tail -3)
NET_CURL=$($ADB shell 'ping -c1 -W2 google.com 2>&1' | tr -d '\r' | tail -2)
echo "guest-net-check: ping8888=[$NET_PING] | dnsresolve=[$NET_CURL]"

writestatus running "android booted, installing APK" 0; uplog

# --- 6. 讀 job.json 取 APK key + 裝 APK(split 包用 install-multiple)+ 推 OBB + 自動啟動 ---
APK_KEY=$(jq -r '.artifactKey // empty' /tmp/job.json)
PKG=$(jq -r '.package // .identifier // empty' /tmp/job.json)
if [ -n "$APK_KEY" ]; then
  aws s3 cp "s3://$BUCKET/$APK_KEY" /tmp/app.apk
  # 上傳時副檔名被正規化為 app.apk,無法靠副檔名判斷 split 包。改用內容探測:
  # XAPK/APKS/APKM 是 ZIP 容器,裡面含多個 *.apk;單一 APK 也是 ZIP 但頂層無巢狀 .apk。
  # 注意:單一遊戲 APK 內部也可能夾帶 1 個巢狀 .apk(例如 stub/預載),所以不能只看「有沒有 .apk」。
  # 判定 split 的條件:巢狀 .apk 數量 >= 2,或存在 manifest.json(APKS/XAPK 的清單檔)。
  IS_SPLIT=no
  NESTED_APK_COUNT=$(unzip -l /tmp/app.apk 2>/dev/null | grep -cE '\.apk( |$)' || true)
  HAS_MANIFEST=$(unzip -l /tmp/app.apk 2>/dev/null | grep -cE '(^| )manifest\.json( |$)' || true)
  if [ "${NESTED_APK_COUNT:-0}" -ge 2 ] || [ "${HAS_MANIFEST:-0}" -ge 1 ]; then IS_SPLIT=yes; fi
  echo "split-detect: nested_apk=$NESTED_APK_COUNT has_manifest=$HAS_MANIFEST -> IS_SPLIT=$IS_SPLIT"
  if [ "$IS_SPLIT" = "yes" ]; then
    # split 包:解開,裝所有分片 APK,OBB 推到 /sdcard/Android/obb/<pkg>/。
    rm -rf /tmp/xa; mkdir /tmp/xa; unzip -qo /tmp/app.apk -d /tmp/xa
    XPKG=$(jq -r '.package_name // empty' /tmp/xa/manifest.json 2>/dev/null || true)
    if [ -n "$XPKG" ] && [ "$XPKG" != "null" ]; then PKG="$XPKG"; fi
    APKS=$(find /tmp/xa -name '*.apk')
    echo "installing split apks: $APKS ; pkg=$PKG"
    $ADB install-multiple -r $APKS 2>&1 | tail -3 || $ADB install -r $(echo "$APKS" | head -1) 2>&1 | tail -3 || true
    OBBDIR=$(find /tmp/xa -type d -name 'obb' | head -1)
    if [ -n "$OBBDIR" ] && [ -n "$PKG" ]; then
      $ADB shell mkdir -p /sdcard/Android/obb/$PKG
      find "$OBBDIR" -name '*.obb' | while read f; do echo "push obb $f"; $ADB push "$f" /sdcard/Android/obb/$PKG/; done
    fi
    writestatus running "split APK + OBB installed (pkg=$PKG)" 0; uplog
  else
    echo "installing single apk"
    $ADB install -r /tmp/app.apk 2>&1 | tail -3 || true
  fi
  # 包名仍未知時,從第三方(非系統)已裝包清單推斷剛裝的遊戲包。
  if [ -z "$PKG" ] || [ "$PKG" = "null" ]; then
    PKG=$($ADB shell pm list packages -3 2>/dev/null | sed 's/package://' | tr -d '\r' | grep -viE 'inputmethod|webview|gboard' | head -1)
    echo "derived pkg from pm list: $PKG"
  fi
  # 關掉 Android「Viewing full screen / Got it」沉浸模式確認彈窗:設 immersive_mode_confirmations=confirmed
  # 讓遊戲進全螢幕時不再彈那張系統卡片(否則會一直疊在遊戲畫面上干擾 AI 判斷)。
  $ADB shell settings put secure immersive_mode_confirmations confirmed 2>/dev/null || true
  # 自動啟動遊戲到前景(resolve-activity → monkey 兜底),讓 AI 從遊戲畫面開始測。
  if [ -n "$PKG" ]; then
    ACT=$($ADB shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER -a android.intent.action.MAIN "$PKG" 2>/dev/null | tail -1 | tr -d '\r')
    if echo "$ACT" | grep -q '/'; then
      echo "am start -n $ACT"; $ADB shell am start -n "$ACT" 2>&1 | tail -2 || true
    else
      echo "monkey launch $PKG"; $ADB shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 2>&1 | tail -2 || true
    fi
    # 等遊戲開場/載入(首次啟動可能下載資源),輪詢前景 activity 是否為該包。
    for k in $(seq 1 8); do
      FG=$($ADB shell dumpsys activity activities 2>/dev/null | grep -i 'mResumedActivity\|topResumedActivity' | head -1)
      echo "fg check $k: $FG"
      if echo "$FG" | grep -q "$PKG"; then break; fi
      sleep 5
    done
    writestatus running "game launched (pkg=$PKG)" 0; uplog
  fi
fi

# --- 7. AI runner(與 Device Farm 同一套 explorationRunner,改用 adb 驅動;runner 在本機直接呼叫 Bedrock)---
writestatus running "installing AI runner" 0; uplog
retry 10 apt-get install -y imagemagick ffmpeg || true
case "$(uname -m)" in aarch64) NARCH=arm64 ;; *) NARCH=x64 ;; esac
NODE_V=v22.12.0
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(+process.versions.node.split(".")[0] < 20)'; then
  retry 5 curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-$NARCH.tar.xz"
  tar -xJf /tmp/node.tar.xz -C /opt
  ln -sf "/opt/node-$NODE_V-linux-$NARCH/bin/node" /usr/local/bin/node
  ln -sf "/opt/node-$NODE_V-linux-$NARCH/bin/npm" /usr/local/bin/npm
fi
mkdir -p /opt/runner
retry 3 aws s3 cp "s3://$BUCKET/_engine/runner/" /opt/runner/ --recursive --only-show-errors
cp /opt/runner/exploration-runner.package.json /opt/runner/package.json
(cd /opt/runner && retry 3 npm install --omit=dev --no-audit --no-fund)
APP_ID=$(jq -r '.appId // empty' /tmp/job.json)
TASK=$(jq -r '.caseTask // empty' /tmp/job.json)
writestatus running "AI agent starting" 0; uplog
PA_DRIVER=adb PA_ADB_SERIAL=127.0.0.1:5555 PA_PLATFORM=android \
PA_JOB="$JOB_ID" PA_TENANT="$TENANT_ID" PA_APP="$APP_ID" PA_BUCKET="$BUCKET" PA_PREFIX="$PREFIX" \
PA_DATA_REGION="$AWS_DEFAULT_REGION" PA_VLM="$VLM_MODEL" PA_AGENT_MODEL="$AGENT_MODEL" PA_SUBAGENT_MODEL="$SUBAGENT_MODEL" \
PA_PKG="$PKG" PA_TASK="$TASK" PA_MAXSTEPS="$MAX_STEPS" PA_DEVICE_MODEL="Redroid Android $AV ($(uname -m)) ${RW}x${RH}" \
PA_DEADLINE_MS="$DEADLINE_MS" \
node /opt/runner/explorationRunner.mjs > /var/log/runner.log 2>&1 || true
aws s3 cp /var/log/runner.log "s3://$BUCKET/$PREFIX/runner.log" 2>/dev/null || true
# runner 沒寫終態(例如啟動就崩潰)才補 error;已有終態不覆蓋。
ST=$(aws s3 cp "s3://$BUCKET/$PREFIX/status.json" - 2>/dev/null | jq -r '.state // empty')
if [ "$ST" = "running" ] || [ -z "$ST" ]; then writestatus error "runner exited without a result (see runner.log)" 0; fi
uplog

selfterm
