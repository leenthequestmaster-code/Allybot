#!/usr/bin/env python3
import sys
import os
import json
import io
import zipfile
from PIL import Image

def to_static_webp(image_path: str) -> bytes:
    with Image.open(image_path) as orig:
        img = orig.convert("RGBA")

    # Fit within 512x512 while maintaining aspect ratio
    img.thumbnail((512, 512), Image.Resampling.LANCZOS)
    nw, nh = img.size

    # Exact 512x512 transparent canvas (MANDATORY for WhatsApp & Sticker Maker)
    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    canvas.paste(img, ((512 - nw) // 2, (512 - nh) // 2))

    # WhatsApp sticker limit is strictly 100 KB
    quality = 82
    buf = io.BytesIO()
    canvas.save(buf, format="WEBP", quality=quality, method=6)
    while len(buf.getvalue()) > 100 * 1024 and quality > 30:
        quality -= 10
        buf = io.BytesIO()
        canvas.save(buf, format="WEBP", quality=quality, method=6)

    return buf.getvalue()

def build_wastickers(out_zip_path: str, pack_name: str, image_paths: list[str]):
    safe_id = "".join(c for c in pack_name if c.isalnum()).lower() or "pack"
    stickers_webp = []

    for p in image_paths:
        try:
            stickers_webp.append(to_static_webp(p))
        except Exception as e:
            print(f"Skipping corrupt image {p}: {e}", file=sys.stderr)

    if not stickers_webp:
        raise ValueError("No valid stickers could be generated")

    out_dir = os.path.dirname(out_zip_path) or "."
    os.makedirs(out_dir, exist_ok=True)

    manifest = {
        "android_play_store_link": "",
        "ios_app_store_link": "",
        "publisher_email": "admin@allyssea.org",
        "publisher_website": "https://allyssea.org",
        "privacy_policy_website": "https://allyssea.org/privacy",
        "license_agreement_website": "https://allyssea.org/license",
        "image_data_version": "1",
        "avoid_cache": False,
        "animated_sticker_pack": False,
        "identifier": f"com.allybot.{safe_id}",
        "name": pack_name,
        "publisher": "Allybot",
        "tray_image_file": "icon.png",
        "stickers": [
            {"image_file": f"{i:02d}.webp", "emojis": ["🙂"]}
            for i in range(len(stickers_webp))
        ],
    }

    with zipfile.ZipFile(out_zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))

        # Tray icon exact 96x96 PNG (MANDATORY for WAStickerApps specification)
        with Image.open(io.BytesIO(stickers_webp[0])) as first_img:
            first_img = first_img.convert("RGBA")
            first_img.thumbnail((96, 96), Image.Resampling.LANCZOS)
            nw, nh = first_img.size
            tray_canvas = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
            tray_canvas.paste(first_img, ((96 - nw) // 2, (96 - nh) // 2))
            icon_buf = io.BytesIO()
            tray_canvas.save(icon_buf, format="PNG")
            z.writestr("icon.png", icon_buf.getvalue())

        for idx, webp_data in enumerate(stickers_webp):
            z.writestr(f"{idx:02d}.webp", webp_data)
            # Save loose 512x512 webp in session directory for direct chat sending
            loose_path = os.path.join(out_dir, f"{idx:02d}.webp")
            with open(loose_path, "wb") as wf:
                wf.write(webp_data)

    print(f"Successfully generated {out_zip_path} with {len(stickers_webp)} stickers")

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python3 generate-spack.py <out_zip_path> <pack_name> <img1> [img2...]", file=sys.stderr)
        sys.exit(1)

    out_zip = sys.argv[1]
    name = sys.argv[2]
    inputs = sys.argv[3:]
    build_wastickers(out_zip, name, inputs)
