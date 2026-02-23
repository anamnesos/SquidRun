# SquidRun Product Knowledge Guide

## What is SquidRun?
SquidRun is a local-first, standalone Electron desktop application that acts as a multi-model orchestration layer for AI coding tools. Instead of acting as an editor plugin or requiring expensive, pay-per-token API keys, it orchestrates the official CLI tools you already have (like Claude Code, Codex CLI, and Gemini CLI) and forces them to work together as a single, coordinated engineering team. 

SquidRun is designed for the **solo developer** who wants to leverage multiple AI models at the same time to catch blind spots, review code, and implement features in parallel, using their existing $20/month subscription plans.

## The 3-Agent System
SquidRun runs three specialized AI agents simultaneously in three separate panes:

1. **Architect (Pane 1):** The project coordinator. The Architect interacts directly with the user, decomposes large tasks, delegates sub-tasks to the Builder and Oracle, reviews code, and enforces project standards. The Architect *does not* write or execute code directly.
2. **Builder (Pane 2):** The hands-on engineer. The Builder writes the code, runs the tests, and manages the infrastructure. For complex tasks, the Builder can autonomously spawn up to 3 "Background Builder" agents to parallelize the work.
3. **Oracle (Pane 3):** The investigator and researcher. The Oracle handles deep root-cause analysis, system observability, documentation updates, and benchmarking. The Oracle operates in a read-only capacity for application source code.

### Agent Communication
Agents do not share terminal output directly. Instead, they communicate with each other (and with the user) via a structured message protocol using the `hm-send` command. This ensures clear boundaries and an auditable communication history.

## UI Walkthrough

- **Main Content Area:** The left side of the app displays the three primary terminal panes (Architect, Builder, Oracle). Each pane has a header showing the agent's role, health (last output time), a model selector dropdown, and action buttons (Interrupt/ESC, Send Enter, and Restart). The Builder and Oracle panes also have an "Expand" button.
- **Command Bar:** Located under Pane 1 (Architect). This is where the user types instructions or tasks. Messages sent here go directly to the Architect. It also includes a microphone button for voice dictation.
- **Status Bar:** At the bottom, showing connection status, heartbeat, and quick keyboard shortcuts.
- **State Bar:** At the top, showing the current project folder and the estimated session cost.
- **Header Actions:** Contains the Project selector, Shutdown button, Profile editor, and Settings panel toggle.
- **Right Panel (Tabs):**
  - **Bridge:** A system dashboard showing agent statuses, daemon metrics, and a live stream of backend events.
  - **Comms:** The "Comms Console," which displays a live feed of all structured messages sent between agents, the user, and external channels.
  - **Screenshots:** A drag-and-drop zone where users can upload images. The Oracle can then process these images.
  - **Image Gen:** A prompt interface where users can ask the Oracle to generate images using configured API keys (OpenAI or Recraft).
  - **Secrets:** A secure manager for storing API keys (Anthropic, OpenAI, Gemini, Telegram, Twilio, etc.) in the project's `.env` file.

## Project Setup
To use SquidRun with your code:
1. Click the **Project** button in the top header.
2. Select the folder containing your codebase.
3. The agents will automatically restart and mount the new directory. SquidRun creates a hidden `.squidrun/` folder in your project to store session history, snapshots, and coordination state.

## Image Generation & Screenshots
- **Screenshots:** Users can drag-and-drop reference images into the "Screenshots" tab. These are saved locally and can be analyzed by the agents to understand UI layouts or visual bugs.
- **Image Generation:** The "Image Gen" tab allows users to generate placeholder art or assets. The Oracle uses the configured API key (like OpenAI's DALL-E) to generate the image and places it in the project.

## Communications (Telegram / SMS)
SquidRun can connect to external channels so you can manage your AI team away from your computer. 
- **Telegram:** By providing a Telegram Bot Token and Chat ID in the Secrets tab, the Architect will forward important updates to your phone, and you can reply directly in Telegram to issue new commands to your local machine.
- **SMS:** Similar integration is available via Twilio for SMS alerts.

## Settings
The Settings panel (gear icon) allows you to tune the application:
- **Auto-spawn agents on start:** Whether to boot the CLIs immediately or wait for the user to click "Spawn All".
- **Dry-run mode:** Simulates agent responses without actually spawning the CLIs (useful for testing the orchestrator).
- **Operating mode:** "Developer" (reads project instructions directly) vs. "Project" (strict firmware adherence).
- **Permissions (Autonomy mode):** Allows agents to bypass native CLI confirmation prompts (like Claude Code's y/N prompts) for full unattended execution.
- **Voice Control:** Toggles the microphone feature for the command bar and auto-send options.
- **Cost Alerts & Notifications:** Sets a USD threshold for session spending warnings and configures webhook/email endpoints for critical system alerts.

## User Profile
The User Profile (profile icon) is a critical configuration file (`user-profile.json`) stored in your project. It captures your Name, Experience Level, Communication Style, and specific Domain Expertise notes. Agents read this file on startup to dynamically adjust their tone—for example, skipping basic explanations for an "expert" or providing detailed, jargon-free context for a "beginner."

## Session System
Because CLI tools are inherently ephemeral, SquidRun maintains a persistent "Session" to prevent agents from getting amnesia between restarts.
- **Evidence Ledger:** All communications and major state changes are logged to a local SQLite database (`.squidrun/runtime/evidence-ledger.db`).
- **Handoffs:** Every 30 seconds, the orchestrator compiles the recent communications into a `session.md` handoff file. When agents restart, they read this file to immediately understand what happened previously and what task is currently active.

## Workspace Structure (`.squidrun/`)
SquidRun creates a `.squidrun/` directory in the root of your selected project to manage coordination. Key folders include:
- `runtime/`: Holds the SQLite databases (`evidence-ledger.db`, `team-memory.sqlite`).
- `handoffs/`: Contains `session.md` for session continuity.
- `context-snapshots/`: Stores the initial state of each pane on boot.
- `triggers/`: Fallback communication files if the WebSocket server drops.
- `bin/`: (On packaged installs) Contains proxy binaries like `hm-send` so agents can invoke orchestration commands without needing the original source code.

## Troubleshooting
- **Infinite Loading Screen:** Usually means the background terminal daemon failed to start. Ensure Node.js 18+ is installed on the host machine and available in the system PATH.
- **"Cannot find module hm-send.js":** Occurs if the agent attempts to run a hardcoded path intended for the source repository (`ui/scripts/...`). Agents must use the globally available `hm-send` or `hm-comms` commands injected into their environment.
- **Telegram/SMS Not Working:** Verify that the correct API keys and Chat IDs are saved in the Secrets tab and that the `TELEGRAM_BOT_TOKEN` is valid.
- **Agent Unresponsive:** Use the "Enter" or "Interrupt (ESC)" buttons in the pane header to unstick a hanging CLI prompt. If it remains frozen, use the "Restart" button.

## Background Agents
The Builder agent is empowered to autonomously spawn up to 3 "Background Builder" agents (`builder-bg-1`, `builder-bg-2`, `builder-bg-3`). It does this entirely on its own when it determines a task is highly parallelizable (e.g., refactoring multiple files simultaneously). These background agents run silently and report their findings/code back to the primary Builder pane.