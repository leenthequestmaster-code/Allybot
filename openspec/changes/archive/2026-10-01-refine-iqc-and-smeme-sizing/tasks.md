# Tasks

## 1. Smeme Custom Text & Emoji Sizing

- [x] 1.1 Update `scripts/generate-smeme.py` to support dynamic font & emoji sizing via `size_pct` argument.
- [x] 1.2 Update `src/framework/plugins/media.ts` to parse percentage parameters from `!smeme` commands.

## 2. IQC Background & Scale Upgrade

- [x] 2.1 Update `VisualCardService.renderIqc` in `src/services/visual-card-service.ts` to include SVG gaussian blur background and 25% scale increase.
- [x] 2.2 Switch `!iqc` in `src/framework/plugins/media.ts` to send image by default.
- [x] 2.3 Implement `!iqcs` command in `src/framework/plugins/media.ts` and document in `src/framework/command-copy.ts`.

## 3. Verification & Deployment

- [x] 3.1 Update unit tests in `tests/visual-card-service.test.js` and verify all tests pass.
- [x] 3.2 Run Alibaba Open Code Review (`ocr`) on changed files.
- [x] 3.3 Deploy to VPS, restart `allybot.service`, and verify logs.
