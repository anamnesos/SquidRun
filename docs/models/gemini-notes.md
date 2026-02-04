# Gemini Model Notes

These notes apply when running Gemini CLI in a Hivemind pane.

## CLI Behavior

Gemini CLI is readline-based (not Ink TUI like Claude Code).
- Standard terminal input handling
- PTY writes work directly
- Requires `\r` (CR) for submission, not `\n` (LF)

## Enter Timing

Gemini CLI has `bufferFastReturn` protection:
- If Enter arrives within 30ms of previous keystroke, it becomes a newline
- Hivemind uses 500ms delay between text and Enter
- This ensures reliable submission

## Tool Access

Gemini has access to tools via Automatic Function Calling (AFC):
- `read_file` - Read file contents
- `write_file` - Write/create files
- `run_bash` - Execute commands
- `glob_files` - Find files by pattern
- `grep_search` - Search file contents

## Path Restrictions

**Known limitation:** Gemini agents cannot use `read_file` or `list_directory` on `ui/` paths directly.

**Workaround:** Use `run_shell_command` with `cat`, `ls`, etc. to access files outside workspace.

## Message Format

- Messages arrive via PTY injection
- No message accumulation bug
- 500ms Enter delay ensures submission

## Best Practices

- Use shell commands as fallback for restricted paths
- Verify file existence before operations
- Keep responses focused (Gemini can be verbose)
- Check for API rate limits (429 errors)
