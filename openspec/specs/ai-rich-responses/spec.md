# ai-rich-responses Specification

## Purpose
Allows AI command responses to render using Meta-AI rich response format on WhatsApp, including syntax-highlighted code blocks, tables, and suggestions.

## Requirements

### Requirement: Rich Formatting for AI Responses
The AI command handler SHALL dispatch responses through MsgBuilder with rich formatting enabled when sending to WhatsApp.

#### Scenario: AI generates markdown with code or tables
- **WHEN** the AI response contains markdown tables or code blocks
- **THEN** the message is dispatched as an AIRich payload with submessages and unified response sections

### Requirement: Graceful Plain Text Fallback
The messaging layer SHALL automatically fall back to sending plain text if the interactive or rich message relay is rejected or throws an error.

#### Scenario: Transport lacks socket or server rejects rich message
- **WHEN** the socket cannot relay the rich payload or emits a rejection status
- **THEN** the message fallback text is sent via standard sendText
