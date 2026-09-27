#!/usr/bin/env python3
import sys
import os
from PIL import Image, ImageDraw, ImageFont

def find_font(size: int):
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "assets", "fonts", "Inter.ttf"),
        "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def make_smeme(in_path: str, out_path: str, top_text: str, bottom_text: str):
    with Image.open(in_path) as orig:
        img = orig.convert("RGBA")
    
    w, h = img.size
    draw = ImageDraw.Draw(img)
    
    # Adaptive font size
    font_size = max(22, int(min(w, h) * 0.085))
    font = find_font(font_size)
    stroke_w = max(2, int(font_size * 0.1))

    if top_text:
        top_str = top_text.upper().strip()
        tb = draw.textbbox((0, 0), top_str, font=font, stroke_width=stroke_w)
        tw = tb[2] - tb[0]
        tx = max(4, (w - tw) // 2)
        ty = int(h * 0.04)
        draw.text((tx, ty), top_str, font=font, fill=(255, 255, 255, 255), stroke_width=stroke_w, stroke_fill=(0, 0, 0, 255))

    if bottom_text:
        bottom_str = bottom_text.upper().strip()
        bb = draw.textbbox((0, 0), bottom_str, font=font, stroke_width=stroke_w)
        bw = bb[2] - bb[0]
        bx = max(4, (w - bw) // 2)
        by = max(ty + 20, h - int(h * 0.04) - (bb[3] - bb[1]))
        draw.text((bx, by), bottom_str, font=font, fill=(255, 255, 255, 255), stroke_width=stroke_w, stroke_fill=(0, 0, 0, 255))

    img.thumbnail((512, 512), Image.Resampling.LANCZOS)
    img.save(out_path, format="WEBP", quality=85)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 generate-smeme.py <in_image> <out_webp> [top_text] [bottom_text]", file=sys.stderr)
        sys.exit(1)

    in_f = sys.argv[1]
    out_f = sys.argv[2]
    top = sys.argv[3] if len(sys.argv) > 3 else ""
    bottom = sys.argv[4] if len(sys.argv) > 4 else ""

    make_smeme(in_f, out_f, top, bottom)
