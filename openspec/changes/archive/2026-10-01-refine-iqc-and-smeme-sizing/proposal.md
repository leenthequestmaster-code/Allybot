# Proposal: Refine IQC Image Delivery, Blurred Background, and Custom Smeme Text Sizing

## Why

1. `!iqc` was previously outputting stickers by default, causing tall aspect ratio fake chat mockups to appear small and compressed on mobile screens.
2. `!iqc` was lacking the authentic iOS WhatsApp blurred wallpaper background effect and its layout dimensions were 20-30% too small for optimal mobile legibility.
3. Meme stickers created with `!smeme` need user-controlled font and emoji sizing (10% to 90%, 50% default) to give users creative control over emphasis.
4. Users need a dedicated `!iqcs` command for on-demand sticker output while keeping `!iqc` primarily for full-resolution image sharing.

## What Changes

1. **`!iqc` Delivery Format**: Default to sending a crisp PNG image with caption.
2. **`!iqcs` Command**: Register a dedicated sticker command for iOS quote chat.
3. **`VisualCardService.renderIqc` Overhaul**:
   - Add authentic blurred wallpaper background using SVG gaussian blur filter (`#1b4d38`, `#2b302f`, `#252a29`).
   - Increase layout scale by ~25% (Width 920px, text 34px, reactions 54px, menu width 520px).
4. **`!smeme` User Font Sizing**:
   - Parse font size percentage (10-90%, default 50%) from trailing arguments (e.g. `!smeme teks 1 | teks 2 | 70%` or `!smeme teks 1 | teks 2 "70%"`).
   - Scale both text and Twemoji emojis proportionally in `scripts/generate-smeme.py`.
