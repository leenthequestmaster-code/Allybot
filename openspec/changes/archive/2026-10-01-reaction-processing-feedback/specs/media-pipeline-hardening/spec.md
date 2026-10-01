# Spec Delta: media-pipeline-hardening

## ADDED Requirements

### Requirement: Emoji Reaction Processing Signals
Commands with asynchronous processing pipelines SHALL provide non-intrusive waiting feedback via WhatsApp emoji reactions (`⏳`) attached directly to the user's message instead of sending temporary chat text messages.

#### Scenario: User triggers asynchronous media command
- **WHEN** a user triggers a command requiring external fetching or intensive transcoding
- **THEN** the command reacts with `⏳` on the user's command message
- **AND** omits temporary "please wait" chat text bubbles.
