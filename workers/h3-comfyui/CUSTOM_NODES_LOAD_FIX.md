# CUSTOM_NODES_LOAD_FIX — VHS / custom nodes not registering

**Date:** 2026-09-05 (Asia/Bangkok)  
**Image:** `ghcr.io/farhanazizz/h3-runpod:dev`  
**Smoke:** endpoint `aoezopejinqoyp` → `missing_node_type` `VHS_VideoCombine` (node #34) after Easy-Use/`easy seed` already fixed to INTConstant.

## Root cause (working)

1. **Launch venv is `/opt/venv`.** Upstream worker-comfyui (DR-1170): `start.sh` runs ComfyUI with `/opt/venv` python, not `/comfyui/.venv`. Custom-node `requirements.txt` installed with bare `uv pip`/`pip` without `--python /opt/venv/bin/python` can miss the launch venv → import errors when Comfy loads the pack → Comfy reports **missing_node_type** (same symptom as “not installed”).
2. **VHS depends on `opencv-python` + `imageio-ffmpeg`.** If those are absent in `/opt/venv`, VideoHelperSuite `__init__.py` fails during custom-node import and `VHS_VideoCombine` never appears in `object_info`.
3. **Easy-Use is a separate all-or-nothing import failure on Comfy 0.34** (`chainner_models` etc.). Dropped; seeds use `INTConstant`. Dropping Easy-Use alone does **not** fix VHS.
4. Branch Dockerfile on first GHCR bake still used floating/registry-unsafe patterns and Easy-Use; local SoT and GitHub branch had drifted.

## Fix in Dockerfile

- `PATH`/`VIRTUAL_ENV`/`UV_PYTHON` → `/opt/venv`
- Prefer `comfy-node-install comfyui-videohelpersuite comfyui-kjnodes` when present
- Fallback git clone + pin for VHS/KJNodes if registry path missing
- Pin-clone remaining H3 packs; **no Easy-Use**
- `uv pip install --python /opt/venv/bin/python -r requirements.txt` + explicit opencv/imageio-ffmpeg
- Build-time assert: VHS folder exists + cv2/imageio_ffmpeg import under `/opt/venv`

## Verify after rebuild

```bash
# On a worker / local run of the image:
python -c "import folder_paths"  # optional
# Or hit Comfy object_info and grep:
curl -s http://127.0.0.1:8188/object_info | jq 'keys[]' | grep VHS_VideoCombine
```

Smoke must show **no** `missing_node_type` for `VHS_VideoCombine`.
