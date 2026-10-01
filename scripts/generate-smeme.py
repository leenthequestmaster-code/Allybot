#!/usr/bin/env python3
import sys
import os
import re
import urllib.request
from PIL import Image, ImageDraw, ImageFont

CACHE_DIR = os.environ.get("TWEMOJI_CACHE_DIR", "/tmp/twemoji_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

EMOJI_REGEX = re.compile(
    r"(?:\ud83c[\udf00-\udfff]|\ud83d[\udc00-\ude4f\ude80-\udeff]|\ud83e[\udd00-\uddff]|[\u2600-\u27bf]|[\U00010000-\U0010ffff])"
)

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

def find_font(size: int):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
        os.path.join(os.path.dirname(__file__), "..", "assets", "fonts", "Inter-Bold.ttf"),
        os.path.join(os.path.dirname(__file__), "..", "assets", "fonts", "Inter.ttf"),
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def tokenize_line(text_line: str):
    tokens = []
    last_idx = 0
    for m in EMOJI_REGEX.finditer(text_line):
        if m.start() > last_idx:
            tokens.append(("text", text_line[last_idx:m.start()]))
        tokens.append(("emoji", m.group()))
        last_idx = m.end()
    if last_idx < len(text_line):
        tokens.append(("text", text_line[last_idx:]))
    return tokens

def measure_tokens(draw, tokens, font, font_size, stroke):
    total_w = 0
    max_h = font_size
    for kind, val in tokens:
        if kind == "text":
            bbox = draw.textbbox((0, 0), val, font=font, stroke_width=stroke)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
            total_w += w
            if h > max_h:
                max_h = h
        else:
            total_w += font_size + 4
    return total_w, max_h

def fit_text_lines(draw, text: str, max_w=480, max_h=180, target_size=50):
    text = text.strip()
    words = text.split()

    target_size = max(16, min(92, int(target_size)))
    min_size = max(14, int(target_size * 0.45))

    for size in range(target_size, min_size - 1, -2):
        font = find_font(size)
        stroke = max(3, int(size * 0.12))
        lines = []
        curr = ""
        valid = True

        for w in words:
            test_line = f"{curr} {w}".strip()
            test_tokens = tokenize_line(test_line)
            tw, _ = measure_tokens(draw, test_tokens, font, size, stroke)
            if tw <= max_w:
                curr = test_line
            else:
                if curr:
                    lines.append(curr)
                w_tokens = tokenize_line(w)
                ww, _ = measure_tokens(draw, w_tokens, font, size, stroke)
                if ww > max_w:
                    valid = False
                    break
                curr = w

        if not valid:
            continue
        if curr:
            lines.append(curr)

        if len(lines) > 2 and size > min_size:
            continue

        total_h = 0
        for l in lines:
            tokens = tokenize_line(l)
            _, lh = measure_tokens(draw, tokens, font, size, stroke)
            total_h += lh + 6

        if total_h <= max_h or size <= min_size:
            return font, size, stroke, lines

    font = find_font(min_size)
    stroke = max(3, int(min_size * 0.12))
    return font, min_size, stroke, [text]

def draw_line_with_emoji(canvas, draw, line_str, font, font_size, stroke, y):
    tokens = tokenize_line(line_str)
    total_w, line_h = measure_tokens(draw, tokens, font, font_size, stroke)
    curr_x = (512 - total_w) // 2

    for kind, val in tokens:
        if kind == "text":
            draw.text(
                (curr_x, y),
                val,
                font=font,
                fill=(255, 255, 255, 255),
                stroke_width=stroke,
                stroke_fill=(0, 0, 0, 255),
            )
            bbox = draw.textbbox((0, 0), val, font=font, stroke_width=stroke)
            curr_x += (bbox[2] - bbox[0])
        else:
            emo = get_twemoji(val)
            if emo:
                emo_resized = emo.resize((font_size, font_size), Image.Resampling.LANCZOS)
                canvas.paste(emo_resized, (curr_x, y + max(0, (line_h - font_size) // 2)), emo_resized)
            else:
                draw.text(
                    (curr_x, y),
                    val,
                    font=font,
                    fill=(255, 255, 255, 255),
                    stroke_width=stroke,
                    stroke_fill=(0, 0, 0, 255),
                )
            curr_x += font_size + 4

    return line_h

def make_smeme(in_path: str, out_path: str, top_text: str, bottom_text: str, size_pct: int = 50):
    target_size = max(16, min(92, int(size_pct)))

    with Image.open(in_path) as orig:
        img = orig.convert("RGBA")

    img.thumbnail((512, 512), Image.Resampling.LANCZOS)
    nw, nh = img.size

    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    offset_x = (512 - nw) // 2
    offset_y = (512 - nh) // 2
    canvas.paste(img, (offset_x, offset_y))

    draw = ImageDraw.Draw(canvas)
    top_end_y = 0

    if top_text and top_text.strip():
        font, font_size, stroke, lines = fit_text_lines(draw, top_text, max_w=480, max_h=180, target_size=target_size)
        curr_y = max(8, offset_y + 4)
        for line in lines:
            line_h = draw_line_with_emoji(canvas, draw, line, font, font_size, stroke, curr_y)
            curr_y += line_h + 6
        top_end_y = curr_y

    if bottom_text and bottom_text.strip():
        font, font_size, stroke, lines = fit_text_lines(draw, bottom_text, max_w=480, max_h=180, target_size=target_size)
        total_h = 0
        line_heights = []
        for line in lines:
            tokens = tokenize_line(line)
            _, lh = measure_tokens(draw, tokens, font, font_size, stroke)
            line_heights.append(lh)
            total_h += lh + 6

        bottom_limit = min(504, offset_y + nh - 4)
        start_y = max(top_end_y + 8, bottom_limit - total_h)

        curr_y = start_y
        for idx, line in enumerate(lines):
            line_h = draw_line_with_emoji(canvas, draw, line, font, font_size, stroke, curr_y)
            curr_y += line_h + 6

    canvas.save(out_path, format="WEBP", quality=85)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 generate-smeme.py <in_image> <out_webp> [top_text] [bottom_text] [size_pct]", file=sys.stderr)
        sys.exit(1)

    in_f = sys.argv[1]
    out_f = sys.argv[2]
    top = sys.argv[3] if len(sys.argv) > 3 else ""
    bottom = sys.argv[4] if len(sys.argv) > 4 else ""
    raw_size = sys.argv[5] if len(sys.argv) > 5 else "50"
    try:
        size_pct = int(raw_size.replace("%", "").strip())
    except ValueError:
        size_pct = 50

    make_smeme(in_f, out_f, top, bottom, size_pct)
