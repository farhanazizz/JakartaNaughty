# RIFE flownet.pkl align (ComfyUI-VFI @ 6176a430)

**Smoke evidence:** `sha-10dc42d` attempt2 — `RIFEInterpolation` state_dict size mismatch.

## Root cause

Volume `yxvhr288kf` file at `models/rife/flownet.pkl` is **not** the checkpoint that matches ComfyUI-VFI's `IFNet_HDv3` (pin `6176a430`).

| tensor | volume (bad) | VFI model + official RIFEv4.26 |
|---|---|---|
| `block0.conv0.0.0.weight` | `[96, 23, 3, 3]` | `[96, 15, 3, 3]` |
| `block0.lastconv.0.weight` | `[192, 24, 4, 4]` | `[192, 52, 4, 4]` |
| `encode.cnn0.weight` | `[32, 3, 3, 3]` | `[16, 3, 3, 3]` |

Official match: **`https://huggingface.co/hzwer/RIFE/resolve/main/RIFEv4.26_0921.zip`** → `flownet.pkl` size **24636301** bytes (same pack VFI `download_rife.py` uses).

WebSocket/HTTP unreachable on full jobs is likely **secondary** (Comfy/worker crash or hang after RIFE load failure / long retry) — fix flownet first.

## Fix

1. **Image (Dockerfile):** bake official RIFEv4.26 `flownet.pkl` into `/comfyui/models/rife/flownet.pkl` + `ComfyUI-VFI/rife/train_log/`.
2. **start_wrapper.sh:** if volume file exists but size ≠ 24636301, **do not** symlink it; keep baked weights and log error.
3. **Volume ops (Asep):** replace `/runpod-volume/models/rife/flownet.pkl` with the RIFEv4.26 file (optional once image bake is enough).

## Verify

```bash
# on worker
stat -c%s /comfyui/models/rife/flownet.pkl   # expect 24636301
stat -c%s /runpod-volume/models/rife/flownet.pkl  # should match after replace
```

Smoke 480P with RIFE ON must pass `RIFEInterpolation` without state_dict size mismatch.
