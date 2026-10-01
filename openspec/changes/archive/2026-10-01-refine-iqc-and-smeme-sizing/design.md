# Design: IQC Visual Refinement and Smeme Custom Sizing

## 1. IQC Blurred Wallpaper & Scaling

- **Dimensions**: Scaled from W=736 to W=920 (+25%).
- **Blurred Wallpaper**:
  A base64-encoded SVG data URL with `<feGaussianBlur stdDeviation="35"/>` is applied to the root container's `backgroundImage`.
  Shapes replicate the iOS dark wallpaper gradient blobs (`#1b4d38`, `#2b302f`, `#252a29`) over `#0b0f0e`.
- **Command Separation**:
  - `!iqc` sends an uncompressed high-resolution PNG image with caption.
  - `!iqcs` sends a 512x512 contained WebP sticker with EXIF metadata.

## 2. Smeme Custom Sizing Pipeline

- **Argument Parsing in Node.js**:
  Support `!smeme text 1 | text 2 | 70%`, `!smeme text 1 | text 2 "70%"`, or `!smeme text 1 30%`.
  Extracted percentage is sanitized to an integer between 10 and 90, with 50 as default.
- **Python Generator `generate-smeme.py`**:
  Accepts a 5th positional argument `[size_pct]`.
  Calculates `target_size = max(16, min(92, int(size_pct)))`.
  Both text lines and Twemoji glyphs resize according to `target_size`.
