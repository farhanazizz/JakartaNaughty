#!/usr/bin/env python3
"""Download official RIFEv4.26 flownet.pkl into ComfyUI-VFI paths (no curl)."""
import os
import urllib.request
import zipfile

URL = "https://huggingface.co/hzwer/RIFE/resolve/main/RIFEv4.26_0921.zip"
EXPECTED = 24636301
TMP = "/tmp/rife426"
ZIP_PATH = f"{TMP}/rife.zip"
PKL = f"{TMP}/RIFEv4.26_0921/flownet.pkl"
DESTS = [
    "/comfyui/models/rife/flownet.pkl",
    "/comfyui/custom_nodes/ComfyUI-VFI/rife/train_log/flownet.pkl",
]


def main() -> None:
    os.makedirs(TMP, exist_ok=True)
    print("downloading", URL)
    urllib.request.urlretrieve(URL, ZIP_PATH)
    with zipfile.ZipFile(ZIP_PATH) as zf:
        zf.extractall(TMP)
    assert os.path.isfile(PKL), PKL
    size = os.path.getsize(PKL)
    assert size == EXPECTED, f"size {size} != {EXPECTED}"
    data = open(PKL, "rb").read()
    for dst in DESTS:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as out:
            out.write(data)
        print("wrote", dst, size)


if __name__ == "__main__":
    main()
