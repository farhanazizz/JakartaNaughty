# H3 RunPod Serverless Worker

Custom `worker-comfyui` image for MiniMax **H3** workflows on RunPod Serverless.

| Item | Value |
|------|--------|
| Base image | `runpod/worker-comfyui:5.10.0-base` |
| ComfyUI (verified) | **0.34.0** — includes MiniMax H3 native nodes ([worker-comfyui 5.10.0 release](https://github.com/runpod-workers/worker-comfyui/releases/tag/5.10.0), [ComfyUI v0.34.0](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.34.0)) |
| Alt base tag | `runpod/worker-comfyui:5.10.0-base-cuda12.8.1` (same ComfyUI; explicit CUDA 12.8.1) |
| Network volume | `h3-models` → id **`yxvhr288kf`** (EU-RO-1) |
| Serverless mount | `/runpod-volume` → models at `/runpod-volume/models/...` |
| Compared to Krea | Krea uses `5.7.1-base`; H3 needs ≥ ComfyUI 0.34.x → use **5.10.0** |

> **Do not** push images or create paid endpoints from this package unless you intentionally bill the account. Files here are build/deploy *templates* only.

## Layout on the volume

```text
/runpod-volume/models/
  diffusion_models/
  text_encoders/
  vae/
  latent_upscale_models/
  vae_approx/
  rife/flownet.pkl          # required for ComfyUI-VFI / RIFE
```

`extra_model_paths.yaml` maps those folders (plus classic checkpoints/clip/unet/…) from `/runpod-volume`.

## Baked custom nodes

| Source | Install method |
|--------|----------------|
| [ComfyUI-H3-Prompt-IDE](https://github.com/ethanfel/ComfyUI-H3-Prompt-IDE) | `git clone` |
| [H3-Optimizations](https://github.com/Zironic/H3-Optimizations) | `git clone` |
| [Comfyui_Minimax_h3_latent_Upscaler](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler) | `git clone` |
| [ComfyUI-VFI](https://github.com/GACLove/ComfyUI-VFI) | `git clone` |
| [comfyui-obvpm](https://github.com/obvpm/comfyui-obvpm) | `git clone` |
| [WhatDreamsCost-ComfyUI](https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI) | `git clone` |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | `comfy-node-install comfyui-kjnodes` |
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | `comfy-node-install comfyui-videohelpersuite` |

Skipped (API-linear workflows): rgthree, Impact Pack, Easy-Use.

### RIFE `flownet.pkl`

`start_wrapper.sh` runs before `/start.sh` and symlinks (or copies):

- `/runpod-volume/models/rife/flownet.pkl`
  → `/comfyui/custom_nodes/ComfyUI-VFI/rife/train_log/flownet.pkl`
  → `/comfyui/models/rife/flownet.pkl`

Ensure `flownet.pkl` exists on the volume before the first RIFE job.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Bake custom nodes + paths + start wrapper |
| `extra_model_paths.yaml` | Volume → ComfyUI model folders |
| `start_wrapper.sh` | flownet symlink/copy, then `exec /start.sh` |
| `create_endpoint.json` | Example REST bodies (template + endpoint) |
| `README.md` | This doc |

## Build & push (Docker Hub)

```bash
cd /workspace/h3-runpod   # or your local checkout

export DOCKERHUB_USER=YOUR_DOCKERHUB_USER
export IMAGE_TAG=5.10.0

docker build -t "${DOCKERHUB_USER}/h3-runpod:${IMAGE_TAG}" .
docker login
docker push "${DOCKERHUB_USER}/h3-runpod:${IMAGE_TAG}"
```

Optional: pin the CUDA-explicit base by editing the `FROM` line to  
`runpod/worker-comfyui:5.10.0-base-cuda12.8.1`.

Build can take a long time (custom node clones + pip). Prefer a machine with enough disk (~20–40 GB free).

## Deploy on RunPod (manual / REST)

1. **Create serverless template** (`POST https://rest.runpod.io/v1/templates`)  
   See `create_endpoint.json` → `create_template.body`.  
   Set `imageName` to your pushed tag.  
   `volumeMountPath`: `/runpod-volume` (serverless convention).

2. **Create endpoint** (`POST https://rest.runpod.io/v1/endpoints`)  
   See `create_endpoint.json` → `create_endpoint.body`:
   - `gpuTypeIds`: `["NVIDIA GeForce RTX 5090"]`
   - `networkVolumeId`: `yxvhr288kf`
   - `dataCenterIds`: `["EU-RO-1"]` (must match the volume’s DC)
   - `workersMin`: `0` (scale-to-zero)
   - `workersMax`: adjust as needed
   - `idleTimeout`: `300` (seconds; useful for heavy H3 loads)

3. Attach the volume in the UI if you create the endpoint graphically:  
   **Advanced → Select Network Volume → h3-models**.

Example (after replacing placeholders — **creates billable resources**):

```bash
export RUNPOD_API_KEY=...
# 1) template — capture returned .id
# 2) endpoint — use that id as templateId
# Full payloads: create_endpoint.json
```

## Debug models not loading

Set endpoint env `NETWORK_VOLUME_DEBUG=true`, send any job, read worker logs. Confirm:

- `/runpod-volume` is mounted
- `/runpod-volume/models/...` has the expected files
- `/comfyui/extra_model_paths.yaml` is present

## Open risks / notes

1. **Comfy version** — Confirmed for this package: worker **5.10.0** → ComfyUI **0.34.0**. If RunPod retags `5.10.0-base` later, re-check the [releases page](https://github.com/runpod-workers/worker-comfyui/releases).
2. **Registry names** — Only KJNodes + VideoHelperSuite use `comfy-node-install`. H3-specific repos are git-cloned because they may lack registry IDs; build fails if a clone URL 404s or a registry name is wrong.
3. **Node requirements** — Some custom nodes may need extra system packages (e.g. OpenCV libs). Add `apt-get` lines to the Dockerfile if workers crash on import.
4. **5090 + CUDA** — Prefer `minCudaVersion: "12.8"` (or the cuda12.8.1 base tag) for Blackwell hosts.
5. **Volume DC lock** — Endpoint `dataCenterIds` must include `EU-RO-1` where `yxvhr288kf` lives.
6. **No rgthree/Impact/Easy-Use** — UI convenience nodes omitted; API-linear graphs only.
