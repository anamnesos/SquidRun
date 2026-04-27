# Memory-Index GC Plan — Builder Proposal

Session 290, 2026-04-23. Awaiting Architect ack before touching any file.
Hard constraint from James this session: **do NOT touch Eunbyul-scoped memories**.

## Current state
- 93 files in `~/.claude/projects/D--projects-squidrun/memory/`
- 70 of them are `feedback_*.md`
- James's complaint: "I can see the UI saving files, bro why" — combined issue
  of (a) too many small files and (b) UI surfacing every save as a notification.

## Proposed merges — net −15 files

### 1. Full trading autonomy (4 → 1)
Keep `feedback_full_trading_autonomy.md` as canonical. Merge in and delete:
- `feedback_full_trading_handoff.md` — S268 re-confirm of same rule
- `feedback_bet_big_no_test_probes.md` — sizing corollary; fold as subsection
- `feedback_trading_system_failure.md` — "never ask James about trading" rule;
  fold the "never prompt James for trading decisions" line as subsection

**Context preservation:** keep all session-specific incident references
(S253 autonomy grant, S262 execution broken, S268 re-confirm) as provenance
notes inside the merged doc.

### 2. Giveback/exit rules (3 → 1)
Keep `feedback_giveback_exit_with_size_floor.md` as umbrella. Merge in and delete:
- `feedback_red_position_rebound_exit.md` — red-position variant of the rule
- `feedback_respect_oracle_giveback_early.md` — Oracle's 0.97+ signal handling

**Context preservation:** each variant gets its own labeled subsection so the
decision tree is clear (GREEN peak > 50% giveback; RED = rebound exit; Oracle
0.97+ signals are valid regardless of position freshness).

### 3. Proactive/act-don't-ask cluster (6 → 2)
Keep `feedback_no_menu_just_verify.md` and `feedback_action_not_output.md`.
Merge in and delete:
- `feedback_drive_autonomously.md` → no_menu
- `feedback_execute_dont_ask.md` (Hormuz incident) → no_menu as "reference incident"
- `feedback_stop_logging_start_building.md` → action_not_output
- `feedback_proactive_full_stack.md` → merge into `feedback_full_stack_research.md`

### 4. Quality-shipping cluster (3 → 1)
Keep `feedback_stop_shipping_lazy.md`. Merge in and delete:
- `feedback_maximum_quality_first.md`
- `feedback_never_settle_for_less.md` (preserve the absolute-phrased clauses)

### 5. Capability-check cluster (3 → 1)
Keep `feedback_never_hallucinate_capabilities.md`. Merge in and delete:
- `feedback_verify_tools_before_using.md` — script-flag-specific instance
- `feedback_verify_before_complaining.md` — general verify-before-flag rule

### 6. Session retro cluster (3 → 1)
Keep `feedback_squidrun_failure_pattern.md` as canonical retro. Merge in and delete:
- `feedback_session_270_trading_failures.md`
- `feedback_session271_lessons.md`

## Do NOT touch
- All Eunbyul rules (per James this session): `feedback_eunbyul_*`,
  `feedback_check_eunbyul_comms_before_asking`, `feedback_read_before_asking`,
  `feedback_show_care`, `feedback_separate_cases`, `feedback_email_attachments_playwright`,
  `feedback_never_rewrite_without_telling`, `feedback_memory_usage_and_eunbyul`
- All James-specific trading-pattern rules (5min, entry pricing, post_dump, stop_loss,
  catalyst, btc_reclaim, arch_watch, stop_state_desync, hm_defi_execute_no_passive_limit,
  plain_english, trading_framework, trading_scale_economy, think_before_trading,
  last_chance, standby_losing, macro_awareness, live_spark_stale, we_dos_wallet,
  james_masterlist)
- All messaging/routing/identity rules (messaging_routing, verify_telegram_routing,
  telegram_reply_context_leak, telegram_vs_pc_channel, proactive_notify,
  restart_active_conversations, never_send_without_approval, never_impersonate)
- All agent-behavior rules not listed in the clusters above (agents_must_talk,
  act_as_partner_not_tool, crosscheck_during_work, frustration_not_shutdown_signal,
  dont_take_numbers_literally, dont_route_james_thinking_as_orders, no_flip_flop,
  catalyst_alone_isnt_enough, hm_defi_execute_no_passive_limit, btc_reclaim_invalidation,
  restart_is_hard_constraint, gemini_restart, time_awareness, transparent_about_limitations)

## Open question for Architect
James's "UI saving files" complaint might be a UI issue, not just a memory
count issue. Worth checking `ui/modules/` for where memory-dir file writes
emit toast notifications and suppressing those specifically. If that turns
out to be the real fix, dedupe becomes lower priority.

## Proposed order of operations
1. Ack from Architect on cluster list (or redlines)
2. Create merged files one cluster at a time (git commit per cluster)
3. Delete superseded files in same commit
4. Update MEMORY.md index
5. Add a one-liner at MEMORY.md top: "Before saving a new feedback_*.md,
   grep existing and update rather than create."
6. Look at UI file-save-notification suppression as a separate workstream

## Why this is load-bearing (Architect's "earned memory" point)
Each feedback file represents a session where James explicitly corrected
behavior. Merging preserves the rule+reason+reference-incident; it doesn't
throw away context. The tree-deep view still shows who-said-what-when
in provenance notes per rule. What gets lost in pure deletion:
- Which session the feedback came from
- The exact phrasing that provoked it (often more useful than the summary)

The plan above keeps both by making merged files longer (with subsections),
not by flattening to bullet lists.
