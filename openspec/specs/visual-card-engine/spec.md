# visual-card-engine Specification

## Purpose
Provides a lightweight, non-Chromium flexbox visual card rendering engine using satori and resvg for WhatsApp social and chat mockup features.

## Requirements

### Requirement: iOS Context Menu Fake Chat Generation
The visual engine SHALL render a high-fidelity iPhone WhatsApp long-press message mockup (`!iqc`) featuring a reaction pill bar, speech bubble, and iOS action sheet menu.

#### Scenario: User requests iPhone chat mockup
- **WHEN** a user invokes `!iqc <text>` or replies to a message with `!iqc`
- **THEN** the engine renders a dark-mode iOS fake chat image/sticker with reactions, bubble text, timestamp, and action buttons

### Requirement: Enhanced WhatsApp Quote Chat Bubble
The visual engine SHALL render an authentic WhatsApp dark-mode chat bubble (`!qc`) with an attached SVG speech tail, circular avatar, auto-fitting width, and timestamp.

#### Scenario: User requests quote chat sticker
- **WHEN** a user invokes `!qc <text>` or replies to a message with `!qc`
- **THEN** the engine generates a clean dark-mode quote bubble sticker in memory without writing temporary files to disk

### Requirement: Twitter/X Post Mockup Generation
The visual engine SHALL render a realistic Twitter/X dark-mode tweet card (`!tweet`) displaying the author's avatar, name, handle, verified badge, text body, and engagement metrics.

#### Scenario: User creates a tweet mockup
- **WHEN** a user invokes `!tweet <text>` (optionally specifying username/handle)
- **THEN** the engine produces a Twitter/X post card image

### Requirement: Social Profile Visual Card Generation
The visual engine SHALL render clean profile summary cards for TikTok (`!ttstalk`) and Instagram (`!igstalk`) displaying user avatar, handle, follower counts, and bio.

#### Scenario: User searches social media profile
- **WHEN** a user invokes `!ttstalk <username>` or `!igstalk <username>`
- **THEN** the bot retrieves profile metadata and delivers a rendered visual profile card
