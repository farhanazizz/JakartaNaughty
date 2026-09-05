# H3 RunPod Serverless Worker
# Base: runpod/worker-comfyui:5.10.0-base → ComfyUI 0.34.0 (MiniMax H3 native)
# Custom node SHAs pinned 2026-09-05 — see h3-api-linear/PIN_COMMITS.md
# Bake target: GHCR farhanazizz/JakartaNaughty (bukan Docker Hub)
# Jangan deploy sampai Asep bilang image/endpoint ready.

FROM runpod/worker-comfyui:5.10.0-base

ENV PIP_NO_INPUT=1 \
    PYTHONUNBUFFERED=1

WORKDIR /comfyui/custom_nodes

# 8 packs required by minimax_h3_r2v_api_linear — clone then checkout pin (no --depth 1)
# Folder names match python_module / Vast casing.
RUN set -eux; \
    git clone https://github.com/GACLove/ComfyUI-VFI.git ComfyUI-VFI && \
      git -C ComfyUI-VFI checkout -q 6176a430f12cd16003f4664c1e3c6af8e96cc3c6; \
    git clone https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git Comfyui_Minimax_h3_latent_Upscaler && \
      git -C Comfyui_Minimax_h3_latent_Upscaler checkout -q d7c01b9011f2e8439493f6c02c29995a27df276f; \
    git clone https://github.com/yolain/ComfyUI-Easy-Use.git comfyui-easy-use && \
      git -C comfyui-easy-use checkout -q 271685698b0935c5b0ecca86a58c3817931cd205; \
    git clone https://github.com/kijai/ComfyUI-KJNodes.git comfyui-kjnodes && \
      git -C comfyui-kjnodes checkout -q e8e88f7c88e3f6205b122f5de87e69a09fbce5ac; \
    git clone https://github.com/obvpm/comfyui-obvpm.git comfyui-obvpm && \
      git -C comfyui-obvpm checkout -q 7d5b977add00c2fb9690dca9a5f20023a47c8a80; \
    git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git comfyui-videohelpersuite && \
      git -C comfyui-videohelpersuite checkout -q 4d907bee61e92c2e65af3bd6383a4e4d356126d1; \
    git clone https://github.com/Zironic/H3-Optimizations.git h3-optimizations && \
      git -C h3-optimizations checkout -q 379f9c7922b3d7831dd93ae069ba0cb82cb4cf36; \
    git clone https://github.com/ethanfel/ComfyUI-H3-Prompt-IDE.git h3-prompt-ide && \
      git -C h3-prompt-ide checkout -q 9368c6869ec7bbec519baa4a0c9433f55ac9948d

WORKDIR /comfyui

# Per-node Python deps
RUN set -eux; \
    for r in /comfyui/custom_nodes/*/requirements.txt; do \
      if [ -f "$r" ]; then \
        echo "Installing deps from $r"; \
        uv pip install -r "$r" || pip install -r "$r"; \
      fi; \
    done

RUN mkdir -p \
      /comfyui/custom_nodes/ComfyUI-VFI/rife/train_log \
      /comfyui/models/rife

COPY extra_model_paths.yaml /comfyui/extra_model_paths.yaml
COPY start_wrapper.sh /start_wrapper.sh
RUN chmod +x /start_wrapper.sh

WORKDIR /
CMD ["/start_wrapper.sh"]
