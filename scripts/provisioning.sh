#!/bin/bash
# ============================================================
# Jakarta Naughty - ComfyUI Auto-Provisioning Script
# Version: ComfyUI v0.33.3 | Python 3.12 | CUDA 13.2
# ============================================================

set -e
echo "============================================================"
echo "🚀 [JAKARTA NAUGHTY] Memulai Otomasi Setup ComfyUI Studio..."
echo "============================================================"

# Ambil Token dari Environment Variable atau Argumen Script
HF_TOKEN="${HF_TOKEN:-$1}"
CIVITAI_TOKEN="${CIVITAI_TOKEN:-$2}"

if [ -z "$HF_TOKEN" ]; then
  echo "⚠️ [INFO] HF_TOKEN tidak diset di Environment Variable. Mencoba download publik..."
fi

# --- 1. Kunci Versi ComfyUI ke v0.33.3 (Optimal & Stabil) ---
echo "📌 [1/5] Memastikan ComfyUI terkunci di versi v0.33.3..."
cd /workspace/ComfyUI
git fetch --tags
git checkout v0.33.3 || git checkout -b locked_v0.33.3 v0.33.3 || true

# --- 2. Install Tools HuggingFace & Dependensi ---
echo "📦 [2/5] Menginstall HuggingFace Hub & Transfer Tools..."
pip install -q --no-cache-dir huggingface_hub hf_xet

# --- 3. Install Custom Nodes ---
echo "🧩 [3/5] Menginstall Custom Nodes..."
mkdir -p /workspace/ComfyUI/custom_nodes
cd /workspace/ComfyUI/custom_nodes

# A. ComfyUI-Pixaroma
if [ ! -d "ComfyUI-Pixaroma" ]; then
  echo "Cloning ComfyUI-Pixaroma..."
  git clone https://github.com/pixaroma/ComfyUI-Pixaroma.git
  if [ -f "ComfyUI-Pixaroma/requirements.txt" ]; then
    pip install -q --no-cache-dir -r ComfyUI-Pixaroma/requirements.txt
  fi
else
  echo "ComfyUI-Pixaroma sudah ada, melewati clone."
fi

# B. comfyui-krea2edit
if [ ! -d "comfyui-krea2edit" ]; then
  echo "Cloning comfyui-krea2edit..."
  git clone https://github.com/lbouaraba/comfyui-krea2edit.git
  if [ -f "comfyui-krea2edit/requirements.txt" ]; then
    pip install -q --no-cache-dir -r comfyui-krea2edit/requirements.txt
  fi
else
  echo "comfyui-krea2edit sudah ada, melewati clone."
fi

# C. ComfyUI-Krea2T-Enhancer
if [ ! -d "ComfyUI-Krea2T-Enhancer" ]; then
  echo "Cloning ComfyUI-Krea2T-Enhancer..."
  git clone https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer.git
  if [ -f "ComfyUI-Krea2T-Enhancer/requirements.txt" ]; then
    pip install -q --no-cache-dir -r ComfyUI-Krea2T-Enhancer/requirements.txt
  fi
else
  echo "ComfyUI-Krea2T-Enhancer sudah ada, melewati clone."
fi

# D. ComfyUI-Manager (Management Node)
if [ ! -d "ComfyUI-Manager" ]; then
  echo "Cloning ComfyUI-Manager..."
  git clone https://github.com/ltdrdata/ComfyUI-Manager.git
fi

# --- 4. Unduh 4 Model Inti ---
echo "📥 [4/5] Memeriksa & Mengunduh 4 Model Inti..."
export HF_XET_HIGH_PERFORMANCE=1

# Helper argument token untuk HuggingFace
HF_AUTH_ARG=""
if [ -n "$HF_TOKEN" ]; then
  HF_AUTH_ARG="--token ${HF_TOKEN}"
fi

# Helper URL token untuk CivitAI
CIVITAI_URL_PARAM=""
if [ -n "$CIVITAI_TOKEN" ]; then
  CIVITAI_URL_PARAM="&token=${CIVITAI_TOKEN}"
fi

# A. Moody Krea2 Mix v7.0 BF16 (CivitAI)
mkdir -p /workspace/ComfyUI/models/diffusion_models
if [ ! -f "/workspace/ComfyUI/models/diffusion_models/moodyKrea2Mix_v70BF16.safetensors" ]; then
  echo "Unduh: moodyKrea2Mix_v70BF16.safetensors (CivitAI)..."
  wget -c -O "/workspace/ComfyUI/models/diffusion_models/moodyKrea2Mix_v70BF16.safetensors" \
    "https://civitai.red/api/download/models/3209040?fileId=3090705${CIVITAI_URL_PARAM}"
else
  echo "moodyKrea2Mix_v70BF16.safetensors sudah ada."
fi

# B. Qwen3-VL 4B Heretic CLIP Encoder (HuggingFace)
mkdir -p /workspace/ComfyUI/models/text_encoders
if [ ! -f "/workspace/ComfyUI/models/text_encoders/qwen3-vl-4b-heretic.safetensors" ]; then
  echo "Unduh: qwen3-vl-4b-heretic.safetensors (HuggingFace)..."
  hf download DreamFast/Qwen3-VL-4b-Heretic-ComfyUI qwen3-vl-4b-heretic.safetensors \
    --local-dir "/workspace/ComfyUI/models/text_encoders" \
    ${HF_AUTH_ARG}
else
  echo "qwen3-vl-4b-heretic.safetensors sudah ada."
fi

# C. Qwen Image VAE (HuggingFace)
mkdir -p /workspace/ComfyUI/models/vae
mkdir -p /workspace/ComfyUI/models/vae/vae
if [ ! -f "/workspace/ComfyUI/models/vae/qwen_image_vae.safetensors" ]; then
  echo "Unduh: qwen_image_vae.safetensors (HuggingFace)..."
  hf download Comfy-Org/Krea-2 vae/qwen_image_vae.safetensors \
    --local-dir "/workspace/ComfyUI/models/vae" \
    ${HF_AUTH_ARG}
else
  echo "qwen_image_vae.safetensors sudah ada."
fi
# Duplikasi path subfolder vae/ agar kompatibel dengan penamaan slot ComfyUI
if [ -f "/workspace/ComfyUI/models/vae/qwen_image_vae.safetensors" ] && [ ! -f "/workspace/ComfyUI/models/vae/vae/qwen_image_vae.safetensors" ]; then
  cp "/workspace/ComfyUI/models/vae/qwen_image_vae.safetensors" "/workspace/ComfyUI/models/vae/vae/qwen_image_vae.safetensors" 2>/dev/null || true
fi

# D. LoRA Identity Edit v1.2 (HuggingFace)
mkdir -p /workspace/ComfyUI/models/loras
if [ ! -f "/workspace/ComfyUI/models/loras/krea2_identity_edit_v1_2.safetensors" ]; then
  echo "Unduh: krea2_identity_edit_v1_2.safetensors (HuggingFace)..."
  hf download conradlocke/krea2-identity-edit krea2_identity_edit_v1_2.safetensors \
    --local-dir "/workspace/ComfyUI/models/loras" \
    ${HF_AUTH_ARG}
else
  echo "krea2_identity_edit_v1_2.safetensors sudah ada."
fi

# --- 5. Salin Default Workflow JSON ---
echo "📋 [5/5] Menyalin Workflow JSON ke direktori ComfyUI..."
mkdir -p "/workspace/ComfyUI/user/default/workflows"
curl -sL "https://raw.githubusercontent.com/farhanazizz/JakartaNaughty/main/src/config/workflow.json" \
  -o "/workspace/ComfyUI/user/default/workflows/Krea 2 + Edit Lora - kapake.json"

echo "============================================================"
echo "🎉 [SELESAI] ComfyUI v0.33.3 Studio Siap Digunakan 100%!"
echo "============================================================"
