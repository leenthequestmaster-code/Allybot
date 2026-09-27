#!/usr/bin/env python3
import sys
import os
import re
import urllib.request
import textwrap
from PIL import Image, ImageDraw, ImageFont, ImageFilter

CACHE_DIR = os.environ.get("TWEMOJI_CACHE_DIR", "/tmp/twemoji_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

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

def get_twemoji(char: str):
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

def make_circle_avatar(avatar_img: Image.Image, size: int = 56) -> Image.Image:
    avatar_img = avatar_img.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    draw_mask = ImageDraw.Draw(mask)
    draw_mask.ellipse((0, 0, size, size), fill=255)
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(avatar_img, (0, 0), mask)
    return result

def make_fallback_avatar(name: str, size: int = 56) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((0, 0, size, size), fill=(80, 95, 105, 255))
    initial = (name.strip()[:1] or "?").upper()
    font = find_font(int(size * 0.5))
    bbox = draw.textbbox((0, 0), initial, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text(((size - w) // 2, (size - h) // 2 - int(size * 0.08)), initial, font=font, fill=(255, 255, 255, 255))
    return img

def render_qc(
    name: str,
    text: str,
    time_str: str,
    avatar_path: str | None,
    out_path: str
):
    CANVAS_W, CANVAS_H = 512, 512
    img = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    AVATAR_SIZE = 56
    if avatar_path and os.path.exists(avatar_path):
        try:
            raw_av = Image.open(avatar_path)
            avatar_img = make_circle_avatar(raw_av, AVATAR_SIZE)
        except Exception:
            avatar_img = make_fallback_avatar(name, AVATAR_SIZE)
    else:
        avatar_img = make_fallback_avatar(name, AVATAR_SIZE)

    # WhatsApp user name color palette
    NAME_COLORS = [
        (83, 189, 235),  # light blue
        (229, 66, 163),  # pink
        (255, 188, 56),  # orange
        (0, 168, 132),   # wa green
        (179, 142, 237), # purple
        (234, 91, 91),   # coral
    ]
    color_idx = abs(hash(name)) % len(NAME_COLORS)
    name_color = NAME_COLORS[color_idx]

    # Adaptive font size based on text length
    text_len = len(text)
    if text_len > 180:
        font_size = 17
    elif text_len > 100:
        font_size = 20
    elif text_len > 40:
        font_size = 22
    else:
        font_size = 25

    font_name = find_font(20)
    font_text = find_font(font_size)
    font_time = find_font(13)

    emoji_regex = re.compile(
        r"(?:\ud83c[\udf00-\udfff]|\ud83d[\udc00-\ude4f\ude80-\udeff]|\ud83e[\udd00-\uddff]|[\u2600-\u27bf]|[\U00010000-\U0010ffff])"
    )

    def measure_line(line_str: str):
        tokens = []
        last_idx = 0
        for m in emoji_regex.finditer(line_str):
            if m.start() > last_idx:
                tokens.append(("text", line_str[last_idx:m.start()]))
            tokens.append(("emoji", m.group()))
            last_idx = m.end()
        if last_idx < len(line_str):
            tokens.append(("text", line_str[last_idx:]))

        w = 0
        for kind, val in tokens:
            if kind == "text":
                bb = font_text.getbbox(val)
                w += (bb[2] - bb[0])
            else:
                w += font_size + 4
        return tokens, w

    # Wrap words
    MAX_BUBBLE_W = 390
    PADDING_X = 16
    PADDING_Y = 12
    MAX_TEXT_W = MAX_BUBBLE_W - (2 * PADDING_X)

    words = text.split()
    raw_lines = []
    curr_line = []
    for w in words:
        test_line = " ".join(curr_line + [w])
        _, lw = measure_line(test_line)
        if lw > MAX_TEXT_W:
            if curr_line:
                raw_lines.append(" ".join(curr_line))
                curr_line = [w]
            else:
                raw_lines.append(w)
                curr_line = []
        else:
            curr_line.append(w)
    if curr_line:
        raw_lines.append(" ".join(curr_line))

    if not raw_lines:
        raw_lines = ["..."]

    if len(raw_lines) > 8:
        raw_lines = raw_lines[:8]
        raw_lines[-1] += "..."

    measured_lines = [measure_line(l) for l in raw_lines]

    # Name measurement
    bbox_name = font_name.getbbox(name)
    name_w = bbox_name[2] - bbox_name[0]
    name_h = bbox_name[3] - bbox_name[1]

    # Time measurement
    bbox_time = font_time.getbbox(time_str)
    time_w = bbox_time[2] - bbox_time[0]
    time_h = bbox_time[3] - bbox_time[1]

    line_spacing = 6
    text_line_h = font_size + 2
    total_text_h = len(measured_lines) * text_line_h + (len(measured_lines) - 1) * line_spacing

    max_line_w = max([w for _, w in measured_lines]) if measured_lines else 100
    content_w = max(name_w, max_line_w, time_w + 30)
    bubble_w = min(MAX_BUBBLE_W, max(130, content_w + 2 * PADDING_X))
    bubble_h = PADDING_Y + name_h + 8 + total_text_h + 8 + time_h + PADDING_Y

    total_group_w = AVATAR_SIZE + 10 + bubble_w
    start_x = max(12, (CANVAS_W - total_group_w) // 2)
    start_y = max(12, (CANVAS_H - max(AVATAR_SIZE, bubble_h)) // 2)

    avatar_x = start_x
    avatar_y = start_y
    img.paste(avatar_img, (avatar_x, avatar_y), avatar_img)

    bx1 = avatar_x + AVATAR_SIZE + 10
    by1 = start_y
    bx2 = bx1 + bubble_w
    by2 = by1 + bubble_h

    # WhatsApp dark bubble color: #202c33
    BUBBLE_COLOR = (32, 44, 51, 255)
    draw.rounded_rectangle([bx1, by1, bx2, by2], radius=14, fill=BUBBLE_COLOR)

    # Name
    nx = bx1 + PADDING_X
    ny = by1 + PADDING_Y
    draw.text((nx, ny), name, font=font_name, fill=name_color)

    # Text lines with Twemoji
    curr_y = ny + name_h + 8
    for tokens, _ in measured_lines:
        curr_x = bx1 + PADDING_X
        for kind, val in tokens:
            if kind == "text":
                draw.text((curr_x, curr_y), val, font=font_text, fill=(233, 237, 239, 255))
                bb = font_text.getbbox(val)
                curr_x += (bb[2] - bb[0])
            else:
                emo = get_twemoji(val)
                if emo:
                    emo_resized = emo.resize((font_size, font_size), Image.Resampling.LANCZOS)
                    img.paste(emo_resized, (curr_x, curr_y + 1), emo_resized)
                curr_x += font_size + 4
        curr_y += text_line_h + line_spacing

    # Time stamp
    tm_x = bx2 - PADDING_X - time_w
    tm_y = by2 - PADDING_Y - time_h
    draw.text((tm_x, tm_y), time_str, font=font_time, fill=(134, 150, 160, 255))

    img.save(out_path, format="WEBP", quality=90)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 generate-qc.py <out_path> <name> [time] [avatar_path] [text]", file=sys.stderr)
        sys.exit(1)

    out_file = sys.argv[1]
    sender_name = sys.argv[2]
    time_val = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else "12:00"
    avatar_file = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "none" else None
    
    if len(sys.argv) > 5:
        msg_text = " ".join(sys.argv[5:])
    else:
        msg_text = sys.stdin.read().strip()

    if not msg_text:
        msg_text = "..."

    render_qc(sender_name, msg_text, time_val, avatar_file, out_file)
