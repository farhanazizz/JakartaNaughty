# Handler: collect VHS MP4 (`gifs`)

## Smoke evidence (`sha-fed2333` job `9bbb711f…`)
- COMPLETED in **7837 ms** with `{images:[], status: success_no_images}`, no MP4.
- Workflow includes `VHS_VideoCombine` (#34) + RIFE (#165).

## Root cause (handler)
Stock `runpod/worker-comfyui` handler only collects history `outputs[*].images`.
`VHS_VideoCombine` writes MP4 under **`outputs[*].gifs`** (confirmed on Vast history), e.g.:
```json
"34": { "gifs": [{ "filename": "…-audio.mp4", "type": "output", "format": "video/h264-mp4" }] }
```
Handler logs `unhandled output keys: ['gifs']` and returns `success_no_images`.

**SaveVideo** is optional; not required if handler collects `gifs`.

## ~8s runtime
Too fast for real MiniMax-H3 480P+RIFE (minutes). Possible: Comfy finished with empty/partial outputs, or worker never ran the heavy graph. Handler bug alone can hide a real MP4 if one existed — but 8s still suggests verify worker Comfy `/history` for that prompt_id (node 34 `gifs` present? timing?). After handler patch, re-smoke once; if still ~8s + empty, dig Comfy execution logs (not more spam jobs until logs checked).

## Fix
- `workers/h3-comfyui/handler.py` — collect `gifs` + `videos`, return `videos[]` for mp4.
- Dockerfile `COPY handler.py /handler.py` over stock handler.
