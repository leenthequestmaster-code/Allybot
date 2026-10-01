# visual-card-engine Specification

## Purpose
Provides a lightweight, non-Chromium flexbox visual card rendering engine using satori and resvg for WhatsApp social and chat mockup features.

## Requirements

### Requirement: iOS Context Menu Fake Chat Generation
The visual engine SHALL render a high-fidelity iPhone WhatsApp long-press message mockup (`!iqc`) with a 920px wide layout and blurred wallpaper background filter, with image delivery by default and sticker delivery via `!iqcs`.

#### Scenario: User requests iPhone chat mockup
- **WHEN** a user invokes `!iqc <text>` or replies to a message with `!iqc`
- **THEN** the engine renders a dark-mode iOS fake chat image with reactions, bubble text, timestamp, action buttons, and a gaussian blurred wallpaper background.

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

### Requirement: Satori-Powered Brat Album Cover Generator
The visual card engine SHALL render an authentic "Brat" cover image (`!brat`) using Satori and Resvg based on local Arimo-Regular TTF font, text justification, binary search font scaling, and Gaussian blur.

#### Scenario: User requests Brat cover generation
- **WHEN** a user invokes `!brat <text>` with text between 1 and 200 characters
- **THEN** the engine normalizes the text to lowercase
- **AND** binary searches the optimal font size to fit within a 720x720 canvas with 30px padding
- **AND** justifies all non-final lines with space-between alignment and left-aligns the final line
- **AND** renders the text with letter-spacing -2px, line-height 0.95, and a Gaussian blur filter of stdDeviation 3
- **AND** outputs a 2x PNG buffer (1440x1440).
