# Design: Animated Sticker & Animated Smeme Pipeline

## 1. FfmpegMediaTransformer Updates
- Route `inputMimeType === 'image/gif'` to `videoToStickerArgs()`, generating looping animated WebP.
- Allow `target === 'sticker'` when `inputKind === 'sticker'`, passing through the WebP data for re-stickering.
- In `transformAndSend`, check whether the output sticker is animated (video, GIF, or WebP buffer containing `ANIM` / `ANMF` chunks), setting `isAnimated: true` on `sendMedia`.

## 2. Animated Smeme Processing
- Check if input media is animated.
- If animated:
  - Call `generate-smeme.py --overlay` to render a 512x512 transparent PNG containing only top and bottom text + Twemoji emojis at the user's chosen `size_pct`.
  - For video inputs: run `ffmpeg` with `-filter_complex` overlaying the PNG on every video frame at 10 fps, 512x512, looping WebP.
  - For GIF or animated WebP inputs: use `sharp({ animated: true })` to composite the overlay across all frames in-memory.
  - Inject sticker EXIF metadata via `setStickerExif`.
  - Send with `isAnimated: true`.
- If static: continue using standard static `generate-smeme.py` pipeline.
