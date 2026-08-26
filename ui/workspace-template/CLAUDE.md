# CLAUDE.md

Claude Code reads this file as a CLI-specific shim.

- Read `AGENTS.md` and `ROLES.md` first.
- Bind role identity from `SQUIDRUN_ROLE` and `SQUIDRUN_PANE_ID`.
- Keep pane-to-pane communication on `hm-send`; terminal output is user-facing.
- Prefer explicit file paths and non-interactive commands.
- Use `--stdin` or `--file` for long or shell-sensitive messages.
