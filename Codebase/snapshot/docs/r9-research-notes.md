# R9 Research Notes

## Decision question

Bagaimana Event Conductor menyimpan waktu dan menjalankan multi-phase event secara restart-safe tanpa dependency baru, duplicate delivery, atau ambiguity DST pada runtime Node.js 22 dan SQLite existing?

## Evidence ledger

| Claim | Source | Scope/version | Evidence | Limitation |
|---|---|---|---|---|
| Node `setInterval` returns a Timeout that can be cleared and can be `unref`'d so it does not keep the event loop alive by itself | [Node.js Timers documentation](https://nodejs.org/api/timers.html) | Official docs page retrieved 2026-08-18; page labels Node v26.7.0, while project runtime is Node >=22 | The docs state `setInterval()` returns a Timeout, `clearInterval()` cancels it, and `timeout.unref()` prevents the timer from keeping the event loop active | The page is not pinned to Node 22; local project behavior and existing R3 usage are the compatibility evidence for this repository |
| RFC 3339 timestamps represent an instant with a stated relationship to UTC; local time rules can be changed by authorities and create ambiguity | [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) | Standards Track, July 2002; updated by RFC 9557 | The RFC defines timestamps as unambiguous instants and recommends UTC for interoperability where local daylight-saving rules are convoluted | RFC 3339 does not solve local wall-clock recurrence or event UI formatting |
| Strict IANA timezone validation can reuse `Intl.DateTimeFormat` behavior already adopted in R5 | [MDN Intl.DateTimeFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat) and local R5 probe | Node 22 project runtime; no extra dependency | R5 runtime probe and validator establish accepted IANA identifiers; event inputs can store an absolute timestamp and separately retain timezone metadata | Timezone database updates are runtime-dependent; ambiguous wall-clock input must not be silently guessed |

## Design decision

R9 will require event `startAt` and phase schedule timestamps as fully qualified ISO/RFC3339 values with an explicit offset or `Z`. The service stores epoch milliseconds as the scheduling source of truth and retains a validated IANA timezone only for presentation/provenance. It will reject unqualified local timestamps and will not convert ambiguous wall-clock strings implicitly. A persistent dispatcher will use a bounded SQLite query, CAS claim, `setInterval`, `unref`, and `clearInterval` on shutdown; restart recovery comes from persisted event/phase state rather than in-memory timers.

The dispatcher will not auto-publish canon, invent plot, or send participant messages without an explicit event operation. Notifications use existing R5 policy evaluation and are text-first. Any future recurring calendar feature must add an explicit wall-clock disambiguation contract and test against DST transitions rather than reuse the one-shot event path.

## Open questions

The current WhatsAppPort has text/image/poll primitives but no contact-card or reaction contract. R9 therefore treats `location`, `contact`, and `reaction` as optional capability paths with text fallback or capability-unavailable response; it will not add an unverified adapter method. Native calendar integration is out of scope.
