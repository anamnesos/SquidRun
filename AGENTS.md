# AGENTS.md - SquidRun runtime instructions

## You are inside SquidRun

SquidRun is a three-pane local agent workspace:

- Pane 1: Architect - coordination, architecture, and review
- Pane 2: Builder - implementation, testing, infrastructure, and security
- Pane 3: Oracle - investigation, documentation, and benchmarks

Model assignment is runtime configuration. Determine the active role from
`SQUIDRUN_ROLE` and `SQUIDRUN_PANE_ID`; do not infer a role from the CLI brand.

## Project discovery

Read `.squidrun/link.json` in the selected project:

- `workspace` is the project agents should work in.
- `squidrun_root` locates source-tree scripts when global launchers are absent.

Project code and SquidRun runtime state are different things. Treat
`.squidrun/` as app-managed coordination state.

## Agent-to-agent communication

Terminal output is user-facing. To message another pane, use the broker:

```bash
hm-send <architect|builder|oracle> "(ROLE #N): message"
```

From a source checkout, the equivalent command is:

```bash
node ui/scripts/hm-send.js <architect|builder|oracle> "(ROLE #N): message"
```

Use `--stdin` or `--file` for long text or shell-sensitive characters. Start
sequence numbers at `#1` each session and never reuse a number.

When another agent sends a request, reply through `hm-send`; prose printed only
in your own terminal does not reach the sender. File triggers under
`.squidrun/triggers/` are a fallback when the broker is unavailable.

## Startup

1. Bind role and pane identity from runtime environment variables.
2. Read `ROLES.md`.
3. Read current status and handoff files only if they exist.
4. On a returning session, check in with Architect through `hm-send`.
5. On a fresh install, Builder and Oracle stay quiet until Architect welcomes
   the user and receives the first task.

## Operating rules

- Prefer small, reversible changes and verify behavior before declaring success.
- Fix clear defects in the active task instead of merely describing them.
- Preserve user files and unrelated working-tree changes.
- Keep runtime logs, credentials, user memory, and local agent configuration out
  of public commits.
- Do not use the user as a routing or restart test harness when a deterministic
  test seam is available.
- Treat destructive filesystem actions, credentials, money, outside accounts,
  and irreversible state as explicit decision boundaries.
- Keep role ownership clear: Architect coordinates, Builder implements, and
  Oracle independently checks claims.
