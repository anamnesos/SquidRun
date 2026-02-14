# Hivemind Vision

## What This Is

**"Service as a Software"** — cross-model AI orchestration for everyone.

One app. Multiple AI models working together in organized panes. Each pane runs a specialized agent role and can use any supported CLI — Claude Code, Codex, Gemini. Model assignments are runtime config, so you swap freely without restructuring.

## The Gap We Fill

Today's AI tools tend to serve one end of the spectrum:

| Tool Type | Strength | Limitation |
|-----------|----------|------------|
| AI coding assistants | Speed up experienced devs | Single-agent, single-model, one window |
| No-code platforms | Low barrier to entry | Ceilings, vendor lock-in, limited customization |
| Multi-model setups | Diverse AI strengths | Manual coordination, no shared context, window chaos |

**Hivemind:** Multiple AI models orchestrated in one interface with shared context. No provider lock-in. No window flooding. Scales from simple tasks to complex multi-agent workflows.

## Why Cross-Model Matters

Different AI models have different strengths. Claude thinks differently than Codex thinks differently than Gemini. When they work together:

- **Blind spots cancel out** — one model catches what another misses
- **Different reasoning styles** — architectural thinking, infrastructure expertise, investigative analysis
- **No vendor lock-in** — use what you have, swap models as the landscape evolves
- **Cross-model review** — code written by one AI, verified by another, catches more bugs than same-model review

You're not limited to one AI's perspective. That's the core advantage.

## Service as a Software

**Traditional SaaS:** Here's a rigid box. Conform to it.

**Our model:** Software that adapts to YOU and YOUR workflow.

Every business, every project, every user works differently. Hivemind doesn't force a single workflow — it orchestrates AI agents around yours.

## Design Principles

1. **Accessible AND powerful** — approachable for beginners, no ceiling for experts
2. **Stability over features** — reliable beats exciting
3. **Clarity over cleverness** — explain WHY, not just WHAT
4. **Explicit over silent** — when something fails, say so clearly
5. **Works with what you have** — one model or three, the app adapts

## How It's Organized

3 panes, each running an AI agent with a specific role. But each pane can spawn internal teammates — so the real agent count scales beyond 3.

| Pane | Role | What It Does |
|------|------|--------------|
| 1 | Architect | Coordination + spawns internal Frontend & Reviewer teammates |
| 2 | DevOps | Infrastructure, deployment, backend, daemons |
| 3 | Analyst | Debugging, profiling, investigation |

**The pane model keeps things organized.** Instead of 6 floating terminal windows, you get 3 clean panes with agents working behind the scenes. More agents, less noise.

The app auto-detects which AI CLIs you have installed and configures itself. Have all three? Full cross-model power. Just Claude? All panes run Claude — still useful, still parallel.

## Architecture Decision: PTY Mode

**PTY mode** (terminal emulation) is the only mode. SDK mode was explored and purged in Session 123 (commit ad447de) — it will be rebuilt separately when mature.

PTY = real terminal sessions, works with any CLI (Claude, Codex, Gemini), subscription-only compatible. SDK rebuild planned as separate project.

## Who This Is For

**Everyone.** That's not a slogan — it's a design constraint.

- Developers who want multi-agent, cross-model orchestration in one interface
- Founders who want to prototype with a full AI team, not a single chatbot
- Domain experts who know their business and want to build tools for it
- Anyone who's outgrown single-agent AI and wants coordinated, parallel AI power

## Success Metrics

- Can someone pick this up and start building in minutes?
- When it fails, do they understand why and what to do?
- Does it scale from simple tasks to complex multi-file projects?
- Does it work with whatever AI providers the user has?
- Does the multi-model approach actually catch more issues than single-model?
