# Curator Audit Pass — 2026-04-26

**Owed by:** Architect (S298 cleanup handoff open item)
**Author:** Architect main pane, S300
**Method:** Per `feedback_no_orphan_artifacts.md` — anything without a verified live consumer = candidate for hard-delete. Quarantine is itself an anti-pattern.

---

## TL;DR — Reclaimable space in the obvious-junk tier alone

| Bucket | Files | Size | Recommendation |
|---|---|---|---|
| `.squidrun/cleanup-quarantine/` | (dir) | **1.1 GB** | DELETE WHOLESALE — this is the exact orphan-quarantine pattern S298 said never to keep |
| `.squidrun/tmp/` | many | **519 MB** | DELETE WHOLESALE — old HeadlessChrome dirs + scratch txt |
| `.squidrun/runtime/team-memory.pre-clean-1775246348462.sqlite` | 1 | **752 MB** | DELETE — pre-clean snapshot of live DB (live DB is `team-memory.sqlite` 1.07GB) |
| `workspace/temp-oracle-consultation-*.json` | 190 | **190 MB** | DELETE — stale oracle consultation requests, replaced by current pipeline |
| `workspace/temp-arch-consultation-*.txt` | 83 | **83 MB** | DELETE — stale architect consultation outputs |
| `workspace/temp-james-*.txt` | 156 | ~few MB | DELETE — outbound Telegram drafts already sent |
| `workspace/temp-oracle-*.txt` (non-consultation) | 45 | small | DELETE — outbound Oracle drafts |
| `workspace/temp-builder-*.txt` | 28 | small | DELETE — outbound Builder drafts |
| `workspace/temp-team-*.txt` | 26 | small | DELETE — outbound team drafts |
| `workspace/temp-email-*.html` | 4 | **17 MB** | DELETE — Apr 7 email drafts already sent |
| `workspace/temp-{chess,strategic,trading,session*,peer,pushback,qeline}*.txt` | 8 | small | DELETE — one-shot drafts |

**Total Tier 1 reclaim: ~2.65 GB across ~540 files.** Zero risk — none has a live consumer.

---

## Tier 2 — Stale state files at workspace root (Feb dates, no recent touch)

These are state files for systems that either no longer exist or have moved to `.squidrun/runtime/`. Likely safe to delete; flagging individually so you can veto.

| File | Date | Size | Why kill |
|---|---|---|---|
| `workspace/console.log` | Feb 27 | 1.5 MB | Dev console capture, 2 months stale |
| `workspace/mem-monitor.log` | Feb 12 | 1.2 KB | Defunct mem monitor (no consumer in current `hm-*.js`) |
| `workspace/perf-jest.json` | Feb 19 | 1.3 MB | One-shot perf snapshot |
| `workspace/perf-profile.json` | Feb 27 | 16 KB | One-shot perf snapshot |
| `workspace/all_claims.json` | Feb 15 | 769 KB | Paired with `inspect_claims.js` — extraction one-off |
| `workspace/inspect_claims.js` | Feb 15 | 385 B | One-off script, no scheduler reference |
| `workspace/contract-stats.json` | Feb 27 | 253 B | Stale; current is `.squidrun/runtime/contract-stats.json` |
| `workspace/schedules.json` | Feb 14 | 66 B | Empty/stale schedules |
| `workspace/state.json` | Feb 21 | 374 B | Stale; current state lives under `.squidrun/runtime/` |
| `workspace/task-pool.json` | Feb 14 | 63 B | Empty stale |
| `workspace/message-state.json` | Feb 21 | 441 B | Stale; current routing in runtime |
| `workspace/image-gen-history.json` | Feb 19 | 7 KB | Stale; current is `.squidrun/image-gen-history.json` |
| `workspace/backup-config.json` | Feb 27 | 807 B | Verify nothing reads it; if not — kill |
| `workspace/war-room.log` | (check) | (check) | Verify last-touch; likely dead |

**Tier 2 reclaim: ~3 MB, ~14 files.** Low risk pending a quick consumer-grep on `backup-config.json`.

---

## Tier 3 — Needs your eye before I touch

### NurseCura business-plan files at workspace root
S298 confirmed v4/v5 are real and recovered from stash; v1/v2/v3 may be superseded drafts.
- KEEP: `NurseCura_사업계획서_v5_femtech.{html,pdf}`, `NurseCura_사업계획서_v5_femtech_nomargin.pdf`, `NurseCura_사업계획서_v5_femtech_preview.png`, `NurseCura_사업계획서_v4.{html,pdf}`
- ASK: `_v3.{html,pdf}`, `_v2.html`, `_v1` (.html), `_완성본.docx`, `_서비스흐름도.html`, `nursecura-logo.svg`, `generate-bizplan-docx.js`
  → Question for you: is anything still iterating on v3 / v2? If not, kill them and keep v4+v5 only.

### `workspace/` non-temp scratch
- `workspace/「2026년 제27회 여성창업경진대회」 참가신청서.hwp` — 은별 contest application. KEEP (active doc).
- `workspace/sweep-2026-04-25-builder.md` and `workspace/sweep-2026-04-25-oracle.md` — yesterday's sweep notes. ASK: roll into S298 handoff and delete? Or preserve as audit trail?
- `workspace/builder-cleanup-status.md` and `workspace/oracle-cleanup-status.md` — also S298-era cleanup logs. Same question.
- `workspace/v5-femtech-{nomargin-,}proof.{pdf,png}` — verification artifacts for the NurseCura v5 PDF. KEEP if 은별 might re-reference; otherwise kill.

### `workspace/hillstate-consumer-filing-outline-2026-04-17.txt`
Active 힐스테이트 case work-in-progress. KEEP.

---

## Tier 4 — `.squidrun/` top-level orphan-script suspects

These look like one-off debugging scripts that ended up at the wrong layer (should never have been at `.squidrun/` root):

| Path | Suspicion |
|---|---|
| `.squidrun/fetch-candles.js` | One-off candle-fetch script — verify no daemon imports it, then kill |
| `.squidrun/fetch-orders.js` | Same as above for orders |
| `.squidrun/tmp-layerb.patch` | Stray patch file — definitely orphan |
| `.squidrun/console.log` | Dev capture |
| `.squidrun/perf-profile.json` | Stale perf snapshot |
| `.squidrun/image-gen-history.json` | Compare to `workspace/` copy — keep newer, kill the other |

Action: 5-min consumer-grep on each, then kill what has zero references.

---

## Deferred to a separate pass (NOT in this batch)

- **`ui/scripts/hm-*.js` keep/kill** — 100 scripts, 1.5 MB total. Each needs a live-consumer check (settings.json schedules, supervisor-daemon imports, hook references, README/workflows mentions). This is a careful-pass job — putting it in its own document so this batch stays decisive and reviewable. Filing as `workspace/drafts/curator-audit-scripts-2026-04-26.md` next.
- **`ui/settings.json` flag audit** — every flag's call-site, every dead flag killed. Same reasoning.
- **`workspace/knowledge/` doc audit** — most docs are still referenced by CLAUDE.md or memory; lower-priority cleanup.
- **`.squidrun/runtime/` deeper sweep** — beyond the obvious 752 MB pre-clean snapshot, the rest is mostly active state. Defer.

---

## Proposed execution order

1. **You scan this doc.** Veto anything that should stay.
2. **I delete Tier 1 wholesale** (one batch, ~2.65 GB freed). One-time archive of `.squidrun/cleanup-quarantine/` to nothing — the whole point of the rule is no second chance for trash.
3. **I run consumer-greps on Tier 2 and Tier 4**, kill clean items, report back any that grep hit.
4. **You answer the Tier 3 questions.** I delete based on your answers.
5. **Next pass:** scripts/flags audit doc.

Ready to start step 2 the moment you greenlight (or veto with edits).
