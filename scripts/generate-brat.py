#!/usr/bin/env python3
import sys
import os
import re
import urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageFilter

CACHE_DIR = os.environ.get("TWEMOJI_CACHE_DIR", "/tmp/twemoji_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

def get_twemoji(char):
    cps = [f"{ord(c):x}" for c in char if ord(c) != 0xfe0f]
    fname = "-".join(cps) + ".png"
    fpath = os.path.join(CACHE_DIR, fname)
    if not os.path.exists(fpath):
        url = f"https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/{fname}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=4) as r, open(fpath, "wb") as f:
                f.write(r.read())
        except Exception:
            return None
    try:
        return Image.open(fpath).convert("RGBA")
    except Exception:
        return None

def find_font(size):
    candidates = [
        "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()

def render_brat(text: str, out_path: str):
    words = text.strip().split()
    if not words:
        words = ["brat"]

    lines = []
    curr = []
    for w in words:
        if len(" ".join(curr + [w])) > 13:
            if curr:
                lines.append(" ".join(curr))
            curr = [w]
        else:
            curr.append(w)
    if curr:
        lines.append(" ".join(curr))

    font_size = 32 if len(lines) > 5 else 40 if len(lines) > 3 else 48 if len(lines) > 1 else 56
    font = find_font(font_size)
    line_spacing = int(font_size * 0.25)

    img = Image.new("RGBA", (512, 512), (255, 255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Standard unicode regex for emoji matching
    emoji_regex = re.compile(
        r"(?:\ud83c[\udf00-\udfff]|\ud83d[\udc00-\ude4f\ude80-\udeff]|\ud83e[\udd00-\uddff]|[\u2600-\u27bf]|[\U00010000-\U0010ffff])"
    )

    measured_lines = []
    total_height = 0
    for line in lines:
        tokens = []
        last_idx = 0
        for m in emoji_regex.finditer(line):
            if m.start() > last_idx:
                tokens.append(("text", line[last_idx:m.start()]))
            tokens.append(("emoji", m.group()))
            last_idx = m.end()
        if last_idx < len(line):
            tokens.append(("text", line[last_idx:]))

        line_w = 0
        for kind, val in tokens:
            if kind == "text":
                bbox = font.getbbox(val)
                line_w += (bbox[2] - bbox[0])
            else:
                line_w += font_size + 4
        line_h = font_size
        measured_lines.append((tokens, line_w, line_h))
        total_height += line_h + line_spacing
    total_height -= line_spacing

    start_y = (512 - total_height) // 2

    curr_y = start_y
    for tokens, line_w, line_h in measured_lines:
        curr_x = (512 - line_w) // 2
        for kind, val in tokens:
            if kind == "text":
                draw.text((curr_x, curr_y), val, font=font, fill=(0, 0, 0, 255))
                bbox = font.getbbox(val)
                curr_x += (bbox[2] - bbox[0])
            else:
                emoji_img = get_twemoji(val)
                if emoji_img:
                    emoji_resized = emoji_img.resize((font_size, font_size), Image.Resampling.LANCZOS)
                    img.paste(emoji_resized, (curr_x, curr_y), emoji_resized)
                curr_x += font_size + 4
        curr_y += line_h + line_spacing

    # Authentic brat aesthetic: slight blur / fuzzy compression texture
    img_rgb = img.convert("RGB")
    blurred = img_rgb.filter(ImageFilter.GaussianBlur(radius=1.3))

    blurred.save(out_path, "WEBP", quality=85)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 generate-brat.py <output_path> [text]", file=sys.stderr)
        sys.exit(1)

    out_file = sys.argv[1]
    if len(sys.argv) > 2:
        input_text = " ".join(sys.argv[2:])
    else:
        input_text = sys.stdin.read().strip()

    render_brat(input_text, out_file)
