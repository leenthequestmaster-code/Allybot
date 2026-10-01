# Spec Delta: visual-card-engine

## MODIFIED Requirements

### Requirement: iOS Context Menu Fake Chat Generation
The visual engine SHALL render a high-fidelity iPhone WhatsApp long-press message mockup (`!iqc`) with a 920px wide layout and blurred wallpaper background filter, with image delivery by default and sticker delivery via `!iqcs`.

#### Scenario: User requests iPhone chat mockup
- **WHEN** a user invokes `!iqc <text>` or replies to a message with `!iqc`
- **THEN** the engine renders a dark-mode iOS fake chat image with reactions, bubble text, timestamp, action buttons, and a gaussian blurred wallpaper background.
