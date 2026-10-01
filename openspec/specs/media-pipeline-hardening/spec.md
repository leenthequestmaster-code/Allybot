# media-pipeline-hardening Specification

## Purpose
Enforces execution bounds, process lifetime isolation, and guaranteed temporary file cleanup for media manipulation pipelines to ensure VPS stability.

## Requirements

### Requirement: Python subprocess execution timeout
The media processing engine SHALL abort and terminate Python subprocesses that exceed a maximum allowed execution duration (default 25 seconds).

#### Scenario: Subprocess hangs or takes too long
- **WHEN** a Python media rendering task takes longer than the timeout limit
- **THEN** the runner kills the subprocess via SIGKILL, rejects the Promise with a timeout error, and logs the incident

### Requirement: Guaranteed temporary file cleanup for Quote Chat
The Quote Chat generator SHALL unlink both temporary avatar input files and temporary output WebP files under all termination conditions, including errors.

#### Scenario: Quote chat generation completes or fails
- **WHEN** Quote Chat stiker rendering finishes successfully or throws an error
- **THEN** all associated `/tmp` files (`av_*` and `qc_*`) are deleted from the filesystem

### Requirement: Full-Color Twemoji Rendering in Meme Stickers
The meme sticker generator SHALL tokenize unicode emojis in input text and render them as full-color raster Twemoji assets, accepting an optional user-defined font size percentage from 10% to 90% (default 50%).

#### Scenario: User provides text with emoji to !smeme
- **WHEN** a user generates a meme sticker containing emojis (e.g. `!smeme TOP | BOTTOM 😂🔥` or with custom sizing `!smeme TOP | BOTTOM | 70%`)
- **THEN** the output sticker renders the emojis in full color matching the Twemoji specification, scaled proportionally to the chosen text size.

### Requirement: Lean MsgBuilder Without Deprecated AIRich Protobufs
The message builder SHALL omit unsupported WhatsApp AIRich protobuf payloads and focus exclusively on standard text, native flow buttons, carousels, and list menus.

#### Scenario: Message builder constructs native flow or standard messages
- **WHEN** building interactive messages for WhatsApp
- **THEN** the builder produces verified native flow or text payloads without referencing dead AIRich structures
