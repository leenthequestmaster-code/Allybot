# Proposal: Visual Card Suite and Codebase Refinement

## Why

1. Server-side WhatsApp error 479 confirms `AIRich` (`botInvokeMessage`) is restricted to Meta AI accounts, leaving unused dead code in `MsgBuilder` that should be cleanly pruned.
2. The `!smeme` sticker command renders emoji in monochrome because it uses standard Pillow font glyphs rather than Twemoji raster tokens.
3. Cyrus requested a lightweight, non-Chromium visual card engine based on `satori` + `@resvg/resvg-js` strictly scoped to 5 high-impact features: `!iqc`, `!qc`, `!tweet`, `!ttstalk`, and `!igstalk`.

## What Changes

- **AIRich Pruning**: Remove `parseRichMarkdown()`, `_rich` flag, and unused protobuf structures from `src/framework/msg-builder.ts`, keeping `MsgBuilder` focused on Native Flow Buttons, Carousels, and List Menus.
- **Color Emoji in `!smeme`**: Integrate Twemoji token parsing into `scripts/generate-smeme.py` so emojis are rendered in full vibrant color.
- **Visual Card Engine Service**: Create `src/services/visual-card-service.ts` using `satori` + `@resvg/resvg-js` + self-contained font asset `assets/fonts/Inter.ttf`.
- **Implement 5 Scoped Visual Commands**:
  - `!iqc`: iPhone WhatsApp long-press context menu fake chat with reactions bar and iOS action sheet.
  - `!qc`: Upgraded WhatsApp dark bubble quote chat with SVG speech bubble tail, auto-width, and crisp circular avatar.
  - `!tweet`: Twitter/X mockup post card with profile avatar, verified badge, handle, tweet text, and interaction counts.
  - `!ttstalk`: TikTok profile summary card (followers, following, likes, bio, avatar).
  - `!igstalk`: Instagram profile summary card (followers, following, posts, bio, avatar).

## Capabilities

### New Capabilities
- `visual-card-engine`: Satori + Resvg in-process SVG/PNG rendering engine for interactive cards (`!iqc`, `!qc`, `!tweet`, `!ttstalk`, `!igstalk`).

### Modified Capabilities
- `media-pipeline-hardening`: Pruning dead AIRich protobuf code and adding Twemoji color raster support to `!smeme`.

## Impact

- `src/framework/msg-builder.ts`
- `src/framework/msg-builder.test.ts`
- `scripts/generate-smeme.py`
- `src/services/visual-card-service.ts`
- `src/framework/plugins/media.ts`
- `package.json`
