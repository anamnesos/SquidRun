# Oracle Cleanup Status - 2026-04-25

## Scope

Oracle owns data/state/case cleanup for this session. Builder owns runtime/code cleanup. Large findings are written here instead of sent through agent chat because the head-truncation bug is still active until restart.

## Live Status

- Started cleanup after Architect instruction.
- Sent Architect `(ORACLE #29)` acknowledging cleanup mandate.
- Sent Builder `(ORACLE #30)` requesting coordination on memory DB rebuild/delete and DRY_RUN quarantine schema.
- Sent Architect `(ORACLE #31)` confirming duplicate MEGA watch fires remain vetoed while cleanup continues.
- Verified `workspace/knowledge/case-operations.md` currently contains stale/contradictory case state.
- Verified NurseCura files present in `workspace/`: base HTML, v2 HTML, completed DOCX, service-flow HTML, logo SVG. No v4 HTML/PDF is present.
- Rebuilt `workspace/knowledge/case-operations.md` as a canonical one-row-per-case dashboard.
- Sent Builder `(ORACLE #32)` acknowledging hold on direct DB writes; cleanup will use non-destructive manifests/eligibility notes until Builder gives schema-safe path.
- Sent Architect `(ORACLE #33)` reporting the case dashboard rebuild and NurseCura v4 missing/unverified correction.
- During v4/v5 audit, found `stash@{0}` dated 2026-04-18 containing untracked NurseCura v3/v4/v5 artifacts.
- Restored missing NurseCura artifacts from `stash@{0}^3` without applying the full stash or touching Builder runtime/code changes.
- Updated `workspace/knowledge/case-operations.md` again: NurseCura v4/v5 are now marked recovered from stash, not missing.
- Answered consultation `consultation-1777159845819-7nwt4w` before deadline; no cleanup pivot or trade execution.
- Sent Architect `(ORACLE #34)` and Builder `(ORACLE #35)` reporting NurseCura recovery.
- Sent Builder `(ORACLE #36)` confirming DRY_RUN/cognitive cleanup remains manifest-only until source gates land.
- Wrote non-destructive data/state manifest at `workspace/drafts/oracle-data-state-manifest-2026-04-25.md`.
- After Architect approval, annotated team-memory stale references and comms historical/superseded rows in-place. Backups/snapshots are under `.squidrun/cleanup-quarantine/2026-04-25-oracle-db-backup/`.

## Work Queue

1. Rebuild `workspace/knowledge/case-operations.md` as a canonical one-row-per-case dashboard. **Done.**
2. Audit whether NurseCura v4 was actually created using comms journals, transcript indexes/transcripts, `.claude/projects`, and git history. **Done: v4/v5 were real and recovered.**
3. Coordinate memory drift cleanup with Builder before touching memory DB/state. **Partially done: approved team-memory stale-reference annotations completed; cognitive-memory rebuild still Builder-held.**
4. Coordinate DRY_RUN/paper-comp quarantine schema with Builder before DB writes. **Manifest done; DB writes held.**
5. Annotate historical cross-window leakage rows without deleting audit trail. **Done.**
6. Produce NurseCura completion handoff if v4 was never real or cannot be recovered. **Not needed as originally framed; v4/v5 recovered. Handoff now says review recovered v5, do not rebuild from scratch unless review fails.**

## Findings And Actions

### A. Case Dashboard Rebuild

Action taken: replaced the stale dashboard with a canonical table for Jeon, Hillstate, Qeline, and NurseCura. The new file marks NurseCura v4 HTML/PDF and `tools/inject-evidence-images.js` as missing, not shipped. It also resolves the previous Channel A contradiction by marking the 2026-04-27 19:20 KST broadcast as high-confidence/confirmed from 2026-04-24 call notes, while leaving Haeundae police cleanup as an open question.

Files changed:
- `workspace/knowledge/case-operations.md`

Update: after the NurseCura stash recovery, the dashboard was corrected again. It now marks v4/v5 as recovered on disk and leaves only `tools/inject-evidence-images.js` missing.

### B. NurseCura v4/v5 Audit

Audit method used:
- Queried both active comms ledgers:
  - `.squidrun/runtime/evidence-ledger.db`
  - `.squidrun/runtime-eunbyeol/evidence-ledger.db`
- Searched `.squidrun/runtime/transcript-index.jsonl`.
- Searched Claude project transcripts under `C:\Users\James Kim\.claude\projects\D--projects-squidrun`.
- Checked git history and stash history.
- Searched live workspace and profile-scoped Eunbyeol workspace for `NurseCura*` artifacts.

Result:
- v4 and v5 were real. They were not merely hallucinated in the case dashboard.
- Current visible workspace initially had only base/v2/DOCX/service-flow/logo files.
- `git stash list --date=iso` showed `stash@{0}` from `2026-04-18 09:24:10 -0700`: `session-282 WIP — uncommitted trading + injection edits, untracked tests/scripts`.
- `git stash show --name-status --include-untracked stash@{0}` showed untracked NurseCura v3, v4, and v5 femtech artifacts were captured by that stash.
- Because the files were untracked, they lived under `stash@{0}^3`, not the main stash tree.

Recovery performed:
- Restored only the NurseCura artifact paths from `stash@{0}^3`.
- Did not apply or pop the stash.
- Did not overwrite any existing target files.

Recovered files:
- `workspace/NurseCura_사업계획서_v3.html` (40,902 bytes)
- `workspace/NurseCura_사업계획서_v3.pdf` (196,208 bytes)
- `workspace/NurseCura_사업계획서_v4.html` (46,210 bytes)
- `workspace/NurseCura_사업계획서_v4.pdf` (361,071 bytes)
- `workspace/NurseCura_사업계획서_v5_femtech.html` (53,955 bytes)
- `workspace/NurseCura_사업계획서_v5_femtech.pdf` (390,492 bytes)
- `workspace/NurseCura_사업계획서_v5_femtech_nomargin.pdf` (390,533 bytes)
- `workspace/NurseCura_사업계획서_v5_femtech_preview.png` (1,774,455 bytes)
- `workspace/v5-femtech-proof.pdf`
- `workspace/v5-femtech-nomargin-proof.pdf`
- `workspace/v5-femtech-proof.png`

Key evidence:
- `runtime-eunbyeol` comms row `234` at `2026-04-17T08:18:52.059Z`: Architect verified v5 files on disk and keyword-audited `5.23조`, `60조`, `펨테크`, `기초응용형`, `큐레이션 알고리즘`, B2B 산후조리원 content, and 여성기업확인서 commitment clause.
- Claude transcript `C:\Users\James Kim\.claude\projects\D--projects-squidrun\b057be7b-7735-47cc-bb86-acedcb0706eb.jsonl` records the Builder-side WIP stash that swept untracked `workspace/NurseCura_사업계획서_v3.html`, `v4.html`, and `v5_femtech.html` into stash on 2026-04-18.
- Current `workspace/NurseCura_사업계획서_v5_femtech.html` keyword check confirms the femtech content is present.

Conclusion:
- Agents did not simply invent v4/v5. The artifacts existed.
- The visible loss was caused by untracked artifact files being captured into the 2026-04-18 WIP stash and never restored into the live workspace.
- The case-ops document became false only after that stash event made the files disappear from disk.

Reusable audit pattern for future "did this actually happen?" questions:
1. Check current disk and profile-scoped workspaces.
2. Query both comms ledgers for claims, delivery rows, and row IDs.
3. Search transcript index for exact filenames and claimed outputs.
4. Search Claude project transcripts for tool calls, file writes, and shell output.
5. Search git history plus stashes, including `stash@{n}^3` for untracked files.
6. Recover only exact missing artifacts; never pop/apply broad stashes into a dirty worktree.

### C. Data/State Manifests And Approved Annotations

Action taken: wrote `workspace/drafts/oracle-data-state-manifest-2026-04-25.md`.

Contents:
- DRY_RUN trade-journal quarantine candidates: `trades` IDs `22-42` (`ETH/USD` `SELL`, `DRY_RUN`, 2026-04-22).
- Stale live-position candidate: `positions` row `47` (`ETH/USD`, opened 2026-04-15), not current Hyperliquid live truth.
- Paper-competition archive/static marker for `workspace/agent-trading/*.json` and `_archived_paper_trading/paper-trading-actions.jsonl`.
- Cognitive-memory manifest: root `.squidrun/runtime/cognitive-memory.db` is 0 bytes and should be rebuild target, not proof of active memory.
- Team-memory stale-reference candidates: `tools/inject-evidence-images.js`, `telegram-routing.json`, `hm-capa...`, `news-scan-supervisor-state.json`, and stale/historical packaged-route warning entries.
- Comms journal annotations: leakage row IDs are historical after Architect row `44117`; row `44157` is superseded by NurseCura recovery.

Approved DB annotations performed:
- `.squidrun/runtime/team-memory.sqlite`: annotated `memory_recall_items` rowids `18,22,30,36,40,47,64,81,88,105,112,118,168,172,179,208,215,220,228,233,240,257,306,311,324,329,371,372,378,383,414,420,438,449,455,462` for stale `cognitive-memory.db` active-claim wording; row `109` for stale `telegram-routing.json` routing-authority wording; row `560` for stale `hm-capa` command wording; row `303` for stale `news-scan-supervisor-state.json` current-state wording.
- No team-memory row currently contains `inject-evidence-images.js`; no row was fabricated.
- `.squidrun/runtime/evidence-ledger.db`: annotated comms rows `39856,39672,39650,39245` as historical cross-window leakage resolved at row `44117`; annotated row `44157` as superseded by NurseCura v4/v5 recovery.
- `.squidrun/runtime-eunbyeol/evidence-ledger.db`: annotated comms rows `1173,1171,1169,1166,1159` as historical cross-window leakage resolved at row `44117`; annotated row `1097` as superseded by later Channel A reporter-call state/current case dashboard.
- Held items still untouched: DRY_RUN trade-journal quarantine, paper-comp archive markers, and cognitive-memory rebuild.

Backup note:
- `.squidrun/cleanup-quarantine/2026-04-25-oracle-db-backup/runtime-eunbyeol-evidence-ledger.preannotation.db` preserves the Eunbyeol evidence ledger before annotation.
- `.squidrun/cleanup-quarantine/2026-04-25-oracle-db-backup/team-memory.sqlite` preserves team-memory before annotation.
- The first backup attempt used the same basename for both evidence ledgers, so there is no clean pre-annotation copy of the main evidence ledger in that directory. The actual mutation was limited to the five main comms rows listed above and was verified after write.
- Removed duplicate post-annotation backup copies I had created so the quarantine directory is not carrying unnecessary multi-GB bloat. Current remaining backup footprint is about 1.12 GB.
