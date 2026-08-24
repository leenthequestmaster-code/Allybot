# R2 Moderation Actions — Architecture Brief

## Current ground truth

The current `WhatsAppPort` exposes `sendText`, group metadata, invite lookup, image/profile capabilities, and lifecycle methods. It does not expose participant mutation, group settings mutation, or delete-message. The adapter wraps Baileys socket calls with bounded timeouts and normalized group metadata. The permission resolver already performs a live group metadata lookup and allows `group.admin` for admin/superadmin.

Baileys `7.0.0-rc14` locally exposes `groupParticipantsUpdate(jid, participants, action)` and `groupSettingUpdate(jid, setting)`. The local type for participant action is `add | remove | promote | demote | modify`. The R2 contract intentionally excludes `modify` because the product requirement only covers the four explicit participant actions. Delete content exists upstream, but the local CoreMessage/storage boundary is insufficient for a correct group message key.

## Chosen boundary

R2 remains inside the modular monolith:

```text
Command plugin
  -> R2 domain service (validation, feature flag, policy, role recheck, idempotency, audit)
      -> optional WhatsAppPort moderation capability
          -> Baileys adapter (JID normalization, timeout, typed result, redacted transport error)
```

The plugin never accesses the raw socket. The domain service owns action invariants and operation state. The adapter owns protocol-specific participant/settings calls. R0-S remains the only policy/audit/rate/safe-action facade.

## Additive contracts

`WhatsAppPort` receives optional methods:

- `groupParticipantsUpdate(groupJid, participantJids, action): Promise<readonly WhatsAppGroupParticipantActionResult[]>`
- `groupSettingUpdate(groupJid, setting): Promise<void>`

The result maps upstream status and participant identity into a bounded typed result. It does not expose Baileys `BinaryNode`, raw errors, or raw response payloads. Existing fake adapters that do not implement the optional methods remain source-compatible.

The service accepts a `ModerationActionRequest` with group, actor, action, target list or setting, mode, and correlation key. It returns a typed `planned | completed | denied | failed | duplicate` result. Correlation keys are validated bounded identifiers; state is persisted in an additive R2 operation table so restarts cannot silently repeat a completed mutation.

## Data ownership and transaction order

R2 owns `group_moderation_operations`. The record includes a generated operation ID, group hash, actor hash, action, target hash/count, setting, mode, status, correlation hash, timestamps, expiry, and safe outcome code. Raw JID and message content are never persisted in this table.

The sequence is:

1. Validate group, actor, target count, action/setting, and correlation key.
2. Confirm feature flag `group.moderation.actions` and safe action registration.
3. Evaluate the R2 policy and consume the bounded mutation rate profile.
4. Re-read group metadata and confirm actor is admin/superadmin and bot is admin/superadmin.
5. Insert an operation intent with a unique `(group, correlation)` constraint. Existing completed/started records return duplicate without transport replay.
6. If dry-run, mark preview completion and emit audit; do not call the adapter.
7. If enabled, call the optional adapter method with a 20-second timeout and no automatic retry by default.
8. Persist completed/failed status and emit safe completion audit. Post-commit audit failure must not claim the transport was rolled back.

The operation table is additive. On rollback to the previous artifact, the unused table is inert and the previous binary does not read it. No destructive migration is required.

## Alternatives rejected

| Alternative | Decision | Reason |
|---|---|---|
| Raw socket access from plugin | Reject | Bypasses adapter boundary, timeout/error policy, and testability |
| Separate moderation microservice | Reject | No scale/failure-domain evidence; adds network/auth/operational complexity |
| Store full inbound WAMessage history for delete | Defer | Violates default no-passive-full-chat-memory and expands privacy/storage scope |
| Reuse R1 cases as operation state | Reject | R1 owns trust/safety case lifecycle; mixing transport operation state would create cross-domain coupling |
| Automatic transport retry | Defer | Mutating participant/settings operations may partially succeed; retry requires idempotency evidence from upstream |

## Failure and observability behavior

Permission or feature denial returns a stable user-facing text response and an audit event. Missing optional adapter capability returns `capability_unavailable` without invoking any raw fallback. Timeout returns `transport_timeout`; upstream failures return only safe error name/category in logs and a stable generic response. Partial per-participant results are mapped individually, while the operation record stores aggregate outcome and success/failure counts.

No group target, phone number, message content, credential, raw error, or Baileys response node is written to audit metadata. Correlation IDs are safe bounded IDs and hashes are used for actor/group/target storage.

## Rollout and rollback

R2 ships with the feature flag off. CI verifies dry-run and adapter fixtures. Production deployment initializes only additive state and smoke-tests service initialization. Enabling a real production group is not part of this deployment gate; live WhatsApp acceptance is deferred until final phase. Rollback is previous sanitized artifact plus flag off; no database destruction or session reset.

## Review triggers

Revisit this design before adding delete-message, automatic retries, join-request actions, bulk actions above the bounded target limit, or any passive message retention. Each requires a new contract and threat-model decision.
