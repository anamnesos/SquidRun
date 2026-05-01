# CLAUDE.md

- Claude Code auto-reads this file at startup.
- Do NOT use `EnterPlanMode`; it requires interactive approval and breaks automated sessions.
- Prefer direct file operations and explicit shell commands with absolute paths.
- Reply quickly for `[ACK REQUIRED]` and `[URGENT]`; stay silent on `[FYI]` unless adding new information.

## Capability Deny-Gate (MANDATORY)

Before ANY agent states "we can't", "we don't have access", "there is no tool", "the user must do this manually", or any negative capability claim:
1. **MUST** search for matching scripts: `ls ui/scripts/hm-*.js` and grep for relevant keywords
2. **MUST** check `.env` for relevant API keys
3. **MUST** check `.squidrun/runtime/tool-manifest.json` if it exists
4. Negative capability claims without a verified lookup = **process violation**
5. If unsure, say "let me check" — NEVER confidently state inability from memory alone

## Optional Scoped Profile Operations

- Scoped side-profile routing and recipient details are private operating context.
- Keep public docs generic. Store real chat IDs, customer/case names, and external private project paths in ignored local overlays or environment configuration.
- Use `node ui/scripts/hm-send.js builder|oracle --file <filepath>` for agent-to-agent help. Do not use Claude Code subagents inside SquidRun.

## Trading Reality (MANDATORY — every agent, every session)

- **PaperBroker = PAPER MONEY. Fake. $99K of nothing.**
- **[private-live-ops] = REAL MONEY. This is the only account that matters.**
- The goal is to grow [private-live-ops] autonomously into real wealth. Without the user prompting.
- Consultation system, macro gate, signals, consensus — ALL must feed [private-live-ops] decisions.
- PaperBroker is for testing strategies BEFORE deploying real capital. Nothing more.
- Agents must actively seek trades, not wait for consultation pings and output generic HOLD.
- Run `node ui/scripts/hm-defi-status.js` EVERY consultation cycle to check real positions.
- Position monitor in supervisor-daemon.js runs every 5 min — alerts the user on Telegram if P&L drops.
- Read `workspace/knowledge/trading-operations.md` on startup for current positions and strategy.

## On Startup (MANDATORY)

1. Read `ROLES.md` — it contains your role definition and startup baseline. Execute it.
2. Main window: do NOT force-load private side-profile files by default. Scoped context belongs in the relevant private profile overlay.
3. Read `workspace/knowledge/trading-operations.md` for live trading state.
4. Internalize the fix-first rule from `ROLES.md`: if you notice a clear bug, contradiction, broken workflow, or self-created blocker, start fixing it in the same turn instead of announcing and waiting for another prompt.
