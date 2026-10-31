#!/bin/bash
# 每任務 Redroid 主機的 **引導**。只做一件事:把主體腳本從 S3 拉下來接手。
#
# 為什麼要拆:EC2 userdata 有 16 KB 硬上限,而這支腳本曾經長到只剩 583 bytes 可用。
# per-app 快照的還原/打包/失效判斷再加進去就會超過,而超過的症狀很糟 —— RunInstances
# 直接被拒,或腳本被截斷後在主機上語法錯誤(兩種都不會明確告訴你「太長了」)。
# 主體改放 S3(_engine/emulator/run.sh,CDK 的 BucketDeployment 部署)之後沒有這個限制。
#
# ⚠ 行尾必須 LF;長度需 < 16384 原始位元組。
exec > >(tee /var/log/emulator-bootstrap.log) 2>&1
# 每行 trace 帶 UTC 時間:前置作業(apt / docker pull / APK 安裝)各段實際花多久。
# 沒有這個就只能靠 log 行數反推,而行數不等於時間 —— 要優化哪一段得先量得到。
export PS4='+[$(date -u +%H:%M:%S)] '
set -x
export DEBIAN_FRONTEND=noninteractive

# --- 0. 中和 unattended-upgrades(防 first-boot 裝核心後 reboot 打斷)---
systemctl kill --signal=SIGKILL unattended-upgrades apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
pkill -9 -f unattended-upgrade 2>/dev/null || true
for i in $(seq 1 12); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; sleep 5; done
dpkg --configure -a 2>/dev/null || true
apt-get -y --fix-broken install 2>/dev/null || true

# --- 1. 引導只需要 aws / jq / curl;其餘套件由主體腳本處理 ---
# 預裝 AMI(scripts/build-emulator-ami.mjs 產出)已經有這些。不只看標記檔、還要驗工具
# 真的在:半殘的 AMI 比沒有 AMI 更難查。
PREBAKED=0
[ -f /opt/playagent/prebaked ] && command -v aws >/dev/null 2>&1 \
  && command -v jq >/dev/null 2>&1 && command -v docker >/dev/null 2>&1 && PREBAKED=1
echo "prebaked=$PREBAKED"
if [ "$PREBAKED" = 0 ]; then
  for i in $(seq 1 30); do apt-get update -y && break; sleep 5; done
  for i in $(seq 1 10); do apt-get install -y jq unzip curl zstd && break; sleep 5; done
  for i in $(seq 1 10); do apt-get install -y awscli && break; sleep 5; done
  # noble 的部分鏡像沒有 awscli 的 deb,退回 snap。snap 的 aws 不在 cloud-init 的 PATH
  # 裡,所以要補 symlink,否則後面所有 aws 呼叫都會失敗。
  command -v aws >/dev/null 2>&1 || snap install aws-cli --classic || true
  [ -x /snap/bin/aws ] && ln -sf /snap/bin/aws /usr/local/bin/aws
fi

# --- 2. IMDSv2 讀 region 與 per-job tag(加重試等 tag 傳播)---
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
PREFIX="tenants/$TENANT_ID/jobs/$JOB_ID"

# --- 3. 取主體腳本並交棒 ---
# 拉不到就寫 error 再自我終結:靜默卡住是最難查的失敗,而使用者只會看到任務永遠在跑。
fetch_run() { for i in $(seq 1 5); do aws s3 cp "s3://$BUCKET/_engine/emulator/run.sh" /opt/pa-run.sh && return 0; sleep 5; done; return 1; }
if ! fetch_run; then
  printf '{"jobId":"%s","state":"error","message":"%s","steps":0,"updatedAt":"%s"}' \
    "$JOB_ID" "主機取不到執行腳本(_engine/emulator/run.sh);請確認部署是否完整" "$(date -u +%FT%TZ)" \
    | aws s3 cp - "s3://$BUCKET/$PREFIX/status.json" --content-type application/json 2>/dev/null || true
  aws s3 cp /var/log/emulator-bootstrap.log "s3://$BUCKET/$PREFIX/bootstrap.log" 2>/dev/null || true
  shutdown -h now
  exit 1
fi
chmod +x /opt/pa-run.sh
export AWS_DEFAULT_REGION IID JOB_ID TENANT_ID BUCKET PREFIX PREBAKED
# exec:主體接手同一個程序,所以上面的 log 重導向與 PS4 繼續有效。
exec /opt/pa-run.sh
