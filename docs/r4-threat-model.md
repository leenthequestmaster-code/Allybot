# R4 Privacy-first Knowledge — Threat Model

## Trust boundaries

| Boundary | Threat |
|---|---|
| Quoted WhatsApp message → plugin | User assumes quote is automatically safe or public |
| Plugin → knowledge service | Feature flag/scope bypass |
| Knowledge service → SQLite | Cross-group ID, private visibility leak, stale retention |
| Source excerpt → later assistant | Prompt injection treated as instruction |
| Delete/export → storage | Residual content in hot/archive/cache/provider |
| WhatsApp key/reference → domain | Fabricated full WAMessageKey or unsafe `chatModify` |

## Controls

| Abuse case | Control | Residual limitation |
|---|---|---|
| Passive full-chat memory | No event listener for history sync; only `CoreMessage.quotedText` on explicit command | Future provider must receive typed approved bundle only |
| Cross-group source ID | Every lookup predicates `group_jid`; prefix resolver returns only unique in-group record | UUID prefixes remain intentionally short in UX |
| Private source leak | `visibility='private'` filtered to creator for list/read/export | Moderator access is not implicit; creator must delete or future policy must define explicit recovery |
| Retention bypass | Active lookup retires records at deadline and filters expired active records | Archive migration/provider purge is not yet integrated because R4 has no external provider |
| Prompt injection in excerpt | Excerpt is data-only in R4; no LLM execution/context path exists | R11 must add typed context bundle and labeling |
| Sensitive source capture | Bounded title/excerpt and sensitive-looking content rejection | Heuristic is not DLP; never treat it as complete secret detection |
| Delete bypass | Creator-owned delete only, feature flag checked, excerpt cleared from hot record | SQLite forensic deletion is not claimed; backup policy remains outside service |
| Export abuse | Actor-scoped visibility, bounded 50 records, audit count only | User-facing export file is not created in this slice |
| Unsafe native mutation | No reaction/pin/star/forward/edit/delete/read methods introduced | Full key storage contract remains deferred |

## Security review outcome

R4 is safe to enable only per group after an admin explicitly activates it. It must remain disconnected from AI providers, passive event ingestion, and account-global WhatsApp operations. Any future assistant integration must treat source text as untrusted data, require approved status and scope, enforce retention, and prevent source content from becoming tool instructions.
