# Tasks

## 1. Anti-Link Exact Invite Code Matching

- [x] 1.1 Update `isCurrentGroupInviteLink` in `src/utils/link-matcher.ts` to extract and compare exact invite code tokens instead of inverse substring inclusion, and verify with unit tests.
- [x] 1.2 Verify `tests/automod-hardened.test.js` passes with the updated link-matcher logic.

## 2. Media Pipeline Python Subprocess Timeouts & QC Cleanup

- [x] 2.1 Implement robust `runPythonScript` helper with timeout watchdog and SIGKILL in `src/framework/plugins/media.ts` and apply to `smeme`, `brat`, `bratvid`, and `qc`.
- [x] 2.2 Add strict `try...finally` unlinking for `avatarPath` and `outPath` in `qc` handler in `src/framework/plugins/media.ts`.
- [x] 2.3 Add timeout watchdog to `src/services/status-card-renderer.ts` and `src/services/spack-session.ts`.

## 3. Verification & Build

- [x] 3.1 Run TypeScript compilation `npm run build` and ensure clean compilation.
- [x] 3.2 Run test suite to verify no regressions.
