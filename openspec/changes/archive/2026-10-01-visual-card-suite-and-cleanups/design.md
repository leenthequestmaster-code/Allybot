# Design: Visual Card Suite, Twemoji Meme Upgrade, and AIRich Pruning

## Context

See `proposal.md` for background. Allybot operates as a 24/7 WhatsApp daemon on a 2GB Debian VPS. Image generation must maintain zero-Chromium execution, fast sub-150ms latency, and in-memory processing to avoid disk leaks and memory spikes.

## Goals / Non-Goals

**Goals:**
- Prune all defunct AIRich protobuf logic and markdown parsers from `src/framework/msg-builder.ts`.
- Upgrade `scripts/generate-smeme.py` to tokenize emojis and composite colorful Twemoji raster images onto meme text.
- Build `src/services/visual-card-service.ts` bundling `satori` + `@resvg/resvg-js` with local `Inter.ttf`.
- Implement 5 focused visual card features: `!iqc`, `!qc` (upgraded), `!tweet`, `!ttstalk`, and `!igstalk`.

**Non-Goals:**
- Animating cards frame-by-frame (video transcoding remains with native `ffmpeg`).
- Headless browser rendering or Chromium dependencies.

## Decisions

### 1. `VisualCardService` In-Process Engine
- Use `satori` to convert lightweight virtual DOM objects (`{ type, props: { style, children } }`) into SVG markup using the Yoga C++ flexbox layout engine.
- Use `@resvg/resvg-js` to rasterize SVG into PNG Buffers in Rust.
- Store a self-contained font `assets/fonts/Inter.ttf` loaded once at service initialization.
- Provide helper methods:
  - `renderIqc(options: IqcOptions): Promise<Buffer>`
  - `renderQc(options: QcOptions): Promise<Buffer>`
  - `renderTweet(options: TweetOptions): Promise<Buffer>`
  - `renderProfileCard(options: ProfileCardOptions): Promise<Buffer>`

### 2. Upgrading `generate-smeme.py`
- Extract unicode emoji regex (same pattern as `generate-brat.py` and `generate-qc.py`).
- Tokenize lines into text segments and emoji characters.
- Render text segments with stroke and font, and paste Twemoji 72x72 PNGs resized to matching font size.

### 3. Social Stalker Scrapers (`!ttstalk`, `!igstalk`)
- For TikTok: Use TikWM / TikTok public API to fetch avatar, nickname, username, followers, following, likes, and bio.
- For Instagram: Use lightweight public profile endpoint or oEmbed / Instagram web API with safe fallback placeholders if rate-limited.
- Pass scraped metadata directly to `renderProfileCard()` to deliver high-resolution PNGs.

## Risks / Trade-offs

- [Risk]: External social profile APIs may be throttled or rate-limited.
  → Mitigation: Fail gracefully with informative user feedback, and validate response schemas.
- [Risk]: Large text inputs for `!iqc` and `!qc` could overflow canvas.
  → Mitigation: Clamp text input to 300 characters and apply flexbox `wordBreak: 'break-word'`.
