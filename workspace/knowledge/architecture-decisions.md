## Cognitive Memory Antibody Architecture (Session 244)

To solve the gap of low-confidence hallucinations being grandfathered into truth, the team agreed on an async antibody worker pattern.

### Implementation Guardrails
1. **Quarantine:** Soft flag only for now. Exclude flagged nodes from default retrieval, but keep them in the DB to test the detection accuracy before building a permanent 'delete' pipeline.
2. **Worker Location:** Must live in \ui/supervisor-daemon.js\ alongside the Sleep Consolidator, operating on an idle-tick to keep the main event loop clean.
3. **Lease Invalidation (Additive Constraint):** If a memory is mid-lease during retrieval and the antibody worker flags it, it must emit an immediate invalidation event to cancel the lease, preventing contested facts from being utilized.


## Deterministic Mira Progress Accounting (Session 381)

To prevent unverified or vibes-based claims of Mira capability, the team shifted to a fully deterministic progress accounting model (`mira-progress-v0.js`).

### Implementation Guardrails
1. **No Manual Authority:** Manual percentage bumps and global_percent edits are entirely deprecated. Progress is computed exclusively from the v0 contract, Presence state, proof inputs, blocker flags, and HEAD metadata.
2. **Strict Exclusions:** Historical conversational estimates (e.g. 35-45/40) are explicitly excluded from computations.
3. **Stale State Handling:** When Presence state predates HEAD or lacks proof inputs, it correctly forces a stale/BLOCKED status (e.g., locking voice scores to 0 when blocked), preserving system truth.


## Electron Audit Remediation — Major Upgrade Deferred (Session 398)

npm-audit branch `security/npm-audit-remediation-394` was merged to main (ff). The remediation is **deliberately partial — do NOT treat the remaining audit warning as unfinished work.**

### What landed
1. **Non-Electron deps (commit `98217095`):** `overrides` block pins ~24 transitive deps (protobufjs, tar, hono, qs, lodash, minimatch/picomatch/brace-expansion families, ajv, etc.) + `ws` 8.19→8.21. Audit clean of all those.
2. **Electron vuln-class (commit `7de1fdde`):** ~964 lines of in-code mitigations (permission-request-handler scoping, IPC reply-spoof guards, window.open target scoping) + tests. Electron version NOT bumped.

### The remaining `1 high` is expected and accepted
- Installed Electron is `28.3.3` (range `^28.0.0`). `npm audit` will report **1 high** indefinitely until a version bump. The only audit-clean fix is `electron@42.3.1` — a **14-major breaking jump** forcing a full app restart.
- **Defer rationale (verified S398, not "macOS-specific" — that framing is wrong on a Windows app):** the platform-API-specific advisories target functions we never call — `grep ui/` for `setAsDefaultProtocolClient` / `setLoginItemSettings` / `moveToApplicationsFolder` = zero matches, so both Windows advisories + the macOS AppleScript one are non-reachable dead paths. The reachable cross-platform renderer/IPC class is exactly what `7de1fdde` mitigates in-code. High regression risk, low marginal benefit → parked pending an explicit James/Architect upgrade decision.
