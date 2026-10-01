# Proposal: Satori-Powered Brat Cover Generator

## Why

The existing `!brat` command relied on a Python Pillow script (`generate-brat.py`) which used manual coordinate positioning, fixed font sizing, and external process spawning.
Cyrus requested a pure TypeScript implementation of the Brat album cover generator using `satori` + `@resvg/resvg-js`:
- 720x720 layout, rendered at 2x (1440x1440 PNG)
- White background (`#ffffff`), black text (`#000000`)
- Local Arimo-Regular TTF font
- Automatic lowercase conversion
- Fully justified text layout (words spread across the container, last line left-aligned) with 30px padding
- Dynamic binary search font sizing to maximize text scale within bounds
- Letter-spacing -2px, line-height 0.95
- Subtle Gaussian blur (`stdDeviation="3"`)
- Full-color Twemoji emoji rendering with bounded LRU cache
- Validation: reject empty text or text exceeding 200 characters

## What Changes

1. **`VisualCardService.renderBrat`**:
   - Implements the layout engine and binary search font scaler using `opentype.js`.
   - Injects the `<feGaussianBlur stdDeviation="3"/>` filter into the Satori SVG text layer.
   - Outputs a crisp 2x PNG (1440x1440) via Resvg.
2. **`!brat` & `!brats` Command in `media.ts`**:
   - Migrates `!brat` to call `VisualCardService.renderBrat` directly in-process.
   - Sends image by default, with sticker output supported via `!brats` or `--sticker`.
3. **Assets**:
   - Adds `assets/fonts/Arimo-Regular.ttf` to repository.
