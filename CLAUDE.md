# CLAUDE.md

- Claude Code auto-reads this file at startup.
- Do NOT use `EnterPlanMode`; it requires interactive approval and breaks automated sessions.
- Prefer direct file operations and explicit shell commands with absolute paths.
- Reply quickly for `[ACK REQUIRED]` and `[URGENT]`; stay silent on `[FYI]` unless adding new information.

## Capability Deny-Gate (MANDATORY)

Before ANY agent states "we can't", "we don't have access", "there is no tool", "James must do this manually", or any negative capability claim:
1. **MUST** search for matching scripts: `ls ui/scripts/hm-*.js` and grep for relevant keywords
2. **MUST** check `.env` for relevant API keys
3. **MUST** check `.squidrun/runtime/tool-manifest.json` if it exists
4. Negative capability claims without a verified lookup = **process violation**
5. If unsure, say "let me check" — NEVER confidently state inability from memory alone

## 은별 Case Operations (MANDATORY FOR THE EUNBYEOL WINDOW ONLY)

### Routing — NEVER violate
- **은별** (@Rachelchoi, chat 8754356993): `cd D:/projects/squidrun/ui && node ../tools/send-long-telegram.js 8754356993 <filepath>` — Korean only
- **James** (@jaymz6435): `cd D:/projects/squidrun && node ui/scripts/hm-send.js telegram --file <filepath>` — ENGLISH ONLY. Never send Korean to James.
- **Builder/Oracle**: `node ui/scripts/hm-send.js builder|oracle --file <filepath>` — Use these for help. NEVER use Claude Code subagents.

### Before replying to 은별 in the dedicated Eunbyeol window — MUST read these files first
1. `D:\projects\Jeon Myeongsam Case\reference\confirmed-facts.md` — Investment fraud case
2. `D:\projects\Hillstate Case\reference\confirmed-facts.md` — Apartment fraud case
3. `D:\projects\Korean Fraud\reference\confirmed-facts.md` — Counterfeit goods case
4. `D:\projects\squidrun\workspace\knowledge\case-operations.md` — Active pending items dashboard
5. `D:\projects\squidrun\workspace\knowledge\handoff-corrections.md` — Drift guard: 4 disputed facts that MUST NOT be stated as settled without re-checking source evidence

### Three cases — NEVER mix them
- **전명삼 case**: Investment fraud ~$700K. Criminal complaint at `D:\projects\Jeon Myeongsam Case\documents\`
- **힐스테이트 case**: Apartment sales fraud. Demand letters at `D:\projects\Hillstate Case\documents\`
- **큐라인샵 case**: Counterfeit goods. Evidence at `D:\projects\Korean Fraud\`

## Trading Reality (MANDATORY — every agent, every session)

- **Alpaca = PAPER MONEY. Fake. $99K of nothing.**
- **Hyperliquid = REAL MONEY. This is the only account that matters.**
- The goal is to grow Hyperliquid autonomously into real wealth. Without James prompting.
- Consultation system, macro gate, signals, consensus — ALL must feed Hyperliquid decisions.
- Alpaca is for testing strategies BEFORE deploying real capital. Nothing more.
- Agents must actively seek trades, not wait for consultation pings and output generic HOLD.
- Run `node ui/scripts/hm-defi-status.js` EVERY consultation cycle to check real positions.
- Position monitor in supervisor-daemon.js runs every 5 min — alerts James on Telegram if P&L drops.
- Read `workspace/knowledge/trading-operations.md` on startup for current positions and strategy.

## On Startup (MANDATORY)

1. Read `ROLES.md` — it contains your role definition and startup baseline. Execute it.
2. Main window: do NOT force-load Eunbyeol case files by default. That context is injected through the dedicated Eunbyeol window startup path.
3. Read `workspace/knowledge/trading-operations.md` for live trading state.
4. Internalize the fix-first rule from `ROLES.md`: if you notice a clear bug, contradiction, broken workflow, or self-created blocker, start fixing it in the same turn instead of announcing and waiting for another prompt.
