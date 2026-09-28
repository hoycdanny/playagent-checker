#!/bin/bash
# CUDA forward compatibility:把 compat libs 前置,讓 vLLM v0.19.1 在較舊 NVIDIA driver 上也能跑。
if [ -d /usr/local/cuda/compat ]; then
    export LD_LIBRARY_PATH=/usr/local/cuda/compat:/usr/local/nvidia/lib:/usr/local/nvidia/lib64:${LD_LIBRARY_PATH}
fi
exec python3 /opt/ml/code/model.py "$@"
