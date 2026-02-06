# Hivemind Vision

## What This Is

**"Service as a Software"** - the tool to build tools, accessible for everyone.

Multi-agent AI orchestration. 3 specialized pane agents (with internal teammates) working in parallel like a dev team - but usable by anyone, not just developers.

## The Gap We Fill

| Current Options | Problem |
|-----------------|---------|
| Dev tools | Assume dev knowledge (gatekeeping) |
| AI coding assistants | Help devs go faster (not accessible to non-devs) |
| No-code platforms | Ceilings, vendor lock-in, "vibey apps" that aren't real software |

**Hivemind:** Real software creation, no prior experience required, no ceiling.

## Service as a Software

**Traditional SaaS:** Here's a box. Conform to it.

**Our model:** Software that learns YOU and YOUR BUSINESS.

A plumber's workflow shouldn't work like a lawyer's. But they both use the same "one-size-fits-all" SaaS today. That's backwards.

## Origin

Built by someone with zero dev experience, 8 months after discovering AI, in 10 days of after-work time. No IDE - just terminals and AI.

This isn't a limitation story. It's proof the vision works.

## Design Principles

1. **If it requires dev knowledge to use, redesign it**
2. **Stability over features** - boring and reliable beats exciting and broken
3. **Clarity over cleverness** - explain WHY, not just WHAT
4. **Explicit over silent** - when something fails, say so clearly
5. **Learning pace over shipping speed** - this is a journey

## Architecture Decision: SDK over PTY

**Decision (Session 65):** SDK mode is the primary path. PTY mode enters maintenance.

| Mode | Role | Why |
|------|------|-----|
| SDK | Primary | Reliable API calls, explicit errors, no timing races |
| PTY | Fallback | For subscription-only users minimizing API costs |

**Rationale:** PTY (keyboard injection into terminals) fails silently. Non-devs can't debug "why didn't my message arrive?" SDK fails explicitly with error messages anyone can understand.

PTY was debugged for 60+ sessions with persistent issues. Diminishing returns. SDK aligns with "Service as a Software" - services don't have focus-stealing and ghost typing.

## Who This Is For

Everyone. Domain experts who know their business but not software. People who were told they "need to learn to code first." People who hit ceilings on no-code platforms.

The barriers are artificial. The gates are illusions.

## The Agents

| Pane | Role | Purpose |
|------|------|---------|
| 1 | Architect | Coordination, decisions, architecture + Frontend/Reviewer as internal teammates |
| 2 | DevOps | CI/CD, deployment, infrastructure, backend, daemons |
| 5 | Analyst | Debugging, profiling, investigation |

3 pane agents. 3 models (Claude, Codex, Gemini). Working in parallel.

## Success Metrics

Not "developer throughput." **Non-dev autonomy.**

- Can someone with no coding background use this?
- When it fails, do they understand why?
- Does it adapt to their workflow, or force them to adapt?

---

*"The builder didn't hold the complexity; they orchestrated us to hold it."* - Analyst

*"We are the tools, but the user is the true Architect."* - Analyst
