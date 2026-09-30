# Spec Delta: antilink-exact-invite-matching

## Purpose

Prevents link moderation evasion by requiring exact WhatsApp group invite code verification instead of permissive substring matching.

## ADDED Requirements

### Requirement: Exact WhatsApp Group Invite Code Matching
The link matcher SHALL extract group invite codes from detected URLs and compare them strictly against the active group invite code, rejecting partial or inverse substring matches.

#### Scenario: User sends truncated or generic WhatsApp domain
- **WHEN** a user message contains `https://chat.whatsapp.com` or `chat.whatsapp.com/` without a valid group code matching the active group
- **THEN** the matcher treats the link as a forbidden link rather than whitelisting it

#### Scenario: User sends the valid active group invite link
- **WHEN** a user message contains `https://chat.whatsapp.com/<code>` where `<code>` matches the current group invite code
- **THEN** the matcher whitelists the link as the current group invite link
