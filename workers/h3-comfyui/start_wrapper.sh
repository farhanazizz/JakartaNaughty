#!/usr/bin/env bash
# Ensure RIFE flownet.pkl is where ComfyUI-VFI looks, then start the stock worker.
set -euo pipefail

VOLUME_FLOWNET="/runpod-volume/models/rife/flownet.pkl"
VFI_DIR="/comfyui/custom_nodes/ComfyUI-VFI/rife/train_log"
VFI_FLOWNET="${VFI_DIR}/flownet.pkl"
MODELS_RIFE_DIR="/comfyui/models/rife"
MODELS_RIFE_FLOWNET="${MODELS_RIFE_DIR}/flownet.pkl"

mkdir -p "${VFI_DIR}" "${MODELS_RIFE_DIR}"

link_or_copy() {
  local src="$1"
  local dst="$2"
  if [ -e "${dst}" ] || [ -L "${dst}" ]; then
    echo "h3-runpod: already present: ${dst}"
    return 0
  fi
  # Prefer symlink (cheap); fall back to copy if symlink fails (e.g. cross-fs quirks)
  if ln -sfn "${src}" "${dst}" 2>/dev/null; then
    echo "h3-runpod: symlinked ${dst} -> ${src}"
  else
    cp -f "${src}" "${dst}"
    echo "h3-runpod: copied ${src} -> ${dst}"
  fi
}

if [ -f "${VOLUME_FLOWNET}" ]; then
  link_or_copy "${VOLUME_FLOWNET}" "${VFI_FLOWNET}"
  link_or_copy "${VOLUME_FLOWNET}" "${MODELS_RIFE_FLOWNET}"
else
  echo "h3-runpod: WARNING — ${VOLUME_FLOWNET} not found."
  echo "h3-runpod: Place flownet.pkl on the network volume at models/rife/flownet.pkl"
  echo "h3-runpod: (ComfyUI-VFI also accepts models/rife/ or ComfyUI-VFI/rife/train_log/)."
fi

exec /start.sh
