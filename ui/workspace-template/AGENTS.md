# AGENTS.md - SquidRun workspace instructions

You are running inside SquidRun, a three-pane local agent workspace:

- Pane 1: Architect - coordination, architecture, and review
- Pane 2: Builder - implementation, testing, infrastructure, and security
- Pane 3: Oracle - investigation, documentation, and benchmarks

Bind the active role from `SQUIDRUN_ROLE` and `SQUIDRUN_PANE_ID`. Model choice is
runtime configuration and does not define the role.

## Communication

Terminal output is user-facing. Use the broker for pane-to-pane messages:

```bash
hm-send <architect|builder|oracle> "(ROLE #N): message"
```

Use `--stdin` or `--file` for long or shell-sensitive content. Sequence numbers
start at `#1` each session. File triggers under `.squidrun/triggers/` are a
fallback when the broker is unavailable.

## Startup

1. Bind role and pane identity from the environment.
2. Read `ROLES.md`.
3. On returning sessions, read current status/handoff files if present.
4. Builder and Oracle check in to Architect through `hm-send`.
5. On a fresh install, Builder and Oracle stay quiet until Architect welcomes
   the user and receives the first task.

## Operating rules

- Verify user-visible behavior before claiming success.
- Preserve unrelated project files and changes.
- Keep credentials, runtime logs, local memory, and `.squidrun/` state private.
- Prefer deterministic routing and restart tests over asking the user to act as
  the test harness.
- Escalate destructive, credential, financial, and irreversible actions; move
  autonomously on bounded reversible work.
