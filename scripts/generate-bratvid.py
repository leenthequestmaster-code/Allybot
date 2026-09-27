#!/usr/bin/env python3
import sys
import os
import tempfile
import subprocess
import importlib

# Add script directory to sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
gen_brat = importlib.import_module("generate-brat")

def make_bratvid(text: str, out_path: str, theme: str = "white"):
    words = text.strip().split()
    if not words:
        words = ["brat"]

    with tempfile.TemporaryDirectory() as td:
        frame_idx = 1

        # 1. Render frame per progressive word
        for i in range(1, len(words) + 1):
            sub_text = " ".join(words[:i])
            frame_img = gen_brat.render_brat_image(sub_text, theme)
            frame_path = os.path.join(td, f"f{frame_idx:04d}.png")
            frame_img.save(frame_path, "PNG")
            frame_idx += 1

        # 2. Hold final frame (~1.2s at 2.8fps -> ~3 additional frames)
        last_frame_path = os.path.join(td, f"f{frame_idx - 1:04d}.png")
        for _ in range(3):
            hold_path = os.path.join(td, f"f{frame_idx:04d}.png")
            with open(last_frame_path, "rb") as rf, open(hold_path, "wb") as wf:
                wf.write(rf.read())
            frame_idx += 1

        # 3. Compile with ffmpeg
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
        else:
            filtered_words.append(a)

    if filtered_words:
        input_text = " ".join(filtered_words)
    else:
        input_text = sys.stdin.read().strip()

    make_bratvid(input_text, out_file, theme)
