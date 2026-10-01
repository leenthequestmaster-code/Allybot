# Proposal: Animated Media Support in Sticker Creation and Meme Overlays

## Why

1. `!s` was limiting GIF inputs to single-frame static stickers because it used `imageToStickerArgs()` with `-frames:v 1`, instead of animated WebP transcoding.
2. Animated stickers and video/GIF inputs to `!smeme` were previously flattened into static 1-frame memes or fell back to plain stickers without meme text, making animated memes impossible.
3. WhatsApp requires `isAnimated: true` on animated sticker metadata so the mobile client renders loop animation rather than pausing on frame 0.

## What Changes

1. **`FfmpegMediaTransformer`**:
   - Transcode `image/gif` and `video/*` inputs to animated WebP with `-loop 0` and 10 fps.
   - Allow re-stickering stickers (`inputKind: 'sticker'`).
2. **`transformAndSend`**:
   - Set `isAnimated: true` for video, GIF, and animated WebP stickers.
   - Allow `inputKind: 'sticker'` in `!s` and `!swm`.
3. **Animated `!smeme`**:
   - Detect animated inputs (video, GIF, animated sticker).
   - Generate transparent 512x512 text/emoji overlay via `generate-smeme.py --overlay`.
   - Composite overlay onto video frames via ffmpeg and onto GIF/animated WebP frames via `sharp({ animated: true })`.
   - Send as animated sticker (`isAnimated: true`).
