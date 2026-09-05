#!/usr/bin/env bash
# Ensure RIFE flownet.pkl matches ComfyUI-VFI IFNet (RIFEv4.26), then start stock worker.
set -euo pipefail

VOLUME_FLOWNET="/runpod-volume/models/rife/flownet.pkl"
VFI_DIR="/comfyui/custom_nodes/ComfyUI-VFI/rife/train_log"
VFI_FLOWNET="${VFI_DIR}/flownet.pkl"
MODELS_RIFE_DIR="/comfyui/models/rife"
MODELS_RIFE_FLOWNET="${MODELS_RIFE_DIR}/flownet.pkl"
# Official hzwer RIFEv4.26_0921 flownet.pkl (must match IFNet_HDv3 in ComfyUI-VFI)
EXPECTED_FLOWNET_BYTES=24636301

mkdir -p "${VFI_DIR}" "${MODELS_RIFE_DIR}"

link_or_copy() {
  local src="$1"
  local dst="$2"
  # Always refresh link/copy when forcing align
  rm -f "${dst}" 2>/dev/null || true
  if ln -sfn "${src}" "${dst}" 2>/dev/null; then
    echo "h3-runpod: symlinked ${dst} -> ${src}"
  else
    cp -f "${src}" "${dst}"
    echo "h3-runpod: copied ${src} -> ${dst}"
  fi
}

use_baked() {
  if [ -f "${MODELS_RIFE_FLOWNET}" ]; then
    echo "h3-runpod: using baked ${MODELS_RIFE_FLOWNET}"
    link_or_copy "${MODELS_RIFE_FLOWNET}" "${VFI_FLOWNET}"
  else
    echo "h3-runpod: ERROR — baked flownet missing at ${MODELS_RIFE_FLOWNET}"
  fi
}

if [ -f "${VOLUME_FLOWNET}" ]; then
  VOL_SIZE=$(stat -c%s "${VOLUME_FLOWNET}" 2>/dev/null || stat -f%z "${VOLUME_FLOWNET}")
  if [ "${VOL_SIZE}" = "${EXPECTED_FLOWNET_BYTES}" ]; then
    echo "h3-runpod: volume flownet size OK (${VOL_SIZE} bytes = RIFEv4.26)"
    link_or_copy "${VOLUME_FLOWNET}" "${VFI_FLOWNET}"
    link_or_copy "${VOLUME_FLOWNET}" "${MODELS_RIFE_FLOWNET}"
  else
    echo "h3-runpod: ERROR — volume flownet size mismatch: got ${VOL_SIZE}, expected ${EXPECTED_FLOWNET_BYTES} (RIFEv4.26)."
    echo "h3-runpod: Ignoring volume file (wrong RIFE arch causes state_dict size mismatch). Using baked weights."
    use_baked
  fi
else
  echo "h3-runpod: WARNING — ${VOLUME_FLOWNET} not found; using baked RIFEv4.26 if present."
  use_baked
fi

exec /start.sh
