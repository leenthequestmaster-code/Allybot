# Tasks

## 1. Prune AIRich Dead Code

- [x] 1.1 Remove `parseRichMarkdown()`, `_rich` property, and unused AIRich payload types from `src/framework/msg-builder.ts` and verify with unit tests in `src/framework/msg-builder.test.ts`.

## 2. Upgrade Meme Sticker Emoji Color

- [x] 2.1 Update `scripts/generate-smeme.py` to tokenize emojis and composite Twemoji raster images in full color.
- [x] 2.2 Verify `scripts/generate-smeme.py` generates memes with colorful emoji locally.

## 3. Visual Card Engine Foundation

- [x] 3.1 Install standalone `assets/fonts/Inter.ttf` in the repo.
- [x] 3.2 Implement `src/services/visual-card-service.ts` with `satori` + `@resvg/resvg-js`.
- [x] 3.3 Create unit test `tests/visual-card-service.test.js` verifying SVG/PNG generation for all card types.

## 4. Visual Commands Integration

- [x] 4.1 Implement `!iqc` command (iPhone WhatsApp fake chat with reactions & iOS menu).
- [x] 4.2 Upgrade `!qc` to use `VisualCardService` with speech tail, circular avatar, and sticker EXIF.
- [x] 4.3 Implement `!tweet` command with Twitter/X dark mode mockup.
- [x] 4.4 Implement `!ttstalk` and `!igstalk` profile scraper & card delivery.

## 5. Verification, Code Review & Deployment

- [x] 5.1 Run full test suite and TypeScript compilation `npm run build`.
- [x] 5.2 Run Alibaba Open Code Review (`ocr`) on changed files.
- [ ] 5.3 Deploy to VPS, rebuild, restart daemon, and verify health.
