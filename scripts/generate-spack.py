#!/usr/bin/env python3
import sys
import os
import json
import io
import zipfile
from PIL import Image

def to_static_webp(image_path: str, max_dim: int = 512) -> bytes:
    with Image.open(image_path) as img:
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
        else:
            img = img.convert("RGB")
        img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=85, method=6)
        return buf.getvalue()

def build_wastickers(out_zip_path: str, pack_name: str, image_paths: list[str]):
    safe_id = "".join(c for c in pack_name if c.isalnum()).lower() or "pack"
    manifest = {
        "identifier": f"com.allybot.{safe_id}",
        "name": pack_name,
        "publisher": "Allybot",
        "tray_image_file": "icon.png",
        "image_data_version": "1",
        "whatsapp_will_not_cache": False,
        "stickers": [
            {"image_file": f"{i:02d}.webp", "emojis": ["🙂"]}
            for i in range(len(image_paths))
        ]
    }

    stickers_webp = []
    for p in image_paths:
        try:
            stickers_webp.append(to_static_webp(p))
        except Exception as e:
            print(f"Skipping corrupt image {p}: {e}", file=sys.stderr)

    if not stickers_webp:
        raise ValueError("No valid stickers could be generated")

    with zipfile.ZipFile(out_zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))

        # Tray icon 96x96 from the first sticker
        with Image.open(io.BytesIO(stickers_webp[0])) as first_img:
            first_img = first_img.convert("RGBA")
            first_img.thumbnail((96, 96), Image.Resampling.LANCZOS)
            icon_buf = io.BytesIO()
            first_img.save(icon_buf, format="PNG")
            z.writestr("icon.png", icon_buf.getvalue())

        for idx, webp_data in enumerate(stickers_webp):
            z.writestr(f"{idx:02d}.webp", webp_data)

    print(f"Successfully generated {out_zip_path} with {len(stickers_webp)} stickers")

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python3 generate-spack.py <out_zip_path> <pack_name> <img1> [img2...]", file=sys.stderr)
        sys.exit(1)

    out_zip = sys.argv[1]
    name = sys.argv[2]
    inputs = sys.argv[3:]
    build_wastickers(out_zip, name, inputs)
