#!/usr/bin/env python3
import sys
import os
import io
import subprocess
from PIL import Image

def compress_img(in_path: str, out_path: str, percent: int):
    with Image.open(in_path) as img:
        orig_w, orig_h = img.size
        scale = max(0.2, 1.0 - (percent / 140.0))
        new_w = max(16, int(orig_w * scale))
        new_h = max(16, int(orig_h * scale))
        resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        q = max(8, int(100 - percent))
        
        # Save as JPEG or PNG
        ext = os.path.splitext(out_path)[1].lower()
        if ext in (".png", ".webp") or img.mode in ("RGBA", "LA", "P"):
            resized = resized.convert("RGBA")
            resized.save(out_path, format="PNG", optimize=True)
        else:
            resized = resized.convert("RGB")
            resized.save(out_path, format="JPEG", quality=q, optimize=True)

def compress_vid(in_path: str, out_path: str, percent: int):
    scale = max(0.3, 1.0 - (percent / 160.0))
    crf = min(42, 24 + int(percent * 0.18))
    cmd = [
        "ffmpeg", "-y",
        "-i", in_path,
        "-vf", f"scale=trunc(iw*{scale}/2)*2:trunc(ih*{scale}/2)*2",
        "-c:v", "libx264",
        "-crf", str(crf),
        "-preset", "veryfast",
        "-c:a", "aac",
        "-b:a", "64k",
        "-movflags", "+faststart",
        out_path
    ]
    subprocess.run(cmd, check=True, capture_output=True)

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python3 compress-media.py <in_path> <out_path> <percent>", file=sys.stderr)
        sys.exit(1)

    in_f = sys.argv[1]
    out_f = sys.argv[2]
    pct = max(1, min(90, int(sys.argv[3])))

    # Detect if video or image
    ext = os.path.splitext(in_f)[1].lower()
    if ext in (".mp4", ".mkv", ".mov", ".webm", ".avi"):
        compress_vid(in_f, out_f, pct)
    else:
        compress_img(in_f, out_f, pct)
