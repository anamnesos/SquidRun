# Oracle Data/State Cleanup Manifest - 2026-04-25

This is a non-destructive manifest. It records data/state rows that should be treated differently by source code once Builder's quarantine and profile-scope gates land. No SQLite rows were deleted or mutated by Oracle.

## 1. DRY_RUN Trade-Journal Quarantine Candidates

Source DB: `.squidrun/runtime/trade-journal.db`

Schema observed:
- `positions(id, ticker, shares, avg_price, stop_loss_price, opened_at, updated_at)`
- `trades(id, timestamp, ticker, direction, shares, price, stop_loss_price, total_value, consensus_detail, risk_check_detail, status, alpaca_order_id, notes, filled_at, reconciled_at, realized_pnl, outcome_recorded_at)`

Quarantine rule requested:
- Treat 2026-04-22 ETH/USD DRY_RUN SELL rows as archive/test-only.
- Do not include them in live PnL, live position state, or current trading context.

Rows:

| Trade IDs | Timestamp range | Ticker | Direction | Status | Reason |
|---|---|---|---|---|---|
| `22-42` | `2026-04-22 03:37:34` through `2026-04-22 05:46:16` | `ETH/USD` | `SELL` | `DRY_RUN` | Repeated dry-run executor/test loop, not live fills. |

Related stale-live candidate:

| Table | Row | Ticker | Reason |
|---|---|---|---|
| `positions` | `47` | `ETH/USD` | Open paper/live-blurred row from `2026-04-15`; does not match current Hyperliquid live snapshot. Should be excluded from live authority until reconciled. |

Implementation preference:
- Source-owned eligibility filter first.
- If schema gets an archive flag later, migrate these IDs to that flag in a controlled DB migration.

## 2. Paper-Competition Archive/Static Markers

Source files:
- `workspace/agent-trading/architect-portfolio.json`
- `workspace/agent-trading/builder-portfolio.json`
- `workspace/agent-trading/oracle-portfolio.json`
- `workspace/agent-trading/james-portfolio.json`
- `workspace/agent-trading/_archived_paper_trading/paper-trading-actions.jsonl`

Observed:
- `ui/supervisor-daemon.js` disables paper-trading automation (`SQUIDRUN_PAPER_TRADING_AUTOMATION=0`) and reports it removed/deleted.
- Portfolio files still carry open/static paper positions and periodic marks from April 18-20.

Eligibility rule:
- Treat these as archive/static paper-competition records unless paper automation is explicitly re-enabled by source config.
- Do not present them as live-running bots in startup handoffs.
- Do not blend them into Hyperliquid live-account state.

## 3. Cognitive Memory Manifest

Observed:
- `.squidrun/runtime/cognitive-memory.db` exists but is `0` bytes.
- No `.squidrun/runtime-eunbyeol/cognitive-memory.db` existed at inspection time.
- Architect approved Builder's source plan in comms row `44169`: profile-scoped runtime DBs, main one-time seed from legacy `workspace/memory`, Eunbyeol writes to `.squidrun/runtime-eunbyeol/cognitive-memory.db`, 0-byte main file becomes rebuild target.

Oracle action:
- No DB mutation.
- Manifest only, pending Builder source gates.

Eligibility rule:
- Treat `.squidrun/runtime/cognitive-memory.db` as stale/dead until Builder rebuilds/seeds it.
- Do not cite its existence as proof of working cognitive memory.
- After rebuild, re-run stale-reference audit against the rebuilt contents.

## 4. Team-Memory Stale-Reference Candidates

Source DB: `.squidrun/runtime/team-memory.sqlite`

Observed schema:
- No `memories` table in current DB.
- Relevant tables are `memory_objects`, `claims`, `memory_recall_items`.

Audit method:
- Scanned `memory_objects.content/source_trace`, `claims.statement`, and `memory_recall_items.source_path/citation/title/excerpt`.
- Extracted likely file/script/flag references and checked each against disk.
- Many raw hits were false positives from snippets, JSON fragments, or paths that need `workspace/` prefix normalization.

Update/remove candidates:

| Reference | Evidence | Current state | Action |
|---|---|---|---|
| `tools/inject-evidence-images.js` | Old case dashboard and Eunbyeol orientation rows referenced it as Builder in-progress. | Missing. | Remove/update until Builder actually creates it. |
| `cognitive-memory.db ✅` as active memory | `memory_recall_items` rowid `372` says cognitive-memory DB exists as SQLite but empty. | File is still 0 bytes. | Mark as dead/rebuild-target, not active memory. |
| `telegram-routing.json` | `memory_recall_items` rowid `109` says check whether `telegram-routing.json` is loaded. | Runtime files exist, but this is no longer safe as a standalone routing authority after the profile-aware routing fixes. | Update to current routing source (`hm-telegram-routing.js` / profile route logic) or remove as startup instruction. |
| `hm-capa...` / capability command | `memory_recall_items` rowid `560` references `node ui/scripts/hm-capa...`. | Actual script is `ui/scripts/hm-capabilities.js`; no `hm-capa` command found. | Update command reference. |
| `../../scripts/hm-telegram-routing` packaged require warning | `memory_recall_items` rowid `519`. | Source file exists as `ui/scripts/hm-telegram-routing.js`; old packaged-path warning may no longer reflect current runtime after Builder fixes. | Keep as historical incident only, not current instruction. |

References that looked missing but are normalized-path false positives:
- `knowledge/session-257-handoff.md`
- `knowledge/session-262-handoff.md`
- `knowledge/runtime-environment.md`
- `knowledge/trading-operations.md`
- `architecture-decisions.md`

These exist under `workspace/knowledge/` or as repo-root equivalents. Do not remove solely from the raw scan.

Approved annotation status:
- `cognitive-memory.db`: annotated 36 `memory_recall_items` rows, including rowid `372`, with `oracleCleanupAnnotations[].key = cognitive-memory-active-claim`.
- `telegram-routing.json`: annotated rowid `109` with `oracleCleanupAnnotations[].key = telegram-routing-json`.
- `hm-capa...`: annotated rowid `560` with `oracleCleanupAnnotations[].key = hm-capa-command`.
- `inject-evidence-images.js`: no team-memory row matched; no row was created or deleted.

## 5. Comms Journal Historical/Superseded Annotations

Do not delete these. They are audit trail. The desired behavior is to prevent future sweeps from citing them as active leaks after the live split-brain was resolved.

Historical split-brain leakage rows:

| DB | Rows | Classification | Note |
|---|---|---|---|
| `.squidrun/runtime/evidence-ledger.db` | `39856`, `39672`, `39650`, `39245` | Historical leak | Main trading runtime sent Eunbyeol/case/Korean context to user Telegram during split-brain/default-route era. |
| `.squidrun/runtime-eunbyeol/evidence-ledger.db` | `1173`, `1171`, `1169`, `1166`, `1159` | Historical leak | Eunbyeol runtime sent trading LIVE SPARK BLAST alerts during split-brain/default-route era. |

Resolution timestamp:
- Architect row `44117`, `2026-04-25T23:08:34Z`: James closed PID 13632 duplicate; one Eunbyeol parent remained.
- Treat post-`44117` leakage as new evidence only if new rows show wrong-domain delivery after this point.

Superseded rows:

| DB | Row | Superseded by | Note |
|---|---|---|---|
| main evidence ledger | `44157` | `44165` and this cleanup | Oracle initially said v4 was missing/unverified. Stash audit recovered v4/v5. |
| runtime-eunbyeol evidence ledger | `1097` | 2026-04-24 reporter-call state and updated `case-operations.md` | "Channel A never 방영 확정" was a caution at the time; current dashboard treats 2026-04-27 19:20 KST as high-confidence/confirmed from 2026-04-24 call notes. |

Approved annotation status:
- Main evidence ledger rows `39856`, `39672`, `39650`, `39245` now carry `metadata_json.oracleCleanupAnnotation.classification = historical_cross_window_leakage_resolved`.
- Main evidence ledger row `44157` now carries `metadata_json.oracleCleanupAnnotation.classification = superseded_cleanup_finding`.
- Runtime-Eunbyeol evidence ledger rows `1173`, `1171`, `1169`, `1166`, `1159` now carry `metadata_json.oracleCleanupAnnotation.classification = historical_cross_window_leakage_resolved`.
- Runtime-Eunbyeol evidence ledger row `1097` now carries `metadata_json.oracleCleanupAnnotation.classification = superseded_cleanup_finding`.

## 6. NurseCura Artifact Recovery Manifest

Recovered from `stash@{0}^3`:
- `workspace/NurseCura_사업계획서_v3.html`
- `workspace/NurseCura_사업계획서_v3.pdf`
- `workspace/NurseCura_사업계획서_v4.html`
- `workspace/NurseCura_사업계획서_v4.pdf`
- `workspace/NurseCura_사업계획서_v5_femtech.html`
- `workspace/NurseCura_사업계획서_v5_femtech.pdf`
- `workspace/NurseCura_사업계획서_v5_femtech_nomargin.pdf`
- `workspace/NurseCura_사업계획서_v5_femtech_preview.png`
- `workspace/v5-femtech-proof.pdf`
- `workspace/v5-femtech-nomargin-proof.pdf`
- `workspace/v5-femtech-proof.png`

Recovery command source:
- `git restore --source='stash@{0}^3' -- <exact NurseCura artifact paths>`

Do not pop/apply the full stash into the dirty runtime/code tree.
