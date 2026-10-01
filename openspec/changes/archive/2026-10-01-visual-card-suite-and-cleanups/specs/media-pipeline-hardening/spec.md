# Spec Delta: media-pipeline-hardening

## ADDED Requirements

### Requirement: Full-Color Twemoji Rendering in Meme Stickers
The meme sticker generator SHALL tokenize unicode emojis in input text and render them as full-color raster Twemoji assets instead of monochrome font outlines.

#### Scenario: User provides text with emoji to !smeme
- **WHEN** a user generates a meme sticker containing emojis (e.g. `!smeme TOP | BOTTOM 😂🔥`)
- **THEN** the output sticker renders the emojis in full color matching the Twemoji specification

### Requirement: Lean MsgBuilder Without Deprecated AIRich Protobufs
The message builder SHALL omit unsupported WhatsApp AIRich protobuf payloads and focus exclusively on standard text, native flow buttons, carousels, and list menus.

#### Scenario: Message builder constructs native flow or standard messages
- **WHEN** building interactive messages for WhatsApp
- **THEN** the builder produces verified native flow or text payloads without referencing dead AIRich structures
