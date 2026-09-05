# Crash mid H3 on RTX 5090 serverless (~200s)

## Evidence
| Job | Image | Exec | Error |
|---|---|---|---|
| `e560e755…` | `sha-fb284fd` | **204s** | `ComfyUI HTTP unreachable during websocket reconnect` |
| `4b147635…` (attempt6) | `sha-10dc42d` | **198s** | same — and **RIFE was bypassed** |

So: **not RIFE/flownet-primary**. Comfy process dies ~3–3.5 min into the graph; handler then fails reconnect because HTTP is dead. Classic **OOM / process kill** (or rare disk-full). No worker stdout captured in smoke artifacts.

## Likely cause
API linear graph **always runs dual sampler**:
1. Pass1 `SamplerCustomAdvanced` (125:12)
2. Latent upscaler (even `mode.scale=1`) + **Pass2 refine** (135:26) + sparse attn
3. Then RIFE + VHS (fb284fd smoke)

Models: 10Eros UNET + Qwen3-VL 32B nvfp4 + dual VAE + upscaler stay hot. Inventaris target **24–48GB**; 5090 is 32GB — dual-pass H3 is at the edge. Attempt6 proves crash without RIFE.

Secondary risks:
- `containerDiskInGb: 40` may be tight for decoded frame dumps (less likely than VRAM)
- Template `volumeMountPath: /workspace` vs SoT `/runpod-volume` — models still loaded (job ran minutes); keep `/runpod-volume` consistent

## Recommended fix path (no spam)
1. **Smoke-lite workflow** (isolation): pass1 only → decode → VHS @24fps, **no** upscale refine, **no** RIFE, duration **3s**. File: `workflow_smoke_lite_pass1_no_rife.json`
2. Env on template: `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`
3. Bump `containerDiskInGb` → **80** (cheap insurance)
4. Optional: `force_unload=true` on upscaler when re-enabling pass2; RIFE `batch_size` 8→1–2
5. Only after lite goes green (COMPLETED + `videos[]` mp4), reintroduce RIFE then pass2

## Green light criteria for next smoke
- Pin image still `sha-fb284fd` (handler OK)
- Use **smoke-lite** workflow once
- If lite OK → handler+VHS proven; then escalate graph
- If lite still ~200s WS die → need RunPod worker logs / `dmesg` OOM; consider Comfy `--lowvram` flag via worker start env if available

**Do not** full 480P+RIFE+dual-pass until lite passes.
