"""SageMaker 用的通用 vLLM 推論 handler(UI-TARS-1.5-7B)。

移植自 game-ai-qa/vendor/sagemaker-deploy/inference/vllm_server.py。
自足檔案 —— 會被 COPY 進容器單獨執行,不 import 任何本專案套件。

契約:
  /ping        容器一啟動就回 200(讓 SageMaker 啟動健康檢查過關;vLLM 在背景非同步載入)
  /invocations vLLM 未就緒回 503,就緒後把 body 原樣轉發到內部 vLLM 的 /v1/chat/completions
環境變數(CreateModel 注入):
  SERVED_MODEL_NAME / MAX_MODEL_LEN / DTYPE / MODEL_TYPE(text|multimodal)/ QUANTIZATION(none|fp8|bitsandbytes)
"""

import logging
import os
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

sys.stdout.reconfigure(line_buffering=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

perf_logger = logging.getLogger("perf")
perf_logger.setLevel(logging.INFO)

vllm_process: subprocess.Popen[bytes] | None = None
# True 表示 vLLM 已通過 /health、可接 /invocations。
# 載入完成前 /ping 仍回 200,否則 SageMaker 預設 5 min 健康檢查會在載入完成前判失敗
# (7B 模型 + ~15GB 權重通常需要數分鐘)。
vllm_ready: bool = False

SERVED_MODEL_NAME = os.environ.get("SERVED_MODEL_NAME", "model")
MAX_MODEL_LEN = os.environ.get("MAX_MODEL_LEN", "4096")
DTYPE = os.environ.get("DTYPE", "auto")
MODEL_TYPE = os.environ.get("MODEL_TYPE", "text")  # text or multimodal
QUANTIZATION = os.environ.get("QUANTIZATION", "none")  # none, fp8, bitsandbytes

ALLOWED_QUANTIZATIONS = {"none", "fp8", "bitsandbytes"}


def start_vllm_server() -> bool:
    """啟動 vLLM OpenAI 相容 server,輪詢 /health 直到就緒(最多 1800s)。成功則設 vllm_ready=True。"""
    global vllm_process, vllm_ready

    if QUANTIZATION not in ALLOWED_QUANTIZATIONS:
        logger.error("Invalid QUANTIZATION %r. Must be one of: %s", QUANTIZATION, ALLOWED_QUANTIZATIONS)
        return False

    model_path = "/opt/ml/model"

    cmd = [
        "python3", "-m", "vllm.entrypoints.openai.api_server",
        "--model", model_path,
        "--served-model-name", SERVED_MODEL_NAME,
        "--max-model-len", MAX_MODEL_LEN,
        "--dtype", DTYPE,
        "--trust-remote-code",
        "--host", "127.0.0.1",
        "--port", "8000",
        "--tensor-parallel-size", "1",
        "--enable-chunked-prefill",
        "--enable-prefix-caching",
        "--gpu-memory-utilization", "0.95",
    ]

    if QUANTIZATION == "fp8":
        cmd.extend(["--quantization", "fp8"])
    elif QUANTIZATION == "bitsandbytes":
        cmd.extend(["--quantization", "bitsandbytes", "--load-format", "bitsandbytes"])

    # 多模態參數(僅 MODEL_TYPE=multimodal)。UI-TARS 是多模態,必須帶,否則 vLLM 按 text 啟動會 crash。
    if MODEL_TYPE == "multimodal":
        cmd.extend([
            "--allowed-local-media-path", "/",
            "--mm-encoder-tp-mode", "data",
            "--mm-processor-cache-type", "shm",
            "--mm-processor-kwargs",
            '{"size": {"shortest_edge": 12544, "longest_edge": 2000000}}',
            "--chat-template-content-format", "string",
            "--limit-mm-per-prompt", '{"image": 10}',
        ])

    env = os.environ.copy()
    env["VLLM_WORKER_MULTIPROC_METHOD"] = "spawn"

    logger.info("Starting vLLM server with config:")
    logger.info("  Model Name:    %s", SERVED_MODEL_NAME)
    logger.info("  Max Length:    %s", MAX_MODEL_LEN)
    logger.info("  Data Type:     %s", DTYPE)
    logger.info("  Quantization:  %s", QUANTIZATION)
    logger.info("  Model Type:    %s", MODEL_TYPE)
    logger.info("Command: %s", " ".join(cmd))

    vllm_process = subprocess.Popen(cmd, env=env)

    for attempt in range(360):
        if vllm_process.poll() is not None:
            logger.error("vLLM process exited prematurely with code %d", vllm_process.returncode)
            return False
        try:
            resp = httpx.get("http://127.0.0.1:8000/health", timeout=5)
            if resp.status_code == 200:
                logger.info("vLLM server ready after %d attempts (%ds)", attempt + 1, (attempt + 1) * 5)
                vllm_ready = True
                return True
        except (httpx.ConnectError, httpx.TimeoutException):
            pass  # server 還在起,預期
        except Exception:
            logger.exception("Unexpected error during vLLM health check")
        if attempt > 0 and attempt % 12 == 0:  # 每 60s heartbeat 便於 CloudWatch 觀察
            logger.info("Still waiting for vLLM... (%d/360, %ds elapsed)", attempt, attempt * 5)
        time.sleep(5)

    logger.error("vLLM server failed to start after 360 attempts (1800s)")
    return False


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """在背景執行緒起 vLLM,讓 uvicorn 立刻開始聽 /ping;/invocations 未就緒時回 503。"""

    def _worker() -> None:
        try:
            if not start_vllm_server():
                logger.error("vLLM startup failed — endpoint will return 503 on /invocations")
        except Exception:
            logger.exception("Unexpected error during vLLM startup")

    threading.Thread(target=_worker, daemon=True, name="vllm-startup").start()
    yield
    if vllm_process:
        vllm_process.terminate()


app = FastAPI(title="Universal vLLM Inference Server", lifespan=lifespan)


@app.get("/ping")
async def ping() -> Response:
    # 容器一啟動就 200 — 讓 SageMaker 通過啟動健康檢查;vLLM 背景非同步載入。
    return Response(status_code=200)


@app.post("/invocations")
async def invoke(request: Request) -> JSONResponse:
    if not vllm_ready:
        return JSONResponse(
            {"error": {"message": "vLLM is still loading the model — try again in a few seconds", "type": "service_loading"}},
            status_code=503,
        )
    try:
        data = await request.json()
    except Exception as exc:
        logger.error("Failed to parse request body: %s", exc)
        return JSONResponse(
            {"error": {"message": "Invalid JSON in request body", "type": "invalid_request_error"}},
            status_code=400,
        )

    timeout = httpx.Timeout(600.0, connect=60.0)
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post("http://127.0.0.1:8000/v1/chat/completions", json=data)
    except httpx.ConnectError:
        logger.error("vLLM server is unreachable — process may have crashed")
        return JSONResponse(
            {"error": {"message": "Inference engine unavailable", "type": "server_error"}},
            status_code=503,
        )
    except httpx.TimeoutException:
        logger.error("vLLM request timed out after 600s")
        return JSONResponse(
            {"error": {"message": "Inference request timed out", "type": "timeout_error"}},
            status_code=504,
        )

    vllm_elapsed = time.perf_counter() - start

    try:
        result = resp.json()
    except Exception as exc:
        logger.error("vLLM returned non-JSON response (status=%d): %s", resp.status_code, exc)
        return JSONResponse(
            {"error": {"message": "Inference engine returned invalid response", "type": "server_error"}},
            status_code=502,
        )

    if resp.status_code != 200:
        logger.warning("vLLM returned status %d: %s", resp.status_code, str(result)[:500])
        return JSONResponse(result, status_code=resp.status_code)

    usage = result.get("usage", {})
    prompt_tokens = usage.get("prompt_tokens", 0)
    completion_tokens = usage.get("completion_tokens", 0)
    tok_s = round(completion_tokens / vllm_elapsed, 1) if vllm_elapsed > 0 else 0

    result["_perf"] = {
        "vllm_s": round(vllm_elapsed, 3),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "tok_s": tok_s,
        "quantization": QUANTIZATION,
    }
    perf_logger.info(
        "perf | vllm=%.3fs prompt=%d completion=%d tok/s=%.1f quant=%s",
        vllm_elapsed, prompt_tokens, completion_tokens, tok_s, QUANTIZATION,
    )

    return JSONResponse(result)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
