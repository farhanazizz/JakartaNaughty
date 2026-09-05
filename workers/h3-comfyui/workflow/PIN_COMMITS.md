# PIN_COMMITS — custom node packs for minimax_h3_r2v_api_linear

Pinned: 2026-09-05 (UTC) via `git ls-remote` against default branch HEAD.
Vast lab dump (`/tmp/vast-49930897-*`) has extension/object_info inventories but **no** `custom_nodes/*/.git` trees, so no lab commit SHAs were available — all pins are GitHub HEAD (not "from Vast lab").

Repos: pack names / `clone_dir` match Vast `python_module` folder casing (see `class_types_required.md`). Repo GitHub names may differ in case (e.g. `ComfyUI-Easy-Use` → install as `comfyui-easy-use`).

| pack | repo URL | commit (full SHA) | short SHA | branch/tag | pin source |
|---|---|---|---|---|---|
| `ComfyUI-VFI` | https://github.com/GACLove/ComfyUI-VFI | `6176a430f12cd16003f4664c1e3c6af8e96cc3c6` | `6176a430` | main (no tags) | GitHub HEAD 2026-09-05 |
| `Comfyui_Minimax_h3_latent_Upscaler` | https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler | `d7c01b9011f2e8439493f6c02c29995a27df276f` | `d7c01b90` | main (no tags) | GitHub HEAD 2026-09-05 |
| `comfyui-easy-use` | https://github.com/yolain/ComfyUI-Easy-Use | `271685698b0935c5b0ecca86a58c3817931cd205` | `27168569` | main / tag v1.4.1 (HEAD == tag) | GitHub HEAD 2026-09-05 (= v1.4.1) |
| `comfyui-kjnodes` | https://github.com/kijai/ComfyUI-KJNodes | `e8e88f7c88e3f6205b122f5de87e69a09fbce5ac` | `e8e88f7c` | main (no tags) | GitHub HEAD 2026-09-05 |
| `comfyui-obvpm` | https://github.com/obvpm/comfyui-obvpm | `7d5b977add00c2fb9690dca9a5f20023a47c8a80` | `7d5b977a` | main (no tags) | GitHub HEAD 2026-09-05 |
| `comfyui-videohelpersuite` | https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite | `4d907bee61e92c2e65af3bd6383a4e4d356126d1` | `4d907bee` | main (no tags) | GitHub HEAD 2026-09-05 |
| `h3-optimizations` | https://github.com/Zironic/H3-Optimizations | `379f9c7922b3d7831dd93ae069ba0cb82cb4cf36` | `379f9c79` | main (no tags) | GitHub HEAD 2026-09-05 |
| `h3-prompt-ide` | https://github.com/ethanfel/ComfyUI-H3-Prompt-IDE | `9368c6869ec7bbec519baa4a0c9433f55ac9948d` | `9368c686` | main (no tags) | GitHub HEAD 2026-09-05 |

## Recommended clone (pin SHA, match Vast folder name)

```bash
CN="$COMFYUI/custom_nodes"
git clone https://github.com/GACLove/ComfyUI-VFI.git "$CN/ComfyUI-VFI"
git -C "$CN/ComfyUI-VFI" checkout -q 6176a430f12cd16003f4664c1e3c6af8e96cc3c6
git clone https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git "$CN/Comfyui_Minimax_h3_latent_Upscaler"
git -C "$CN/Comfyui_Minimax_h3_latent_Upscaler" checkout -q d7c01b9011f2e8439493f6c02c29995a27df276f
git clone https://github.com/yolain/ComfyUI-Easy-Use.git "$CN/comfyui-easy-use"
git -C "$CN/comfyui-easy-use" checkout -q 271685698b0935c5b0ecca86a58c3817931cd205
git clone https://github.com/kijai/ComfyUI-KJNodes.git "$CN/comfyui-kjnodes"
git -C "$CN/comfyui-kjnodes" checkout -q e8e88f7c88e3f6205b122f5de87e69a09fbce5ac
git clone https://github.com/obvpm/comfyui-obvpm.git "$CN/comfyui-obvpm"
git -C "$CN/comfyui-obvpm" checkout -q 7d5b977add00c2fb9690dca9a5f20023a47c8a80
git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git "$CN/comfyui-videohelpersuite"
git -C "$CN/comfyui-videohelpersuite" checkout -q 4d907bee61e92c2e65af3bd6383a4e4d356126d1
git clone https://github.com/Zironic/H3-Optimizations.git "$CN/h3-optimizations"
git -C "$CN/h3-optimizations" checkout -q 379f9c7922b3d7831dd93ae069ba0cb82cb4cf36
git clone https://github.com/ethanfel/ComfyUI-H3-Prompt-IDE.git "$CN/h3-prompt-ide"
git -C "$CN/h3-prompt-ide" checkout -q 9368c6869ec7bbec519baa4a0c9433f55ac9948d
```

## Short SHA quick list

- `ComfyUI-VFI` → `6176a430`
- `Comfyui_Minimax_h3_latent_Upscaler` → `d7c01b90`
- `comfyui-easy-use` → `27168569`
- `comfyui-kjnodes` → `e8e88f7c`
- `comfyui-obvpm` → `7d5b977a`
- `comfyui-videohelpersuite` → `4d907bee`
- `h3-optimizations` → `379f9c79`
- `h3-prompt-ide` → `9368c686`

## Unresolved

None — all 8 repos resolved and HEADs fetched.

## Related

- Mode/scale mapper: [`MAPPER_mode_scale.md`](./MAPPER_mode_scale.md)
- Class types: [`class_types_required.md`](./class_types_required.md)


## Dockerfile drop-in

- Snippet: `DOCKERFILE_CUSTOM_NODES.snippet.Dockerfile`
- Applied to: `/workspace/h3-runpod/Dockerfile` (pinned clones; registry install removed for kjnodes/VHS)
- Registry target note: GHCR `farhanazizz/JakartaNaughty` (bukan Docker Hub)
