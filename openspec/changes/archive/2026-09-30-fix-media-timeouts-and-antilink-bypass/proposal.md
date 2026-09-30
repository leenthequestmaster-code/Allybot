# Proposal: Fix Media Timeouts and Anti-Link Bypass

## Why

Codebase audit identified two critical resilience and security risks in Allybot:
1. Long-running or frozen Python subprocesses (`smeme`, `brat`, `bratvid`, `qc`, `spack`, `status-card`) lack timeout controls, risking node event loop starvation and VPS OOM crashes under concurrency or malicious inputs. Additionally, quote chat (`!qc`) leaves temporary avatar and sticker files uncollected in `/tmp`.
2. Anti-link evaluation accepts inverse substrings (`cleanInvite.includes(cleanUrl)`), allowing attackers to bypass anti-link protection by posting generic or truncated WhatsApp URLs (e.g. `chat.whatsapp.com` or `chat.whatsapp.com/`).

## What Changes

- **Subprocess Timeout Guard**: Add bounded execution timeout (default 25s) with `SIGKILL` cleanup to all `python3` subprocess spawns across media plugins and services.
- **Resource Cleanup in `!qc`**: Wrap Quote Chat temporary avatar and sticker generation in `try...finally` ensuring `unlink()` executes reliably.
- **Exact Group Invite Code Matching**: Replace substring inclusion with regex extraction of WhatsApp group invite codes (`chat.whatsapp.com/([a-zA-Z0-9_-]+)`) to verify exact equality.

## Capabilities

### New Capabilities
- `media-pipeline-hardening`: Subprocess timeout watchdog and guaranteed `/tmp` cleanup on media generation tools.
- `antilink-exact-invite-matching`: Strict token-based invite code comparison for WhatsApp group link moderation.

### Modified Capabilities
<!-- None -->

## Impact

- `src/framework/plugins/media.ts`
- `src/services/spack-session.ts`
- `src/services/status-card-renderer.ts`
- `src/utils/link-matcher.ts`
- `tests/automod-hardened.test.js`
