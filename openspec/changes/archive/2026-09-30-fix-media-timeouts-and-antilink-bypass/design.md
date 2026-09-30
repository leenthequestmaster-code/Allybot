# Design: Media Timeouts, Resource Cleanup, and Anti-Link Precision

## Context

See `proposal.md` for background. Allybot operates as a 24/7 WhatsApp bot daemon in a 2GB RAM environment. Node.js spawns Python helpers for compute-heavy media operations. Subprocesses running indefinitely directly threaten process memory and stability. Furthermore, regex-based security controls must avoid heuristic substring comparisons that permit bypasses.

## Goals / Non-Goals

**Goals:**
- Provide a robust subprocess execution wrapper with deterministic timeout and SIGKILL cleanup.
- Guarantee cleanup of `/tmp` assets generated during `!qc` commands.
- Harden `isCurrentGroupInviteLink` to use exact invite code equality.

**Non-Goals:**
- Rewriting Python helper scripts in native TypeScript or changing their external interfaces.
- Modifying antilink action policies (warn vs kick) or group admin exemptions.

## Decisions

### 1. `runPythonScript` helper function
- **Choice**: Introduce a reusable helper `runPythonScript(scriptPath: string, args: string[], options?: { timeoutMs?: number })` that manages child process lifecycle:
  - Hooks `error`, `close`, and stderr buffering.
  - Registers a `setTimeout` watchdog (default 25,000ms).
  - On timeout: sets a settled flag, invokes `child.kill('SIGKILL')`, and rejects with `new Error('Python execution timed out')`.
  - Ensures listeners are stripped and timer cleared on completion.
- **Alternative considered**: Relying on external shell `timeout` command. Rejected because native Node.js process management provides cleaner cross-platform signal handling and error capture without shell dependency.

### 2. Strict `finally` unlinking for Quote Chat
- **Choice**: Track `avatarPath` and `outPath` in outer scope and execute `await Promise.allSettled([unlink(avatarPath), unlink(outPath)])` in `finally`.
- **Alternative considered**: Background cron cleanup of `/tmp`. Rejected because instant cleanup prevents temporary storage spike under high load.

### 3. Invite code tokenization
- **Choice**: Extract the code component via regex `(?:chat\.whatsapp\.com\/)([a-zA-Z0-9_-]+)` and compare `code === currentInviteCode`.
- **Alternative considered**: Checking `cleanUrl === cleanInvite`. Rejected because legitimate query parameters or URL prefixes would fail equality tests.

## Risks / Trade-offs

- [Risk]: Complex `generate-bratvid.py` rendering may exceed 25s for 150-char inputs on slow CPU.
  → Mitigation: Set `bratvid` timeout higher (45s) while keeping single-image scripts at 20-25s.
- [Risk]: Group invite links may contain trailing query parameters (e.g. `?context=...`).
  → Mitigation: Regex matches the core alphanumeric code `[a-zA-Z0-9_-]+` directly, ignoring following query parameters.
