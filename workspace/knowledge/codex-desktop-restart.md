# Codex Desktop & How SquidRun Restarts (Plain-English Source of Truth)

> One-screen answer to "what is Codex Desktop?" and "how does a restart actually happen?"
> Technical procedure + command syntax live in `infrastructure.md` ("How restarts ACTUALLY happen").
> This file is the plain-English version. If the two ever disagree, fix both in the same commit.

## What Codex Desktop is

Codex Desktop is a **separate desktop application** — ChatGPT/Codex running in **computer-use mode**
(it can see the screen, move the mouse, click, type, take screenshots). It is **not** one of the three
SquidRun panes (Architect/Builder/Oracle) and it is **not** the same thing as the Codex CLI that runs
inside the Builder pane. Think of it as a second operator sitting next to SquidRun that can physically
drive the machine.

It does three jobs for us:

1. **It physically restarts the SquidRun app.** The SquidRun panes *cannot* restart their own Electron
   app from the inside. Codex Desktop is the hand that actually closes and relaunches it.
2. **It runs a poll loop.** Roughly every ~5 minutes it checks **its own inbox** for jobs. If the inbox
   is empty, it does nothing.
3. **It owns visual proof.** Because it can see the screen, it produces screenshots and browser
   verification reports (the `.png` + `.browser-report.json` files in the attention bridge's
   `proof-packets/`).

## How a restart ACTUALLY happens (the two-box rule)

A restart needs **two** things, not one. Missing either = no restart.

- **Box 1 — the staged record:** `.squidrun/coord/restart-request.json` (written by `hm-restart-request.js`).
  This says *what* to load: the target HEAD, that the tree is clean, and why. It is the source of truth
  for the restart, **but writing it does nothing on its own.** Codex Desktop never reads `coord/`.
- **Box 2 — the trigger:** an item in **Codex Desktop's own inbox** (the *codex-attention-bridge*), queued
  with `hm-codex-attention.js create ...`. This is the thing the ~5-min poll loop actually sees and acts on.

So the rule is: **stage Box 1 AND queue Box 2. Both. Every time.** An immaculate `restart-request.json`
with an empty Codex inbox will sit there forever.

### How you know a restart really happened

**Session evidence is the proof — NOT memory.** (Corrected S442: the old "if you still remember, it didn't
restart" test became INVERTED when warm resume went production at S425/S426 — core panes now come back
**remembering everything** via `--resume` pins.) Check `app-status.json`: a real restart shows the session
number incremented and a fresh `started` timestamp, with `[resume]` spawn lines and one process per pane.
If you remember the prior session AND the session number has NOT incremented, then the restart didn't
happen. Never re-stage a restart that already worked — verify the session number first.

**Packaged-install caveat (S443, from the Eunbyeol stall trace):** a packaged (installed-exe) main process
can write NOTHING to `app.log` when the logger path is blacked out. For packaged installs (Eunbyeol's
standalone, future customer installs), verify boot via `app-status.json` session/started fields and the
process table, and read `.squidrun/runtime/boot-sequence.jsonl` for synchronous boot breadcrumbs. If
`.squidrun/runtime/logger-blackout.jsonl` exists, treat it as proof that the logger swallowed at least one
dir/write/stream failure and fall back to breadcrumbs/process evidence instead of app.log recency.

### Why there's no shortcut

There is no supported way for the SquidRun app to push a message straight into Codex Desktop's screen
(`hm-codex-desktop-transport.js` reports `can_inject_visible_message: false`, `can_summon_workspace: true`).
That missing transport is *exactly why* the ~5-min inbox poll is the only path in.

## The live file map (what's real vs. what's garbage)

**Current mechanism — the codex-attention-bridge (this is the one that matters):**
- `.squidrun/runtime/codex-attention-bridge/index.json` — the inbox index (`active_request_ids` = what's pending).
- `.squidrun/runtime/codex-attention-bridge/requests/*.json` — one file per queued job.
- `.squidrun/runtime/codex-attention-bridge/proof-packets/*` — completions + screenshots + browser reports.
- Managed by `ui/scripts/hm-codex-attention.js` (`create` / `list` / `status` / `ack` / `complete`).

**Codex health + capability:**
- `.squidrun/coord/codex-heartbeat.json` — heartbeat sink for the `squidrun-codex-wake-bridge` automation,
  checked by `hm-codex-heartbeat-check.js`. The writing automation is now **retired** (see "Legacy wake-bridge"
  below), so this is frozen and will read stale permanently. Don't treat it as the live-Codex signal — use the
  attention bridge + `hm-codex-capability-status` for that.
- `.squidrun/runtime/codex-desktop-capability-status-v0.json` — last capability probe.
- `.squidrun/runtime/codex-desktop-inbound-transport-report-v0.json` — transport probe (the "no visible inject" finding).

**Restart staging (current):**
- `.squidrun/coord/restart-request.json` — current staged record (Box 1).
- `.squidrun/coord/restart-handoff.md` — current human-readable handoff.
- `.squidrun/coord/restart-execute-log.jsonl` — append-only execution log.

**Legacy wake-bridge — the honest asymmetry (verified S405, do NOT blanket-keep or blanket-kill):**
- `.squidrun/coord/codex-inbox.jsonl` — **KEEP, but half-alive.** WRITE-side is LIVE: `hm-alignment-audit.js`
  still appends to it (resolved from `operator-registry.json` line 15 `codexInbox`). READ-side is RETIRED:
  the `squidrun-codex-wake-bridge` poller that used to consume it is **uninstalled** (Codex Desktop confirmed
  no such automation in its `.codex/automations`). **So envelopes written here right now are UNCONSUMED** —
  they go into a log nobody polls. Do **not** delete the file (it has a live writer) and do **not** touch
  `operator-registry.json` line 15 (that would break the audit tool).
- `.squidrun/coord/codex-inbox-processed.json` and `.squidrun/coord/codex-wake-bridge-status.json` —
  **RETIRED DEAD.** These were *outputs* of the now-uninstalled poller; zero in-repo reader AND zero in-repo
  writer. They will not regenerate. Removed S405; do **not** recreate them (that would be fabricating status).
- `.squidrun/coord/codex-heartbeat.json` is the same generation: its writer (the poller) is gone, so it is
  frozen (dead since May 30). It stays only because `hm-codex-heartbeat-check.js` still reads it — expect it
  to always report stale now. That's the retirement showing through, not a fault.

> Resolved (S405, Architect): `hm-alignment-audit.js` is **Architect-invoked on-demand** (a 12h audit), not
> scheduled or hooked — nothing runs it automatically, which is why the inbox froze Apr 29. So the
> "unconsumed writes" are **latent, not live** (nothing actively writes there). No action now; if the
> alignment-audit feature is ever revived, repoint it at the attention-bridge then.

**Genuine garbage (safe to remove — superseded in-app restart mechanism, pre-S396):**
- One-shot restart *execution* snapshots from the old in-app restart path: `restart-arch*.json`,
  `restart-kill-plan.json`, `restart-before/after-electron*.json`, `restart-activation-detached-*`,
  `restart-369-execute.*`, `restart-runtime-368.out`, `pre-restart-jest.json`, and timestamped one-shots
  like `restart-request-<TS>.json` / `restart-continuity-proof-<TS>.json`. These have zero live consumers;
  the in-app restart path was replaced when Codex Desktop took over restart.

## The one rule that keeps biting

The hard part is **not** the procedure — it's that the knowledge keeps dying at the session boundary and
every fresh Architect re-learns it the hard way (and James has had to re-explain it more than once). The
two-box rule and "continuity = proof" are the two things to never forget.

Related: `infrastructure.md` (technical procedure + exact command flags), and the auto-memory note
`project_restart_routing_codex_desktop`.
