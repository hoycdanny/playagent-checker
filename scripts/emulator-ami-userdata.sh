#!/bin/bash
# 預裝 emulator 主機 AMI 的內容(由 scripts/build-emulator-ami.mjs 起一台機器執行)。
#
# 為什麼要這個 AMI:每個 emulator 任務的前置作業實測 2 分 18 秒,其中 apt 裝套件佔 80 秒、
# docker pull Redroid 佔 16 秒,而真正被測的 APK 下載加安裝只佔 10 秒。把固定的那部分
# 預先裝進 AMI,每次任務就省下約 1.5 分鐘的 EC2 時間(正式流程還多裝 imagemagick/ffmpeg
# 的 243 個相依套件,所以實際省更多)。
#
# ⚠ 安裝清單必須與 infra/lambda/engine/emulator-userdata.sh 一致。不一致的話任務端
# 仍會重裝,AMI 就白做了 —— 而且不會有任何錯誤,只是慢回去。
#
# 做完會寫 /opt/playagent/prebaked(任務端據此跳過安裝)然後關機,讓建置腳本做 CreateImage。
set -x
export DEBIAN_FRONTEND=noninteractive

# 中和 unattended-upgrades:first-boot 裝核心後 reboot 會打斷這支腳本。
systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
pkill -9 -f unattended-upgrade 2>/dev/null || true
for i in $(seq 1 12); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; sleep 5; done
dpkg --configure -a 2>/dev/null || true

retry() { local n="$1"; shift; for i in $(seq 1 "$n"); do "$@" && return 0; sleep 5; done; return 1; }
for i in $(seq 1 30); do apt-get update -y && break; sleep 5; done

# --- 與 emulator-userdata.sh 相同的套件 ---
# zstd:per-app 快照的打包與還原用(見 docs/design/emulator-snapshot.md)。
retry 10 apt-get install -y jq unzip curl zstd docker.io android-tools-adb || exit 1
retry 10 apt-get install -y awscli || retry 10 snap install aws-cli --classic || true
# snap 的 aws 不在 cloud-init 的 PATH 裡。不補 symlink 的話任務端的 PREBAKED 偵測
# (command -v aws)會失敗,於是整個 AMI 的意義就沒了。
[ -x /snap/bin/aws ] && ln -sf /snap/bin/aws /usr/local/bin/aws
# 這 243 個相依套件是前置作業裡最大的一塊(舊 log 有 1222 行都在解壓它們)。
retry 10 apt-get install -y imagemagick ffmpeg || exit 1

# --- node(與 emulator-userdata.sh 同版本)---
# 任務端用 `command -v node` 加主版本檢查決定要不要下載,所以預裝好就會自動跳過。
NODE_V=v22.12.0
case "$(uname -m)" in aarch64) NARCH=arm64 ;; *) NARCH=x64 ;; esac
retry 5 curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-$NARCH.tar.xz" || exit 1
tar -xJf /tmp/node.tar.xz -C /opt
ln -sf "/opt/node-$NODE_V-linux-$NARCH/bin/node" /usr/local/bin/node
ln -sf "/opt/node-$NODE_V-linux-$NARCH/bin/npm" /usr/local/bin/npm
rm -f /tmp/node.tar.xz

# --- Redroid 映像(預設版本;任務選其他 Android 版本時仍會自己 pull)---
systemctl enable --now docker
retry 5 docker pull redroid/redroid:15.0.0-latest || exit 1

# --- binder 自檢(只記錄,不阻斷)---
# 實測 7.0.0-1014-aws 這個核心沒有可安裝的 linux-modules-extra,但 binder 是內建的。
# AMI 的核心與任務開機時的核心相同,所以這裡的結果有參考價值。
modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || true
mkdir -p /dev/binderfs
mount -t binder binder /dev/binderfs 2>/dev/null || true
BINDER=no
mountpoint -q /dev/binderfs && BINDER=binderfs
[ -e /dev/binder ] && BINDER="${BINDER},dev"

# --- 標記 ---
mkdir -p /opt/playagent
{
  echo "builtAt=$(date -u +%FT%TZ)"
  echo "kernel=$(uname -r)"
  echo "arch=$(uname -m)"
  echo "node=$(node -v 2>/dev/null)"
  echo "docker=$(docker --version 2>/dev/null)"
  echo "aws=$(command -v aws)"
  echo "magick=$(command -v convert)"
  echo "ffmpeg=$(command -v ffmpeg)"
  echo "redroid=$(docker image inspect redroid/redroid:15.0.0-latest --format '{{.Id}}' 2>/dev/null)"
  echo "binder=$BINDER"
} > /opt/playagent/prebaked
cat /opt/playagent/prebaked

# --- 清理,讓 AMI 乾淨 ---
apt-get clean
rm -rf /var/lib/apt/lists/*
# cloud-init clean 不能省:cloud-init 預設只在「首次開機」跑 userdata,不清的話
# 從這個 AMI 起的實例會直接跳過任務的 userdata,主機起來什麼都不做。
cloud-init clean --logs 2>/dev/null || rm -rf /var/lib/cloud/instances /var/lib/cloud/sem
sync
poweroff
