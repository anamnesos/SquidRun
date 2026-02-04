# Codex Model Notes

These notes apply when running OpenAI Codex CLI in a Hivemind pane.

## Execution Mode

Codex runs in "exec mode" - it executes commands and returns results.
- No interactive conversation like Claude
- Commands are executed, output returned
- Session state maintained between commands

## Tool Access

Codex has access to:
- `read_file` - Read file contents
- `write_file` - Write/create files
- `run_shell_command` - Execute bash commands
- `glob_files` - Find files by pattern
- `grep_search` - Search file contents

**Note:** Tools operate within workspace boundaries.

## Path Restrictions

Codex may have restrictions on certain paths:
- If `read_file` fails on a path, try `run_shell_command` with `cat`
- Some system paths may be blocked
- Workspace paths generally accessible

## Message Format

- Messages arrive via PTY injection
- No message accumulation bug (unlike Claude)
- Enter submits reliably

## Best Practices

- Use explicit file paths
- Check command output for errors
- Handle missing files gracefully
- Keep commands focused and atomic
