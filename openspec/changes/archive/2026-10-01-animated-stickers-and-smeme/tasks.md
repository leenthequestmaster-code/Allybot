# Tasks

## 1. Transformer and Pipeline Enhancements
- [x] 1.1 Update `src/media.ts` to convert `image/gif` to animated WebP stickers and permit sticker pass-through.
- [x] 1.2 Update `transformAndSend` in `src/framework/plugins/media.ts` to support sticker input and set `isAnimated: true` for animated stickers.

## 2. Animated Smeme Implementation
- [x] 2.1 Update `smeme` handler in `src/framework/plugins/media.ts` to detect animated video/GIF/sticker inputs and composite the text overlay across all frames.
- [x] 2.2 Verify both video and animated GIF/sticker inputs produce animated stickers with full typography.

## 3. Verification & Deployment
- [x] 3.1 Update unit tests in `tests/media-plugin.test.js` to cover animated sticker and smeme conversion.
- [x] 3.2 Run Alibaba Open Code Review (`ocr`) on changed files.
- [x] 3.3 Deploy to VPS, rebuild, restart `allybot.service`, and verify logs.
