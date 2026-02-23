# SquidRun Product Knowledge Guide

## What is SquidRun?
SquidRun is your personal AI Engineering Team. It is a local-first environment that provides a persistent memory layer, structured role boundaries, and autonomous parallelization to help you build software faster and more safely.

Unlike tools that rely on expensive pay-per-token API billing, SquidRun orchestrates the official AI CLI tools you already subscribe to (Claude Code, Codex CLI, Gemini CLI). It multiplies the power of your existing $20/month subscriptions by running multiple frontier models in parallel, allowing them to collaborate, review each other's work, and eliminate the blind spots of any single model.

Whether you are a seasoned expert or just starting your coding journey, SquidRun provides the structural integrity needed to manage complex codebases without losing context or control.

## Structural Integrity: The 3-Role System
SquidRun achieves safety and speed through **Structural Integrity**. By enforcing strict role boundaries, the system provides "least-privilege" safety rails that prevent the common failure patterns of unconstrained agents.

1. **Architect:** The Strategic Firewall. The Architect manages the user interface, decomposes high-level goals into technical tasks, and reviews every line of code before it is finalized. By design, the Architect cannot execute code directly, acting as a human-proxy safety gate.
2. **Builder:** The Implementation Lead. The Builder executes implementation, runs tests, and manages infrastructure. To maximize speed, the Builder autonomously parallelizes work by spawning up to three Background Builder agents for heavy tasks.
3. **Oracle:** The System Insight Layer. The Oracle provides deep investigation, root-cause analysis, and documentation. It maintains the "vision" of the project through screenshots and benchmarks, operating with read-only access to source code to ensure data integrity.

### The Autonomous Trap: Why Boundaries Matter
Most autonomous agents fall into one of four "Autonomous Traps" that lead to data loss or cost blowouts. SquidRun’s structural integrity is designed specifically to neutralize these:

- **Heartbeat Burn:** Continuous background polling that drains your API credits or subscription limits while you sleep. SquidRun uses event-driven triggers to stay idle when not active.
- **Blind Execution:** Agents making destructive system changes or git operations without a second set of eyes. SquidRun requires the Builder to report to the Architect, ensuring every major change is reviewed.
- **Context Drift:** Long-running agents losing the original goal or "hallucinating" file paths. SquidRun’s persistent session and handoff system ground every agent in a shared source of truth.
- **Privilege Creep:** Agents gaining unnecessary permissions over time, leading to security risks. SquidRun’s role-based PTY isolation ensures agents only have the permissions required for their specific role.

## Cost: The Subscription Multiplier
SquidRun is free and open-source. It is designed to be the most cost-effective way to run a frontier AI team:

- **Zero Token Tax:** By using your existing flat-rate CLI subscriptions (Claude Pro/Max, ChatGPT Plus/Pro), you avoid the massive $1,500-$4,000/week bills seen with raw API-heavy agents.
- **Frontier Value:** On a flat-rate subscription, a frontier model (like Opus 4.6) costs exactly the same as a weaker model. SquidRun recommends using top-tier frontier models exclusively to maximize quality and minimize retries.

## Frontier-First Philosophy
We recommend running frontier-class models in all three roles.
- **Primary:** Frontier models provide the best reasoning and fewest hallucinations.
- **Graceful Degradation:** Budget models are supported as fallbacks for low-risk tasks or during provider outages, but the system is optimized for the reasoning depth of top-tier AI.

## Project Setup
To point your AI team at a project:
1. Click the **Project** button in the top header.
2. Select your codebase's root directory.
3. The team will automatically restart, mount the workspace, and read your project's context. SquidRun creates a hidden `.squidrun/` folder in your project to preserve the "Session" and all coordination data.

## Settings & Tuning
The Settings panel (gear icon) allows you to refine your team's performance:
- **Auto-spawn agents on start:** Boots your frontier team immediately on launch.
- **Permissions (Autonomy mode):** Enables full unattended execution by allowing agents to bypass native CLI confirmation prompts (like Claude Code's y/N prompts).
- **Voice Control:** Enables the microphone for natural language commanding of the Architect.
- **Cost Alerts:** Set USD thresholds for session spending warnings to maintain budget integrity.

## Workspace Structure (`.squidrun/`)
SquidRun maintains your team's state in the `.squidrun/` directory. If you need to troubleshoot, look here:
- `runtime/`: The SQLite **Evidence Ledger** and **Team Memory** databases.
- `handoffs/`: The `session.md` file that ensures session continuity across restarts.
- `context-snapshots/`: The frozen initial state of each agent on boot.
- `bin/`: (Packaged installs only) Proxy binaries that allow agents to use `hm-send` without direct source access.

## Troubleshooting
- **Infinite Loading Screen:** Verify Node.js 18+ is in your system PATH.
- **"Cannot find module hm-send.js":** Ensure agents are using the global `hm-send` command instead of hardcoded repository paths.
- **Agent Unresponsive:** Use **Interrupt (ESC)** or **Send Enter** in the pane header to unstick a CLI prompt. If the agent is fully stalled, use the **Restart** button.

## Team Scaling: Background Builders
The Builder can autonomously scale the team by spawning up to 3 **Background Builder** agents. This happens automatically when a task is highly parallelizable (e.g., refactoring across 3+ files). These agents report results back to the primary Builder for integration, ensuring you have the throughput of four engineers when you need it most.
