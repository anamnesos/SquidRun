# SquidRun product guide

## What SquidRun does

SquidRun is a local Electron workspace for three AI coding agents operating on
one project. The panes have stable roles:

- Architect coordinates.
- Builder implements and tests.
- Oracle investigates and checks.

The user chooses which installed CLI runs in each pane. Claude Code, Codex CLI,
and Gemini CLI are supported; the same CLI may be assigned to multiple panes.

## What the user sees

- Three live terminal panes.
- Settings for pane CLI commands and project selection.
- Pane controls for interrupt, Enter, restart, and a fresh conversation.
- A broker-backed communication path between agents.
- Project-local session and communication state under `.squidrun/`.

SquidRun is not a code editor or a hosted AI service. It runs beside the user's
editor and launches the official CLI tools installed on the local machine.

## Starting a project

1. Open Settings and assign a CLI command to each pane.
2. Select the project root.
3. Wait for the three panes to start.
4. Give the first task to Architect.

On a fresh project, `.squidrun/` is created for runtime coordination state. An
empty project is valid; agents should not diagnose or change it until the user
asks for work.

## Communication

Agents send addressed messages with:

```bash
hm-send <architect|builder|oracle> "(ROLE #N): message"
```

Communication history is available through:

```bash
hm-comms history --last 20
```

Transport acceptance alone is not always proof that a model processed a
message. Important delivery checks should use recipient evidence.

## Safety boundary

The CLIs run with the local account's permissions and can edit files or execute
commands. Use SquidRun only on trusted projects, review destructive actions, and
keep credentials and runtime state out of source control.

## When something stalls

Try the pane's Interrupt or Send Enter control. Restart only the affected pane
when possible. If the app must restart, preserve work first and verify the
user-visible behavior after the new session loads.
