# SquidRun Quickstart (First 10 Minutes)

This guide gets a brand-new user from install to first successful task.

## Goal

In 10 minutes, you will:
1. Open SquidRun
2. Assign agent roles
3. Select or create a project workspace
4. Let the 3 agents start
5. Send your first task
6. Confirm success

## 0-2 Minutes: Open SquidRun & Assign Roles

1. Launch the SquidRun app.
2. Wait for the main 3-pane layout to appear.
3. Open the **Settings** panel.
4. Assign the **CLI Commands** for each pane (Architect, Builder, Oracle). 
   - If you only have `claude` installed, you can assign it to all three.
   - For the best experience, mix them. For example: `claude` for Architect, `codex --full-auto` for Builder, and `gemini` for Oracle.
5. Save settings.

What you should see:
- Pane 1: Architect
- Pane 2: Builder
- Pane 3: Oracle

## 2-4 Minutes: Select or Create a Project

1. Click the `Project` button in the top header.
2. Choose a folder to use as your project workspace.
- Existing codebase: select its root folder.
- New project: create/select an empty folder.

What SquidRun does next:
- Attaches the workspace
- Creates `.squidrun/` inside that workspace for coordination/runtime state
- Restarts agents into the selected project context

Important boundary:
- Your folder is your project workspace.
- It is not the SquidRun app source repository.

## 4-6 Minutes: Let Agents Spawn

If auto-spawn is enabled, agents start automatically.
If not, start them from the UI controls.

What success looks like:
- Architect, Builder, and Oracle panes show startup check-ins
- Pane status moves from idle/starting to running/ready
- You see session header lines like `# SQUIDRUN SESSION: ...`

If a pane looks stalled:
- Use `Send Enter` once in that pane
- Or use `Interrupt (ESC)` then retry

## 6-8 Minutes: Send Your First Task

SquidRun relies on agent-to-agent and user-to-agent message passing. While you *can* type directly into the terminal panes to talk to the agents locally, the recommended way to send programmatic or external messages is through the broker.

Open a separate terminal window in your SquidRun project root (`/path/to/squidrun` or wherever you cloned it):

```bash
# Target the Architect to start a task
node ui/scripts/hm-send.js architect "Create a hello-world Node app in this workspace with a README and one test."
```

What happens:
- Architect coordinates
- Builder implements
- Oracle investigates/docs as needed

## 8-10 Minutes: Verify Success

You should see:
1. Architect acknowledges and delegates work
2. Builder reports implementation progress
3. Oracle reports findings/docs if requested
4. Final completion message with changed file paths

Quick verification checklist:
- Files were created/updated in your selected workspace
- No pane is stuck waiting silently
- Architect provides a clear “done” or “needs input” status

## First Task Ideas

- “Set up a minimal Express API with one endpoint and test.”
- “Add TypeScript config to this project and fix build errors.”
- “Audit this repo for startup blockers and list top 5 fixes.”

## View History

To see what the agents have been saying to each other behind the scenes, you can query the comms journal:

```bash
node ui/scripts/hm-comms.js history --last 10
```

## If Something Breaks

Use [docs/troubleshooting.md](./troubleshooting.md) for common first-run issues:
- Agent stuck/unresponsive
- `hm-send` not found
- Node mismatch
- Bridge not connected
- Manual Enter needed on macOS