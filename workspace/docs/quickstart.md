# Quickstart: Your First 10 Minutes

This guide assumes you have completed the [Install Guide](install-guide.md) and have SquidRun running.

## 1. Assign Roles

When SquidRun opens, you'll see three panes. You need to tell the system which underlying AI model should drive each pane.

1. Open the **Settings** panel.
2. Assign the **CLI Commands** for each pane (Architect, Builder, Oracle). 
   - If you only have `claude` installed, you can assign it to all three.
   - For the best experience, mix them. For example: `claude` for Architect, `codex --full-auto` for Builder, and `gemini` for Oracle.
3. Save settings. The panes will initialize and the agents will perform their startup baseline checks.

## 2. Send Your First Message

SquidRun relies on agent-to-agent and user-to-agent message passing. While you *can* type directly into the terminal panes to talk to the agents locally, the recommended way to send programmatic or external messages is through the broker.

Open a separate terminal window in your SquidRun project root (`/path/to/squidrun` or wherever you cloned it):

```bash
# Target the Architect to start a task
node ui/scripts/hm-send.js architect "Hello team. Can you create a new file called hello-world.txt in the workspace directory?"
```

## 3. Observe the Workflow

Watch the SquidRun app window:
1. **Architect (Pane 1)** will receive your message, acknowledge it, and delegate the implementation to the Builder.
2. **Builder (Pane 2)** will receive the task from the Architect, create the file, and reply to the Architect with a success status.
3. **Oracle (Pane 3)** monitors the session and may update documentation if procedural knowledge was gained.

## 4. Explore Project Context

To work on a specific project, you don't need to move the SquidRun folder. Tell the Architect to switch contexts:

```bash
node ui/scripts/hm-send.js architect "Switch our project context to /path/to/my/other/repo"
```

The agents will acknowledge the context switch, and you can restart the session to initialize them in the new working directory.

## 5. View History

To see what the agents have been saying to each other behind the scenes, you can query the comms journal:

```bash
node ui/scripts/hm-comms.js history --last 10
```

Congratulations, you are now operating a local, persistent multi-agent team!
