#!/usr/bin/env python3
import sys
import os
from PIL import Image, ImageDraw, ImageFont

def find_font(size: int):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
        os.path.join(os.path.dirname(__file__), "..", "assets", "fonts", "Inter.ttf"),
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def fit_text_lines(draw, text: str, max_w=480, max_h=130, start_size=52, min_size=24):
    """
    Find best font size and word-wrapped lines fitting cleanly in max_w and max_h.
    Adaptive scaling down from start_size (huge & bold) to min_size.
    """
    text = text.upper().strip()
    words = text.split()

    for size in range(start_size, min_size - 1, -2):
        font = find_font(size)
        stroke = max(3, int(size * 0.12))
        lines = []
        curr = ""
        valid = True

        for w in words:
            test_line = f"{curr} {w}".strip()
            bbox = draw.textbbox((0, 0), test_line, font=font, stroke_width=stroke)
            if bbox[2] - bbox[0] <= max_w:
                curr = test_line
            else:
                if curr:
                    lines.append(curr)
                w_bbox = draw.textbbox((0, 0), w, font=font, stroke_width=stroke)
                if w_bbox[2] - w_bbox[0] > max_w:
                    valid = False
                    break
                curr = w

        if not valid:
            continue
        if curr:
            lines.append(curr)

        # Max 2 lines per top / bottom section to preserve meme aesthetics
        if len(lines) > 2:
            continue

        total_h = 0
        for l in lines:
            bbox = draw.textbbox((0, 0), l, font=font, stroke_width=stroke)
            total_h += (bbox[3] - bbox[1]) + 4

        if total_h <= max_h:
            return font, stroke, lines

    # Fallback to min_size
    font = find_font(min_size)
    stroke = max(3, int(min_size * 0.12))
    return font, stroke, [text]

def make_smeme(in_path: str, out_path: str, top_text: str, bottom_text: str):
    with Image.open(in_path) as orig:
        img = orig.convert("RGBA")

    # 1. Scale down to fit 512x512 while keeping original aspect ratio
    img.thumbnail((512, 512), Image.Resampling.LANCZOS)
    nw, nh = img.size

    # 2. Paste centered onto 512x512 transparent canvas
    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    offset_x = (512 - nw) // 2
    offset_y = (512 - nh) // 2
    canvas.paste(img, (offset_x, offset_y))

    draw = ImageDraw.Draw(canvas)
    top_end_y = 0

    # 3. Draw Top Text
    if top_text and top_text.strip():
        font, stroke, lines = fit_text_lines(draw, top_text, max_w=480, max_h=130, start_size=52, min_size=24)
        curr_y = max(8, offset_y + 4)
        for line in lines:
            bbox = draw.textbbox((0, 0), line, font=font, stroke_width=stroke)
            lw = bbox[2] - bbox[0]
            lh = bbox[3] - bbox[1]
            x = (512 - lw) // 2
            draw.text((x, curr_y), line, font=font, fill=(255, 255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
            curr_y += lh + 4
        top_end_y = curr_y

    # 4. Draw Bottom Text
    if bottom_text and bottom_text.strip():
        font, stroke, lines = fit_text_lines(draw, bottom_text, max_w=480, max_h=130, start_size=52, min_size=24)
        total_h = 0
        line_metrics = []
        for line in lines:
            bbox = draw.textbbox((0, 0), line, font=font, stroke_width=stroke)
            lw = bbox[2] - bbox[0]
            lh = bbox[3] - bbox[1]
            line_metrics.append((lw, lh))
            total_h += lh + 4

        # Position upwards from bottom of image or canvas
        bottom_limit = min(504, offset_y + nh - 4)
        start_y = max(top_end_y + 12, bottom_limit - total_h)

        curr_y = start_y
        for idx, line in enumerate(lines):
            lw, lh = line_metrics[idx]
            x = (512 - lw) // 2
            draw.text((x, curr_y), line, font=font, fill=(255, 255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
            curr_y += lh + 4

    canvas.save(out_path, format="WEBP", quality=85)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 generate-smeme.py <in_image> <out_webp> [top_text] [bottom_text]", file=sys.stderr)
        sys.exit(1)

    in_f = sys.argv[1]
    out_f = sys.argv[2]
    top = sys.argv[3] if len(sys.argv) > 3 else ""
    bottom = sys.argv[4] if len(sys.argv) > 4 else ""

    make_smeme(in_f, out_f, top, bottom)
