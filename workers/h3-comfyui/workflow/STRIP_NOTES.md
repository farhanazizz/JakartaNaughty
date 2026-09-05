# STRIP_NOTES — minimaxSEEDHUNTERWorkflow_v15 → linear API

Generated: 2026-09-05 14:32 UTC+07:00

## Sources

- UI graph: `/tmp/vast-49930897-inventory/minimaxSEEDHUNTERWorkflow_v15.json` (126 nodes, 179 links)
- Successful job API prompt: `/tmp/job-4ddf82d0/raw.json` + `/workspace/h3-job-73cf0c35/history.json` (57 nodes each)
- Prior attempt `/tmp/api_minimax_h3_r2v.json` was a different Hailuo cloud node path — **not reused** (wrong class_types)

## Node counts

| stage | nodes |
|---|---|
| UI workflow v15 | 126 |
| Executed job prompt (with switches/AE/LoRA empty) | 57 |
| **Linear API output** | **40** |

## Removed / resolved

### UI-only / rgthree / Everywhere
- All `Fast Groups Bypasser (rgthree)` (never in job API prompt; UI-only)
- All `Label (rgthree)`, `MarkdownNote`, `Note`, preview pickers, `PreviewAnimation`
- `Anything Everywhere` (node 107) — inputs already explicit in job graph; node deleted
- `Any Switch (rgthree)` ×7 — resolved to active branch from successful run:
  - Target FPS → PrimitiveFloat 48 (RIFE ON)
  - Final video → VAEDecode upscale path (189)
  - Final audio → VAEDecodeAudio upscale path (190)
  - Save output → hardcode `true`
  - Latent/select switches → direct wire Sampler#1 denoised latent → AV separate
- `Power Lora Loader (rgthree)` (empty LoRA) — bypassed; Kitchen model (`196`) wires straight into first-pass guider/scheduler **and** `H3SparseAttention` for upscale pass
- `ImpactSwitch` (UPSCALE PASS ENABLED) — always take upscale path from Sampler#1
- `EmptyImage` failsafe + unused Default FPS 24
- Preview path: low `VHS_VideoCombine` (18) + its VAEDecode/VAEDecodeAudio — dropped (API keeps final only)

### Kept ON (ASEP)
- Kitchen attention: `ModelAttentionBackend` attention=`comfy kitchen attention`
- Sparse: `H3SparseAttention` on **upscale pass only** (matches source group label)
- Chunk: `MiniMaxChunkFeedForward` chunks=4
- LowVRAM: `MiniMaxLowVRAMAttention` head_chunks=4
- RIFE 24→48: `RIFEInterpolation` source_fps=24, target_fps=48, `flownet.pkl`
- LoRA: none (loader removed)
- Base `ResolutionSelector` megapixels=**0.4**, aspect_ratio API-settable
- Output: `VHS_VideoCombine` → MP4 h264 + audio, save_output=true

## 480P / 960P mapping

- Base canvas from `ResolutionSelector` @ **0.4 MP** (aspect from input).
- Quality tier = `MinimaxH3LatentUpscaler3D` input **`mode.scale`**:
  - **1** → 480P tier (identity-ish latent upscale; matches job `73cf0c35`)
  - **2** → 960P tier (2× latent upscale)
- Documentary `INTConstant` node **900** titled `API quality_upscale_x` — mirror the same 1|2 onto node `243` `mode.scale` (upscaler scale is a widget field, not a linkable input in this build).
- Job `4ddf82d0` had used `mode.scale=1.7` experimentally; linear default is **1** per ASEP 480P baseline.
- Upscale **refine sampler** (denoise≈0.4, sparse model, 8 steps) always runs after latent upscale — same as successful jobs with upscale pass enabled.

## API input keys (Comfy `/prompt`)

| logical key | node id | inputs key |
|---|---|---|
| prompt_text | 365 | prompt |
| ref_image_0 | 123 | image |
| ref_image_1 | 151 | image |
| ref_image_2 | 152 | image |
| aspect_ratio | 22:9 | aspect_ratio |
| megapixels | 22:9 | megapixels (default 0.4) |
| video_length_seconds | 22:23 | value |
| quality_upscale_x / 480|960 | 243 | mode.scale (1 or 2) |
| seed_base | 16 | seed |
| seed_upscale | 103 | seed |
| rife_target_fps | 168 | value (default 48) |

Output node: **34** (`VHS_VideoCombine`).

JSON shape: `{ "prompt": { node_id: { class_type, inputs, _meta } }, "_api_inputs": {...}, "_output_node": "34" }`.
For raw ComfyUI POST, send `{ "prompt": <contents of prompt key> }` (see also `minimax_h3_r2v_api_prompt_only.json`).

## Remaining risks / blockers

1. **10Eros UNET** — non-standard community/finetune name `10Eros_Max_h3_TURBO-hybrid_beta4.safetensors` must exist on the H3 worker `diffusion_models` (or configured UNET path); stock MiniMax UNET will behave differently.
2. **qwen3vl nvfp4** path must match worker layout (`text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`).
3. **Custom packs** must be installed: `h3-prompt-ide`, `h3-optimizations`, `Comfyui_Minimax_h3_latent_Upscaler`, `ComfyUI-VFI`, `comfyui-kjnodes` (chunk/lowvram/INTConstant), `comfyui-obvpm` (LoadImageCrop), `comfyui-videohelpersuite`, `comfyui-easy-use` (easy seed).
4. **Audio vs RIFE length** — RIFE doubles video frames 24→48; audio is decoded once from upscale latent and not time-stretched. Original workflow same behavior; A/V sync may need worker-side trim (`trim_to_audio` currently false).
5. **H3PromptIDE format** — expects structured H3 prompt + `H3PromptReferenceInputs`; plain text may work but quality depends on node implementation.
6. **Only 3 ref images** exposed — source UI supports up to 6 pictures + video/audio refs; extend nodes if multi-ref beyond 3 needed.
7. **mode.scale not linkable** — serverless mapper must patch widget `243.inputs["mode.scale"]` directly (node 900 is documentation aid only).
8. **No deploy done** — observation/build only under `/workspace` as requested.

## Active linear path (summary)

`LoadImageCrop×3` → `H3PromptReferenceInputs` → `H3PromptIDE` → `MiniMaxH3ReferenceToVideo` (w/h from ResolutionSelector 0.4MP, length from seconds×24 math)
→ model stack `UNET → Chunk → LowVRAM → Kitchen`
→ `SamplerCustomAdvanced` pass1 → `LTXVSeparateAVLatent` → `MinimaxH3LatentUpscaler3D` (×1/×2) → `LTXVConcatAVLatent`
→ Sparse-patched model → upscale `SamplerCustomAdvanced` → `VAEDecode` + `VAEDecodeAudio`
→ `RIFEInterpolation` 24→48 → `VHS_VideoCombine` MP4+audio.
