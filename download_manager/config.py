import os
from pathlib import Path

# Base model directories for the two GPU rental providers.
# These can be overridden by environment variables when running on the VM.
VAST_MODEL_ROOT = os.getenv("VAST_MODEL_ROOT", r"/workspace/ComfyUI/models")
RUNPOD_MODEL_ROOT = os.getenv("RUNPOD_MODEL_ROOT", r"/workspace/runpod-slim/ComfyUI/models")

def list_subfolders(base_path: str):
    """Return a list of immediate sub‑folder names under *base_path*.
    If the path does not exist or has no sub‑folders, an empty list is returned.
    """
    p = Path(base_path)
    if not p.is_dir():
        return []
    return [f.name for f in p.iterdir() if f.is_dir()]
