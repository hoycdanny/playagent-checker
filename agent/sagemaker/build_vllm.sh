#!/bin/bash
# 建 + 推 UI-TARS 用的 vLLM BYOC 容器到 ECR。移植自 game-ai-qa/vendor/sagemaker-deploy/docker/build_vllm.sh。
# 用法:AWS_REGION=us-east-2 ./build_vllm.sh
set -e

# 從本腳本所在目錄執行,COPY 路徑(vllm_server.py / serve.sh)才對。
cd "$(dirname "$0")"

REPO_NAME="${IMAGE_REPO:-playagent-vllm-byoc}"
REGION="${AWS_REGION:-us-east-2}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO_NAME}:latest"

echo "Building vLLM BYOC container (UI-TARS)..."
echo "Account: ${ACCOUNT_ID}"
echo "Region:  ${REGION}"
echo "Image:   ${IMAGE_URI}"

# ECR repo 不存在就建。
aws ecr describe-repositories --repository-names "${REPO_NAME}" --region "${REGION}" 2>/dev/null \
  || aws ecr create-repository --repository-name "${REPO_NAME}" --region "${REGION}" --image-scanning-configuration scanOnPush=true

# 登入 ECR。
aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# arm64 宿主機(如 Apple Silicon)build linux/amd64 需要 QEMU,否則 build 階段 "exec format error"。
if [ "$(uname -m)" != "x86_64" ] && [ "$(uname -m)" != "amd64" ]; then
  echo "本機非 x86_64,註冊 QEMU binfmt(amd64)..."
  docker run --privileged --rm tonistiigi/binfmt --install amd64
fi

# --provenance=false + oci-mediatypes=false:SageMaker CreateModel 只認 Docker v2 manifest,
# 不加會報 "Unsupported manifest media type application/vnd.oci.image.manifest.v1+json"。
docker buildx build --platform linux/amd64 --provenance=false \
  -f Dockerfile.vllm \
  --output type=image,name="${IMAGE_URI}",push=true,oci-mediatypes=false \
  .

echo "Done! Image URI: ${IMAGE_URI}"
