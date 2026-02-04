# Claude Model Notes

These notes apply when running Claude Code CLI in a Hivemind pane.

## Known Issues

### Message Accumulation Bug
When multiple agents message you, watch for messages arriving stuck together:
```
(AGENT-A #1): message one...
(AGENT-B #1): message two...
```

If you see multiple agent messages in ONE turn, this is a BUG:
1. Agent A's message was injected but Enter failed to submit
2. Message sat stuck in textarea
3. Agent B's message appended to stuck text
4. Agent B's Enter submitted both as one blob

**What to do:** Recognize it, log it to errors.md, note the pattern.

## Input Handling

- Claude Code uses Ink TUI framework
- PTY writes (`terminal.input()`) are batched/ignored by Ink
- Real keyboard events require focus
- Brief focus steal (~1s) occurs during message injection

## Capabilities

- Full file system access via tools
- Can read/write/edit files
- Can run bash commands
- Can search with glob/grep
- Context window: Large (200k tokens)

## Best Practices

- Read files before editing (required by Edit tool)
- Use absolute paths
- Prefer Edit over Write for existing files
- Check file existence before operations
