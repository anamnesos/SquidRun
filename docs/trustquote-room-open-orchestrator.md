# TrustQuote Room Open Orchestrator

Status: APPROVED-DESIGN / NOT-YET-IMPLEMENTED
Approved: 2026-06-06
Owner lane: evidence/design until Architect assigns implementation

## Purpose

Make "open the TrustQuote room" one product-level path with one authoritative proof chain.

The current room can prove backend route health, startup identity, session scope, and visible readiness through separate surfaces. Those surfaces can disagree. The target design collapses the three failure seams into one orchestrated state machine and one readiness proof artifact.

## Problem

The S406 TrustQuote room audit found three independent seams that could each lie:

- Identity seam: route-owner-spawned CLIs could be alive and env-bound while still acting from stale Codex/Gemini context.
- Backend/session seam: pid, port 9979, route heartbeat, `link.json`, and `current-workstream.json` could disagree about the active session.
- Window/readiness seam: the visible window could inspect fallback pane `2`/`3` while the authoritative TrustQuote panes are `trustquote-builder` and `trustquote-oracle`.

The route-owner startup identity regression was fixed separately in `d16a0561`. This spec is the approved target design that prevents the next proof-surface split.

## Target Flow

Every product-level opener must call the same orchestrator:

- Header TrustQuote room button.
- `hm-app open-trustquote-workspace`.
- Any future user-facing "open TrustQuote room" command.

Low-level `hm-trustquote-room-route-owner.js start|stop|probe` remains a recovery primitive. It must not be treated as a complete room-open proof path unless it explicitly invokes or emits the same readiness proof.

## State Machine

The orchestrator advances in order and fails closed. Later stages cannot override missing earlier proof.

1. `requested`
   - Resolve current main session, for example `app-session-406`.
   - Resolve target room scope, for example `app-session-406:trustquote`.
   - Capture trigger source: header, `hm-app`, recovery CLI, or test.

2. `artifacts_materialized`
   - Write or refresh `D:/projects/TrustQuote/.squidrun/link.json`.
   - Write or refresh TrustQuote startup sources.
   - Write or refresh `.squidrun/runtime/window-teams/trustquote/startup-bundle.md`.
   - Write or refresh the workstream projection for the same room session.

3. `route_owner_current`
   - Read route-owner status.
   - Stop stale or non-running supervisors using terminal-safe options.
   - Start or attach the route owner for the current room session.
   - Require `state:"running"`, live pid, and matching `mainSessionScopeId` / `sessionScopeId`.

4. `agents_bound`
   - Confirm route-owner role plan includes both roles:
     - Builder: `paneId=trustquote-builder`, `SQUIDRUN_ROLE=builder`.
     - Oracle: `paneId=trustquote-oracle`, `SQUIDRUN_ROLE=oracle`.
   - Confirm both bindings use `SQUIDRUN_PROFILE=trustquote`, current `SQUIDRUN_SESSION_SCOPE_ID`, and `SQUIDRUN_PROJECT_ROOT=D:/projects/TrustQuote`.

5. `identity_proven`
   - Require fresh TrustQuote-scoped `hm-comms` check-ins from both roles under the current room session.
   - Check-in rows must prove distinct role and pane identity.
   - Example proof shape from S406:
     - Oracle row with `(TRUSTQUOTE ORACLE #1)`, `env role=oracle`, `trustquote-oracle`.
     - Builder row with `(TRUSTQUOTE BUILDER #1)`, `env role=builder`, `trustquote-builder`.
   - A green route probe cannot advance this stage by itself.

6. `route_proven`
   - Run the route-owner probe.
   - Require `canRouteTask:true`.
   - Require builder and oracle route health from `source:"client_activity"`.
   - Require embedded route bindings for `trustquote-builder` and `trustquote-oracle`.

7. `window_ready`
   - Open, register, and focus the visible TrustQuote window.
   - Readiness must inspect retargeted pane IDs `trustquote-builder` and `trustquote-oracle`.
   - Fallback pane `2`/`3` may be used only as source-pane compatibility, not as final authority.

8. `ready`
   - Emit the final readiness proof.
   - Regenerate `current-workstream.json` as a projection from the proof.
   - Return one structured result to the caller.

## Authoritative Proof

Target artifact:

`D:/projects/squidrun/.squidrun/runtime/trustquote-work-room/readiness-proof.json`

The readiness proof is authoritative. `current-workstream.json`, status widgets, and CLI summaries are projections of this artifact, not independent sources of truth.

Required fields:

- `schema`: stable proof schema id.
- `proofId`: unique id for this open attempt.
- `status`: `ready`, `blocked`, or `failed`.
- `generatedAt`: ISO timestamp.
- `trigger`: opener source and command/action.
- `gitHead`: short SHA and subject when available.
- `mainSessionScopeId`: current SquidRun app session.
- `roomSessionScopeId`: TrustQuote room session.
- `artifactProof`: paths, generated timestamps, hashes or mtimes for link, startup bundle, startup sources, and workstream projection.
- `routeOwnerProof`: pid, pidAlive, state, status path, command, route-owner version, and session match result.
- `roleBindings`: builder/oracle pane ids, roles, env, workspace, and command.
- `identityProof`: TrustQuote-scoped `hm-comms` row ids, message ids, sender, target, raw role marker, env role, pane id, timestamp, and session.
- `routeProof`: probe request ids, route health for each role, source, age, routeBinding, `canRouteTask`, blockers.
- `windowProof`: window key, visibility result, readiness result, pane ids checked, terminal shell result, blockers.
- `projection`: the exact workstream projection values written from this proof.
- `blockers`: ordered blockers with stage, reason, and source refs.

## Projection Rules

`current-workstream.json` must be generated from the readiness proof:

- `routeStatus` derives from proof `status` and route stage.
- `blockers` derive from proof blockers.
- `sourceRefs` include the proof path and proof id.
- The projection records `proofGeneratedAt` and `proofId`.

A stale workstream cannot override a newer proof. If the workstream predates the proof or contradicts it, the orchestrator must refresh it or mark it stale with source refs.

## Fail-Closed Rules

- `canRouteTask:true` without fresh identity rows means backend route healthy, room not identity-ready.
- Fresh identity rows without a current route-owner probe means roles started, room not route-ready.
- Route and identity proof without visible retargeted panes means backend usable, James-visible room not ready.
- A supervisor running for a different `app-session-N` is stale even if the pid and port are alive.
- Fallback pane `2`/`3` cannot satisfy final visible readiness unless the retargeted TrustQuote pane ids are present and usable.
- Attach-existing may bind and probe existing terminals, but it cannot fake identity proof; matching current-session check-ins must already exist or be produced by an explicit user-approved startup path.

## CLI And UI Ownership

- Header button and `hm-app open-trustquote-workspace` should both call the same orchestrator.
- Recovery CLI may expose lower-level start/stop/probe actions, but the user-facing open-room command should call the orchestrator.
- Route-owner launch/bootstrap owns startup binding for newly spawned TrustQuote agents.
- Terminal daemon remains a PTY/runtime primitive and should not own room identity.
- `current-workstream.json` is a projection, not the authority.

## Test Targets

- Green route probe but missing role check-ins blocks readiness.
- Fresh check-ins but stale supervisor session blocks readiness.
- Stale `current-workstream.json` is refreshed or marked stale from the authoritative proof.
- Workstream projection cannot contradict the latest readiness proof.
- Window readiness rejects fallback-only pane `2`/`3` when retargeted TrustQuote pane ids are absent or unusable.
- Header button and `hm-app open-trustquote-workspace` reach the same orchestrator and proof schema.
- Attach-existing path proves no startup injection or terminal kill side effects, while still requiring existing-current identity rows.
- Restart/current-session change invalidates old proof and requires a new room-session proof.

## Non-Goals

- Do not add TrustQuote autonomy, trading, customer sends, deploys, payments, webhooks, or production side effects.
- Do not remove route-owner recovery primitives.
- Do not treat this spec as implementation approval. Architect reviews before any build lands.

