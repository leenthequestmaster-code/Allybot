# Spec Delta: media-pipeline-hardening

## ADDED Requirements

### Requirement: Animated Video and GIF Sticker Conversion
The media transformation pipeline SHALL convert video, GIF, and animated WebP media into animated WhatsApp stickers (`image/webp`) with looping playback and deliver them with `isAnimated: true`.

#### Scenario: User creates sticker from animated video or GIF
- **WHEN** a user invokes `!s` replying to a video or GIF
- **THEN** the transformer converts the media into an animated WebP sticker
- **AND** the payload is dispatched with `isAnimated: true`

### Requirement: Animated Meme Sticker Overlays
The meme generator SHALL support animated video, GIF, and animated sticker inputs by compositing the meme typography overlay onto all frames and delivering an animated sticker.

#### Scenario: User creates meme from video or animated sticker
- **WHEN** a user invokes `!smeme` replying to a video, GIF, or animated sticker
- **THEN** a transparent text overlay is composited across all animation frames
- **AND** the resulting sticker preserves motion and loop playback.
