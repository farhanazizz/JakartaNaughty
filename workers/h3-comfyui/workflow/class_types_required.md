# class_types_required — minimax_h3_r2v_api_linear

Generated: 2026-09-05 14:32 UTC+07:00
Total unique class_types: 29
Nodes in prompt: 40

## Unique class_type → pack

| class_type | custom_node pack | python_module |
|---|---|---|
| `BasicGuider` | ComfyUI core | `comfy_extras.nodes_custom_sampler` |
| `BasicScheduler` | ComfyUI core | `comfy_extras.nodes_custom_sampler` |
| `CLIPLoader` | ComfyUI core | `nodes` |
| `ComfyMathExpression` | ComfyUI core | `comfy_extras.nodes_math` |
| `H3PromptIDE` | h3-prompt-ide | `custom_nodes.h3-prompt-ide` |
| `H3PromptReferenceInputs` | h3-prompt-ide | `custom_nodes.h3-prompt-ide` |
| `H3SparseAttention` | h3-optimizations | `custom_nodes.h3-optimizations` |
| `INTConstant` | comfyui-kjnodes | `custom_nodes.comfyui-kjnodes` |
| `KSamplerSelect` | ComfyUI core | `comfy_extras.nodes_custom_sampler` |
| `LTXVConcatAVLatent` | ComfyUI core (LTX extras) | `comfy_extras.nodes_lt` |
| `LTXVSeparateAVLatent` | ComfyUI core (LTX extras) | `comfy_extras.nodes_lt` |
| `LoadImageCrop` | comfyui-obvpm | `custom_nodes.comfyui-obvpm` |
| `MiniMaxChunkFeedForward` | comfyui-kjnodes | `custom_nodes.comfyui-kjnodes` |
| `MiniMaxH3ReferenceToVideo` | ComfyUI core (MiniMax H3 extras) | `comfy_extras.nodes_minimax_h3` |
| `MiniMaxLowVRAMAttention` | comfyui-kjnodes | `custom_nodes.comfyui-kjnodes` |
| `MinimaxH3LatentUpscaler3D` | Comfyui_Minimax_h3_latent_Upscaler | `custom_nodes.Comfyui_Minimax_h3_latent_Upscaler` |
| `ModelAttentionBackend` | ComfyUI core | `comfy_extras.nodes_model_advanced` |
| `PrimitiveFloat` | ComfyUI core | `comfy_extras.nodes_primitive` |
| `RIFEInterpolation` | ComfyUI-VFI | `custom_nodes.ComfyUI-VFI` |
| `RandomNoise` | ComfyUI core | `comfy_extras.nodes_custom_sampler` |
| `ResolutionSelector` | ComfyUI core | `comfy_extras.nodes_resolution` |
| `SamplerCustomAdvanced` | ComfyUI core | `comfy_extras.nodes_custom_sampler` |
| `SimpleCalculatorKJ` | comfyui-kjnodes | `custom_nodes.comfyui-kjnodes` |
| `UNETLoader` | ComfyUI core | `nodes` |
| `VAEDecode` | ComfyUI core | `nodes` |
| `VAEDecodeAudio` | ComfyUI core | `comfy_extras.nodes_audio` |
| `VAELoader` | ComfyUI core | `nodes` |
| `VHS_VideoCombine` | comfyui-videohelpersuite | `custom_nodes.comfyui-videohelpersuite` |
| `easy seed` | comfyui-easy-use | `custom_nodes.comfyui-easy-use` |

## Packs required on RunPod H3 worker (non-core)

- **ComfyUI-VFI**
- **Comfyui_Minimax_h3_latent_Upscaler**
- **comfyui-easy-use**
- **comfyui-kjnodes**
- **comfyui-obvpm**
- **comfyui-videohelpersuite**
- **h3-optimizations**
- **h3-prompt-ide**

## Core / built-in (must be present in ComfyUI build)

- MiniMax H3 extras (`comfy_extras.nodes_minimax_h3`) — includes `MiniMaxH3ReferenceToVideo`
- Model advanced (`ModelAttentionBackend` with `comfy kitchen attention`)
- LTX AV latent helpers (`LTXVSeparateAVLatent`, `LTXVConcatAVLatent`)
- Custom sampler stack (`SamplerCustomAdvanced`, `BasicGuider`, `BasicScheduler`, `KSamplerSelect`, `RandomNoise`)
- `ResolutionSelector`, `PrimitiveFloat`, `ComfyMathExpression`, VAE/CLIP/UNET loaders

## Explicitly NOT required (stripped)

- rgthree-comfy (Fast Groups Bypasser, Any Switch, Power Lora Loader, Label)
- cg-use-everywhere (Anything Everywhere)
- comfyui-impact-pack (ImpactSwitch) — linearized away

## Fixed model filenames expected

| role | filename |
|---|---|
| UNET | `10Eros_Max_h3_TURBO-hybrid_beta4.safetensors` |
| CLIP / text encoder | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` |
| Video VAE | `vae/minimax_h3_video_vae_fp16.safetensors` |
| Audio VAE | `vae/minimax_h3_audio_vae_fp32.safetensors` |
| Latent upscaler 3D | `minimax_h3_latent_upscaler_3d_bf16.safetensors` |
| RIFE | `flownet.pkl` |


## Pinned commits & mapper

- Commit pins for the 8 non-core packs: [`PIN_COMMITS.md`](./PIN_COMMITS.md)
- RunPod `quality_upscale_x` → `prompt["243"]["inputs"]["mode.scale"]` (+ mirror `900`): [`MAPPER_mode_scale.md`](./MAPPER_mode_scale.md)

| pack | short SHA (GitHub HEAD 2026-09-05) |
|---|---|
| ComfyUI-VFI | `6176a430` |
| Comfyui_Minimax_h3_latent_Upscaler | `d7c01b90` |
| comfyui-easy-use | `27168569` (= v1.4.1) |
| comfyui-kjnodes | `e8e88f7c` |
| comfyui-obvpm | `7d5b977a` |
| comfyui-videohelpersuite | `4d907bee` |
| h3-optimizations | `379f9c79` |
| h3-prompt-ide | `9368c686` |
