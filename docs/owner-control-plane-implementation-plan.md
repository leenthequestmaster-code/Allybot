# Owner Control Plane — Implementation Plan

## Outcome

Allybot akan memiliki **Owner-Controlled Developer Mode** di atas static Owner authorization yang sudah ada. Owner dapat mengaktifkan mode untuk target tertentu, memilih scope, menetapkan expiry, melihat status, mencabut activation, dan melakukan emergency disable. Target Developer Mode dapat memakai command observability read-only melalui namespace `!dev` hanya dari private chat.

Developer Mode bukan role independen. Ia adalah activation record dan capability sementara yang dikendalikan Owner.

## Acceptance criteria

| ID | Kriteria | Verifikasi |
|---|---|---|
| AC-01 | Owner tunggal existing tetap menjadi sumber otoritas | Negative/positive permission tests |
| AC-02 | Activation memiliki target, scope, expiry, reason, owner actor, dan identifier | Service contract/integration tests |
| AC-03 | Target tanpa activation aktif selalu ditolak | Negative tests |
| AC-04 | Activation yang expired otomatis ditolak | Fake-clock test |
| AC-05 | Revoke berlaku pada request berikutnya tanpa restart | Integration test |
| AC-06 | Emergency disable menolak seluruh Developer Mode | Integration test |
| AC-07 | Developer Mode hanya menerima private-chat request pada MVP | Group negative test |
| AC-08 | Semua allow/deny/activate/revoke/expire/kill tercatat sebagai audit event bounded | Audit assertions |
| AC-09 | Output tidak memuat JID target, database path, credential, session, raw logs, atau message body | Redaction tests |
| AC-10 | Tidak ada eval/exec/shell/arbitrary file/network action | Static scan/diff review |
| AC-11 | Public Technical Commands tidak berubah behavior | Existing full regression suite |
| AC-12 | Migration additive dan rollback berupa disable/drop new tables only | Schema review |

## State model

```text
ABSENT
  └─ Owner activates target + scope + expiry ─> ACTIVE
ACTIVE
  ├─ clock >= expires_at ─> EXPIRED (deny + audit)
  ├─ Owner revokes ─> REVOKED (deny + audit)
  └─ Owner emergency disables global mode ─> DISABLED (deny + audit)
```

An activation is valid only when it is active, unexpired, globally enabled, and its scope includes the requested capability. `observer` is the only executable scope in the first vertical slice. `operator` can be stored as a future capability but no mutating developer command is enabled until its action boundary and tests exist.

## Threat model

Assets include WhatsApp session/auth state, SQLite databases, owner identity, private runtime metadata, source/deployment details, and group/member data. The main threats are a leaked target identity, a forged sender JID, a developer command used in a group, expired access remaining valid, an audit trail that leaks secrets, and a debug handler growing into arbitrary execution.

The design mitigates these threats with server-side sender checks, owner-controlled activation records, private-chat enforcement, default-deny, expiry at every request, bounded audit storage, output redaction, explicit command allowlists, and no dynamic code or shell execution.

## Data boundary

A new service may use the existing core SQLite database path with additive tables. It must not reuse or modify `auth_creds`, `auth_keys`, or `messages` rows. The service owns only its prefixed tables and closes its database handle during framework shutdown.

## Command contract for first slice

| Command | Actor | Scope | Effect |
|---|---|---|---|
| `!dev help` | Owner or active target | observer | Show allowlisted read-only commands |
| `!dev enable <target> <observer> <minutes> [reason]` | Owner | owner control | Create activation; private chat only |
| `!dev status` | Owner or active target | observer | Show safe mode status; target sees only own activation |
| `!dev disable <activation-id>` | Owner | owner control | Revoke an activation |
| `!dev kill` | Owner | owner control | Disable all Developer Mode access |
| `!dev resume` | Owner | owner control | Re-enable global Developer Mode without restoring revoked activations |
| `!dev runtime` | Active target | observer | Safe runtime snapshot |
| `!dev connection` | Active target | observer | Safe connection state |
| `!dev commands` | Active target | observer | Command names/categories/permissions only |
| `!dev services` | Active target | observer | Registered service names only |

The first slice deliberately excludes `!dev logs`, raw database inspection, `!dev exec`, `!dev reload`, `!dev reconnect`, `!dev logout`, and mutating operator actions.

## Compatibility and rollout

Existing `bot.owner`, group permissions, Public Technical Commands, menu behavior, and startup configuration remain unchanged. The new command is hidden from the public menu. If Developer Mode service initialization fails, startup must fail closed rather than run with an unknown authorization state. A later feature flag can disable the namespace globally without changing the existing Owner resolver.

## Review gates

Before deployment, run typecheck, build, platform parity, full test suite, negative authorization tests, fake-clock expiry tests, audit redaction checks, `git diff --check`, and a static scan for credential/arbitrary execution patterns. Deployment of the implementation is separate from the already-applied runtime Owner `.env` change.
