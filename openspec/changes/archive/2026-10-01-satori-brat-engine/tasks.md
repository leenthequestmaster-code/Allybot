# Tasks

## 1. Engine Implementation
- [x] 1.1 Commit `assets/fonts/Arimo-Regular.ttf` and integrate `renderBrat` method into `src/services/visual-card-service.ts`.
- [x] 1.2 Export standalone `brat(text: string): Promise<Buffer>` function matching all specifications.

## 2. Handler Migration
- [x] 2.1 Migrate `!brat` and add `!brats` in `src/framework/plugins/media.ts` to call the TypeScript Satori generator in-process.
- [x] 2.2 Update `src/framework/command-copy.ts` to reflect updated Brat capabilities.

## 3. Verification & Deployment
- [x] 3.1 Add unit tests in `tests/visual-card-service.test.js` validating dimensions, blur, and text layout.
- [x] 3.2 Run Alibaba Open Code Review (`ocr`) on changed files.
- [x] 3.3 Deploy to VPS, restart `allybot.service`, and verify logs.
