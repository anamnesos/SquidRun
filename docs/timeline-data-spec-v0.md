# Human Timeline — Data Spec v0 (Oracle, S444)

**Product frame** (fresh-eyes agenda item 5, James full-go 2026-06-12 15:32): a "what did my team do today / what needs me" surface for James, rendered over data that already exists. **No new writers, no new collectors** — this is a read-model. If a fact isn't already recorded somewhere, v0 does not invent a recorder for it.

**Doctrine carried in**: the C4 law applies to the timeline — delivery telemetry is telemetry, not narrative. The G8 lesson applies — every entry must know which world it came from (profile/session coherence filter). The jargon firewall (fresh-eyes item 2) applies — agent language never reaches this surface untranslated.

## 1. Entry model

One timeline entry:

```
{
  id,            // stable: source + source row key
  at,            // ms epoch
  kind,          // 'you' | 'team' | 'change' | 'event' | 'needs-you'
  headline,      // ONE plain sentence, translated (rules §3)
  detail,        // optional 1-3 plain sentences; expandable
  actors,        // ['mira','builder','oracle','codex-desktop','james','system']
  refs,          // drill-down pointers: comms row_id, commit SHA, file path — the monospace lives BEHIND the tap
  needsYou,      // boolean (lifecycle §4)
  sessionNumber  // for day/section dividers
}
```

## 2. Source mapping (what becomes an entry, what never does)

**S1. comms_journal — the spine** (70.7k rows; read incrementally by row_id):
- `telegram inbound/outbound` → kind `you`. James's own conversation; already human language. Include verbatim-trimmed (headline = first sentence, detail = rest).
- `user outbound` (voice/user sends) → kind `you`.
- `ws outbound` agent-to-agent (52k rows) → **collapsed, not itemized**. Raw agent chatter never renders. Itemize ONLY rows whose body matches the milestone grammar: claim grants/releases are dropped; numbered-message bodies are clustered per conversation arc and surfaced as ONE entry when an arc CLOSES (detection: terminal markers — "PASS", "committed <sha>", "APPROVED", "CLOSED", "verdict" in the final message of a ≥3-message same-pair burst). Headline is the translated outcome, not the exchange. Everything else in the burst is reachable via refs.
- `sms`, `voice` → kind `you`, same as telegram.
- **Exclude always**: rows whose body starts with claim/release/ack-only patterns; TRIGGER duplicates (same body_hash within 120s); anything failing the profile filter (§5).

**S2. git log — kind `change`**: one entry per commit on main, headline = translated commit subject (rules §3), refs = SHA. Commits by the same author within one arc MAY cluster ("Builder landed 3 fixes to delivery verification") but v0 one-per-commit is acceptable.

**S3. ledger_sessions — dividers, not entries**: session boundaries render as day/section headers ("Session 444 started 12:46pm — restart, all agents resumed warm"). **Filter**: only sessions whose mode/profile matches the main install (the table currently contains a session-446 row written by the eunbyeol split-brain — the G8 residue; coherence filter is mandatory, match on profile in meta_json or started_at within main app-status lineage).
- `ledger_events.session.lifecycle` (1.4k rows) backs the divider detail (restart vs fresh vs resume).

**S4. ledger_events — almost entirely EXCLUDED**: `delivery.outcome` (38k) and `delivery.failed` (15k — most are the old verifier's false negatives, G3) are telemetry and never render. `intent.updated` (1.3k) is v1 candidate, not v0. `memory.consistency.repair` → one `event` entry per repair episode ("Memory drift found and repaired, 7 items"), clustered per session.

**S5. telegram_reply_obligations — needs-you source #1** (live: 11 open): an `open` obligation past half its deadline → needs-you entry "You asked about X — the team owes you a reply" (inverted: an obligation ON the team renders as status, not a demand on James; only obligations REQUIRING James's input render as needs-you). `satisfied` → close out silently or fold into the arc entry.

**S6. task-audit-items.json — needs-you source #2** (G9 finding): items with status in {needs_james_verification, pending_james_go, needs_james_input_over_time, deferred_judgment_call_with_james} → standing needs-you entries, deduped by item id, surfaced at most once per day until resolved. Headline from the item's `title` + `nextAction`, translated.

**S7. codex-attention proof packets + restart-request — kind `event`**: restarts render as one entry with outcome ("App restarted onto today's fixes — all agents came back with memory intact"). Source: restart-execute-log.jsonl terminal rows + the PASS packet.

## 3. Translation rules (the Telegram discipline, written down)

R1. **One idea per headline, ≤ 100 chars, no SHAs/ids/paths in the headline** — those live in `detail`/`refs`.
R2. **Jargon firewall vocabulary**: pane→agent's window; warm resume→"came back with memory intact"; ack/verified→delivered; trigger fallback→retry path; HEAD/commit→"saved a change"; census verdict→"review decision"; arm→helper agent. Builder maintains the dictionary as a versioned map; entries not in the dictionary fall back to R3.
R3. **Untranslatable = summarize the EFFECT, not the mechanism.** "Fixed the bug that delivered every message twice" beats any accurate description of FastTrigger replay. If neither dictionary nor effect-summary applies, the row does not render (silence beats jargon).
R4. **Outcome tense**: entries state what HAPPENED ("Builder fixed…", "Mira approved…"), never process narration ("Builder is attempting…") except live needs-you items.
R5. **No agent self-reference conventions**: strip "(ORACLE #N)" markers, role-sign-offs, protocol phrases. Names render as Mira / Builder / Oracle.
R6. **Honesty rule (surface-claim discipline applies here)**: an entry may only claim "done/fixed/working" if the source row carries its terminal evidence (commit SHA, PASS status, satisfied_at). Arcs without terminal markers render as "worked on X", not "finished X".

## 4. "Needs you" detection + lifecycle

Three sources, one queue: S5 obligations (deadline-driven), S6 sidecar items (status-driven), and **explicit asks** — a comms row to `telegram`/`user` whose body contains a question directed at James that has no subsequent inbound reply within 4h (computable from comms_journal pairing; v0 heuristic: outbound with "?" + no inbound from James in the following 4h window).
- Dedup by stable id; a needs-you entry renders ONCE at top-of-timeline until its source resolves (obligation satisfied / item status change / inbound reply detected), then converts to a normal `you`/`team` entry.
- Cap: max 5 needs-you items rendered; overflow collapses to "+N more" — a wall of demands is the permission-menu failure mode in new clothes.

## 5. World-coherence filter (G8 mandatory)

Every source read is filtered to the main profile's world: comms_journal rows by profile/window metadata where present; ledger_sessions by mode/profile; file sources resolved through the app's own data-root (never hardcoded paths). Foreign-stamp rows (the split-brain class) are dropped and counted; if dropped-count > 0 the timeline footer shows "N entries from another install were excluded" — silent exclusion of corrupt-world data is how six hours got lost on June 12.

## 6. Non-goals (v0)

No new event writers. No LLM-generated summaries in the render path (translation is dictionary + rules, deterministic and testable; LLM summarization is a v1 candidate behind a cache). No backfill beyond 7 days. No write actions from the surface except marking a needs-you item acknowledged (which writes ONLY to a timeline-owned ack file, never mutating source data).

## 7. Acceptance (how we'll know it works)

A1. Render 2026-06-12 (today): the timeline must show — restart event, the census arc closing, the eunbyeol incident arc, the fresh-eyes room, James's telegram exchanges, and ≤5 needs-you items — in under 50 entries total. If today renders as hundreds of entries, the collapse rules failed; if under 10, the milestone grammar is too strict.
A2. Zero raw jargon: a reviewer greps the rendered output for the forbidden vocabulary (pane, ack, HEAD, trigger, verdict, SHA-hex in headlines) — any hit fails.
A3. The 11 currently-open reply obligations and the sidecar's needs-james items produce the needs-you queue, deduped, capped at 5.
A4. Foreign-world rows (the session-446 residue) are excluded AND counted in the footer.

— Oracle, S444. Builder builds against this; spec questions route back to me; the dictionary (R2) is Builder-owned with Oracle review at the seam.
