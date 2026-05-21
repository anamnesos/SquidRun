# Mira North-Star Roadmap

Status: active product roadmap and stop/pivot gate.
Owner: Architect coordinates; Builder implements; Oracle challenges against current agent benchmarks.
Source basis: Oracle #98/#100 benchmark, Architect #247/#249 direction, and `docs/mira-system-map.md`.

## Hard Truth

Current New Mira is not holy-shit amazing.

What exists now is a local prototype: state-root work, runtime endpoints, a browser workbench, deterministic turns, dry-run Telegram candidate/readiness seams, visible-reply parity tests, and some unfinished local context plumbing. That is not better than modern agents by itself.

Modern agents already browse, click, use apps, schedule, run code, edit repos, run background tasks, connect email/docs/calendar/workflow tools, and keep project contexts. Mira should not try to win by becoming another generic browser, email, calendar, coding, or chat agent.

The only product bet worth testing is this:

Mira becomes James's always-available command layer for the SquidRun AI team and his work. She understands the live lane, knows what Architect, Builder, and Oracle are doing, keeps continuity, chooses the next move, coordinates the team, plans tool/app actions, and pulls James in only for real choices or real-world effects.

## What Would Be Impressive

The target is not "Mira knows SquidRun." That is foundation.

The impressive version is:

- James asks, "what is happening and what should happen next?"
- Mira answers from live local evidence, not uploaded docs or generic memory.
- Mira names the current lane, repo/worktree truth, recent Builder/Oracle state, unresolved blocker, and exact next move.
- Mira can say, "Builder does this next, Oracle reviews this, James does nothing," or "James must do this one concrete setup/test."
- Mira can draft or execute internal team coordination through real SquidRun routes when that route has been promoted.
- Mira keeps following the lane after internal PASS/commit when `JAMES ACTION: NONE`, instead of using James as the wake-up signal.
- Later, Mira can be reached through her own direct channel/device surface and can coordinate tools/apps with explicit James control points.

What this beats is not generic app breadth. It beats generic agents at being inside James's actual operating system: SquidRun lanes, panes, handoffs, commits, tests, local state, direct team routing, and James-specific continuity.

## Current Reality

Exists now:

- Current SquidRun Mira is the messy-but-real live surface for Mira replies and Telegram route when configured.
- SquidRun has live Architect, Builder, Oracle, `hm-send`, comms journal, handoff, restart, and owned-work plumbing.
- New Mira has a local runtime/workbench and can run deterministic local turns.
- New Mira can be proven not to call `/turn` on boot and to post one `/turn` only after explicit submit.
- New Mira has one useful dry-run status-answer test with exactly one `JAMES ACTION:` line.
- A continuation broker exists so internal PASS/commit plus `JAMES ACTION: NONE` means continue, not wait for James.

Does not exist yet:

- A single product surface where Mira reads the live SquidRun team state and tells James what is happening and what happens next.
- A New Mira-owned command layer that chooses Builder/Oracle moves from current evidence.
- A promoted route where New Mira can send internal team messages as Mira, with audit and rollback.
- A direct New Mira channel/device surface.
- Tool/app action adapters beyond local planning and prototypes.
- Always-on operation that survives restarts/off-PC use without the current SquidRun app paths.

## Missing Capabilities

| Capability | Why It Matters | Current State | First Proof Needed |
| --- | --- | --- | --- |
| Live command context | Without current lane/team state, Mira is just chat. | Sources exist across `.squidrun`, git, comms, owned work, and map docs; no unified product answer yet. | Build one command context view that answers "what is happening and what next?" from local evidence. |
| Team coordination | The product win is Mira operating the AI team, not replacing every agent. | `hm-send` exists; New Mira bridge planning is manual/prototype. | New Mira drafts the exact Builder/Oracle next message, then a later lane promotes internal send. |
| Continuation ownership | James should not be the wake-up signal. | Continuation broker exists for `JAMES ACTION: NONE`. | Connect command context to the continuation decision and next map-backed lane. |
| Direct channel | James needs a natural way to reach Mira later. | Telegram-first dry-run and separate-channel readiness exist. | James-visible separate channel setup/test only after local command layer is useful. |
| Tool/app action planning | Generic agents win broad apps; Mira must plan from James's actual system first. | Work/autonomy/tool prototypes exist but are not product. | Show one local tool/action plan with clear owner and James-control point, without pretending it executed. |
| Continuity and memory | Mira must remember the lane without James restating it. | Current SquidRun restart proof exists; New Mira imports are prototype. | New Mira command context loads sourced restart/current-lane truth and rejects stale-only summaries. |

## First Inspectable Demo

Name: Mira Mission Control v0.

Surface: New Mira local workbench served by the local runtime, or the existing SquidRun UI if that proves faster. The surface choice is tactical; the demo must be browser-inspectable and local.

Question it must answer:

`what is happening here, and what should happen next?`

Demo behavior:

- Reads local evidence: `.squidrun/link.json`, current project path, git status, recent comms/checkpoints, `.squidrun/handoffs/current-lane.json`, owned-work continuation state, and `docs/mira-system-map.md`.
- Shows one concise command card:
  - current lane and why it matters
  - what changed recently
  - Builder next move
  - Oracle next move
  - whether the current dirty context-card code is required, held, or should be reverted
  - exactly one `JAMES ACTION:` line
- Produces one route plan for the next team move:
  - dry-run first: exact message to Builder or Oracle, no send
  - promotion later: internal `hm-send` only after a separate route/audit lane
- Does not sell the card itself as the win. The card is the first window into the command layer.

Acceptance:

- User can inspect the surface and see current SquidRun/team reality without reading terminal logs.
- The output is specific to this repo/session and would be wrong in a generic ChatGPT/Claude/Comet/Replit/Cursor context unless that agent had live SquidRun state.
- The answer does not claim broad browser/email/calendar/coding-agent parity.
- The answer includes exactly one `JAMES ACTION:` line.
- No live external sends, route-owner flip, token/account/channel setup, provider requirement, or fixed-port runtime left running.

## Stop / Pivot Criteria

Stop or pivot if any of these become true:

- After the Mission Control v0 lane, Mira still cannot answer the current lane/next move from local evidence in a way James can inspect.
- After one follow-up coordination lane, Mira cannot at least draft a correct Builder/Oracle route plan from current evidence.
- After three product lanes, the work is still mostly tests, docs, status cards, or anti-leak plumbing with no user-visible command-layer behavior.
- The team keeps confusing foundation plumbing with product value.
- The proposed product remains weaker than using external agents plus SquidRun as a harness.

Pivot shape if the stop line is hit:

- Keep SquidRun for orchestration, tests, restart continuity, and agent routing.
- Use stronger external agents for generic browser/app/coding/workflow automation.
- Keep Mira only where she has differentiated James/SquidRun continuity and team-command value.

## Immediate Builder Slice

Do not commit the current context-card work as product.

Next Builder slice:

1. Decide whether the dirty context-card code is needed as the local evidence reader for Mission Control v0.
2. If yes, reshape it from "context card" into "command context" and make the UI answer the Mission Control question above.
3. If no, revert Builder's uncommitted context-card changes and build the smaller command-context path from the right surface.
4. Add one focused test that proves the answer is derived from local SquidRun evidence and includes exactly one `JAMES ACTION:` line.
5. Update `docs/mira-system-map.md` with the resulting truth.

JAMES ACTION: NONE
