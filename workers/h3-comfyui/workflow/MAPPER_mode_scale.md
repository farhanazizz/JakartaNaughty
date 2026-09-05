# MAPPER_mode_scale — quality_upscale_x → node 243 `mode.scale`

Verified against `/workspace/h3-api-linear/minimax_h3_r2v_api_linear.json` and `minimax_h3_r2v_api_prompt_only.json` (Python check: nodes **243** and **900** both present).

## Contract

| API logical key | JSON path | type | values |
|---|---|---|---|
| `quality_upscale_x` | `prompt["243"]["inputs"]["mode.scale"]` | int or float | **1** = 480P tier, **2** = 960P tier |
| (documentary mirror) | `prompt["900"]["inputs"]["value"]` | int | same 1 or 2 **if node 900 exists** |

Also keep `prompt["243"]["inputs"]["mode"]` = `"scale by multiplier"` (DYNAMICCOMBO key). Nested widget field is serialized as **`mode.scale`** (dot name), not a separate linked input.

## Widget-only (not linkable)

`MinimaxH3LatentUpscaler3D` exposes `mode` as `COMFY_DYNAMICCOMBO_V3`. Under option `"scale by multiplier"`, child input `scale` (FLOAT, default 2.0, min 1.0, max 4.0) becomes API key **`mode.scale`**.

- It is a **widget value** on the node, not a COMFy link socket.
- Node **900** (`INTConstant`, title `API quality_upscale_x`) is **not wired** into 243 (`links to 243? False`). It is a documentary/mirror constant for humans and mappers — set both when patching.

## Exact snippets (linear API)

From `minimax_h3_r2v_api_linear.json` → `prompt`:

```json
"243": {
  "inputs": {
    "model_name": "minimax_h3_latent_upscaler_3d_bf16.safetensors",
    "mode": "scale by multiplier",
    "mode.scale": 1,
    "align": 32,
    "enable_temporal_chunking": true,
    "force_unload": false,
    "device": "cuda",
    "precision": "fp16",
    "latent": ["242", 0]
  },
  "class_type": "MinimaxH3LatentUpscaler3D",
  "_meta": {
    "title": "Latent Upscale — API: mode.scale=1 (480P) or 2 (960P)"
  }
}
```

```json
"900": {
  "class_type": "INTConstant",
  "inputs": {
    "value": 1
  },
  "_meta": {
    "title": "API quality_upscale_x (1=480P, 2=960P) — also set node 243 mode.scale to match"
  }
}
```

Same paths exist in `minimax_h3_r2v_api_prompt_only.json` (top-level node map, no `prompt` wrapper):

- `["243"]["inputs"]["mode.scale"]`
- `["900"]["inputs"]["value"]`

For raw Comfy `/prompt` POST using the wrapped file, paths are under the `prompt` key as above.

## Mapper pseudocode (RunPod)

```python
def apply_quality_upscale_x(prompt: dict, quality_upscale_x: int) -> None:
    """quality_upscale_x: 1 → 480P, 2 → 960P. Accepts int or float."""
    x = int(quality_upscale_x)
    if x not in (1, 2):
        raise ValueError(f"quality_upscale_x must be 1 or 2, got {quality_upscale_x!r}")

    # primary: widget field on MinimaxH3LatentUpscaler3D
    n243 = prompt["243"]["inputs"]
    n243["mode"] = "scale by multiplier"
    n243["mode.scale"] = x  # int OK; float 1.0/2.0 also accepted by node

    # mirror documentary INTConstant if present
    if "900" in prompt:
        prompt["900"]["inputs"]["value"] = x

# examples
# 480P:
#   apply_quality_upscale_x(prompt, 1)
# 960P:
#   apply_quality_upscale_x(prompt, 2)
```

Wrapped linear document:

```python
doc = json.load(open("minimax_h3_r2v_api_linear.json"))
apply_quality_upscale_x(doc["prompt"], 2)  # 960P
# POST {"prompt": doc["prompt"]}
```

## Notes

- Linear default is **1** (480P baseline; matches successful job `73cf0c35`).
- Raw/experimental job `4ddf82d0` used `mode.scale=1.7` (float); RunPod mapper should stick to **1|2** only unless product explicitly allows intermediate scales.
- Base canvas remains `ResolutionSelector` megapixels **0.4**; tier is the latent upscale multiplier, not the ResolutionSelector.
