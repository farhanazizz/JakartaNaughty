# H3 RunPod Serverless Worker
# Base: runpod/worker-comfyui:5.10.0-base → ComfyUI 0.34.0 (MiniMax H3 native)
# Pins: 2026-09-05 — see CUSTOM_NODES_LOAD_FIX.md
# Bake: GHCR ghcr.io/farhanazizz/h3-runpod:dev (Actions on feat/h3-runpod-worker)
#
# Critical: start.sh launches ComfyUI with /opt/venv — custom-node deps MUST land there
# (DR-1170). Easy-Use dropped (all-or-nothing import fail on 0.34; seeds = INTConstant).

FROM runpod/worker-comfyui:5.10.0-base

ENV PIP_NO_INPUT=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    VIRTUAL_ENV=/opt/venv \
    UV_PYTHON=/opt/venv/bin/python

# ---------------------------------------------------------------------------
# Registry packs first (preferred for VHS + KJNodes) — installs into worker paths
# ---------------------------------------------------------------------------
WORKDIR /comfyui
RUN set -eux; \
    if command -v comfy-node-install >/dev/null 2>&1; then \
      comfy-node-install comfyui-videohelpersuite comfyui-kjnodes; \
    else \
      echo "comfy-node-install missing — fallback git clone below"; \
    fi

# ---------------------------------------------------------------------------
# Non-registry / pin-required packs (canonical clone dirs)
# ---------------------------------------------------------------------------
WORKDIR /comfyui/custom_nodes
RUN set -eux; \
    # Ensure VHS + KJNodes exist even if registry install was a no-op / wrong path
    if [ ! -d ComfyUI-VideoHelperSuite ] && [ ! -d comfyui-videohelpersuite ]; then \
      git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git ComfyUI-VideoHelperSuite && \
        git -C ComfyUI-VideoHelperSuite checkout -q 4d907bee61e92c2e65af3bd6383a4e4d356126d1; \
    fi; \
    if [ ! -d ComfyUI-KJNodes ] && [ ! -d comfyui-kjnodes ]; then \
      git clone https://github.com/kijai/ComfyUI-KJNodes.git ComfyUI-KJNodes && \
        git -C ComfyUI-KJNodes checkout -q e8e88f7c88e3f6205b122f5de87e69a09fbce5ac; \
    fi; \
    git clone https://github.com/GACLove/ComfyUI-VFI.git ComfyUI-VFI && \
      git -C ComfyUI-VFI checkout -q 6176a430f12cd16003f4664c1e3c6af8e96cc3c6; \
    git clone https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git Comfyui_Minimax_h3_latent_Upscaler && \
      git -C Comfyui_Minimax_h3_latent_Upscaler checkout -q d7c01b9011f2e8439493f6c02c29995a27df276f; \
    git clone https://github.com/obvpm/comfyui-obvpm.git comfyui-obvpm && \
      git -C comfyui-obvpm checkout -q 7d5b977add00c2fb9690dca9a5f20023a47c8a80; \
    git clone https://github.com/Zironic/H3-Optimizations.git h3-optimizations && \
      git -C h3-optimizations checkout -q 379f9c7922b3d7831dd93ae069ba0cb82cb4cf36; \
    git clone https://github.com/ethanfel/ComfyUI-H3-Prompt-IDE.git h3-prompt-ide && \
      git -C h3-prompt-ide checkout -q 9368c6869ec7bbec519baa4a0c9433f55ac9948d

# ---------------------------------------------------------------------------
# Deps into /opt/venv (launch venv) — never bare pip without UV_PYTHON
# ---------------------------------------------------------------------------
WORKDIR /comfyui
RUN set -eux; \
    /opt/venv/bin/python -c "import sys; print(sys.prefix)"; \
    for r in /comfyui/custom_nodes/*/requirements.txt; do \
      if [ -f "$r" ]; then \
        echo "Installing deps from $r into /opt/venv"; \
        uv pip install --python /opt/venv/bin/python -r "$r"; \
      fi; \
    done; \
    # VHS hard deps (explicit — import fail = missing_node_type)
    uv pip install --python /opt/venv/bin/python opencv-python imageio-ffmpeg

RUN mkdir -p \
      /comfyui/custom_nodes/ComfyUI-VFI/rife/train_log \
      /comfyui/models/rife

# Bake official RIFEv4.26 flownet via python urllib (base image has no curl).
# Wrong volume checkpoints (23-ch IFNet) cause state_dict size mismatch at RIFEInterpolation.
COPY bake_rife_flownet.py /tmp/bake_rife_flownet.py
RUN set -eux; \
    mkdir -p /comfyui/custom_nodes/ComfyUI-VFI/rife/train_log /comfyui/models/rife; \
    python3 /tmp/bake_rife_flownet.py; \
    rm -f /tmp/bake_rife_flownet.py; \
    test "$(stat -c%s /comfyui/models/rife/flownet.pkl)" = "24636301"


COPY extra_model_paths.yaml /comfyui/extra_model_paths.yaml
COPY start_wrapper.sh /start_wrapper.sh
RUN chmod +x /start_wrapper.sh

# H3: collect VHS MP4 from history gifs/videos (stock handler only reads images)
COPY handler.py /handler.py


WORKDIR /
CMD ["/start_wrapper.sh"]
