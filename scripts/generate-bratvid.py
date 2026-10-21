#!/usr/bin/env python3
import sys
import os
import tempfile
import subprocess
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def _load_brat_font(size: int):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, "..", "assets", "fonts", "Arimo-Regular.ttf"),
        os.path.join(script_dir, "..", "assets", "fonts", "Inter.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def render_brat_image(text: str, theme: str = "white") -> Image.Image:
    themes = {
        "white": ((255, 255, 255), (0, 0, 0)),
        "green": ((138, 206, 0), (0, 0, 0)),
        "black": ((0, 0, 0), (255, 255, 255)),
    }
    bg_color, fg_color = themes.get(theme.lower(), themes["white"])
    W, H, pad = 512, 512, 36
    max_w, max_h = W - pad * 2, H - pad * 2
    words = text.lower().split() or ["brat"]

    best_size = 24
    best_lines = [words]
    img = Image.new("RGB", (W, H), bg_color)
    draw = ImageDraw.Draw(img)

    for size in range(160, 18, -4):
        font = _load_brat_font(size)
        lines, cur = [], []
        possible = True
        for w in words:
            test = " ".join(cur + [w])
            bbox = draw.textbbox((0, 0), test, font=font)
            if bbox[2] - bbox[0] <= max_w:
                cur.append(w)
            else:
                wb = draw.textbbox((0, 0), w, font=font)
                if wb[2] - wb[0] > max_w:
                    possible = False
                    break
                if cur:
                    lines.append(cur)
                cur = [w]
        if not possible:
            continue
        if cur:
            lines.append(cur)
        total_h = len(lines) * int(size * 1.05)
        if total_h <= max_h:
            best_size = size
            best_lines = lines
            break

    font = _load_brat_font(best_size)
    line_h = int(best_size * 1.05)
    y = (H - len(best_lines) * line_h) // 2
    for idx, line_words in enumerate(best_lines):
        line_str = " ".join(line_words)
        draw.text((pad, y), line_str, font=font, fill=fg_color)
        y += line_h

    return img.filter(ImageFilter.GaussianBlur(radius=1.6))

def make_bratvid(text: str, out_path: str, theme: str = "white"):
    words = text.strip().split()
    if not words:
        words = ["brat"]

    with tempfile.TemporaryDirectory() as td:
        frame_idx = 1

        # 1. Render frame per progressive word
        for i in range(1, len(words) + 1):
            sub_text = " ".join(words[:i])
            frame_img = render_brat_image(sub_text, theme)
            frame_path = os.path.join(td, f"f{frame_idx:04d}.png")
            frame_img.save(frame_path, "PNG")
            frame_idx += 1

        # 2. Hold final frame (~1.2s at 2.8fps -> ~3-4 additional frames)
        last_frame_path = os.path.join(td, f"f{frame_idx - 1:04d}.png")
        for _ in range(4):
            hold_path = os.path.join(td, f"f{frame_idx:04d}.png")
            with open(last_frame_path, "rb") as rf, open(hold_path, "wb") as wf:
                wf.write(rf.read())
            frame_idx += 1

        # 3. Compile with ffmpeg based on target extension
        is_webp = out_path.lower().endswith(".webp")
        if is_webp:
            cmd = [
                "ffmpeg", "-y",
                "-framerate", "2.8",
                "-i", os.path.join(td, "f%04d.png"),
                "-vcodec", "libwebp",
                "-lossless", "0",
                "-compression_level", "4",
                "-q:v", "70",
                "-loop", "0",
                "-an",
                out_path
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-framerate", "2.8",
                "-i", os.path.join(td, "f%04d.png"),
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-crf", "23",
                "-preset", "veryfast",
                "-movflags", "+faststart",
                out_path
            ]

        subprocess.run(cmd, check=True, capture_output=True)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 generate-bratvid.py <output_path> [text]", file=sys.stderr)
        sys.exit(1)

    out_file = sys.argv[1]
    theme = "white"

    raw_args = sys.argv[2:]
    filtered_words = []
    for a in raw_args:
        if a.startswith("--theme="):
            theme = a.split("=")[1].strip()
        elif a in ("--green", "-g"):
            theme = "green"
        elif a in ("--black", "-b"):
            theme = "black"
        elif a in ("--white", "-w"):
            theme = "white"
        elif a in ("--video", "--mp4", "-v"):
            # Flag handled in wrapper or caller
            pass
        else:
            filtered_words.append(a)

    if filtered_words:
        input_text = " ".join(filtered_words)
    else:
        input_text = sys.stdin.read().strip()

    make_bratvid(input_text, out_file, theme)
