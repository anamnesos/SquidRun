# Hivemind Failure Modes

This document describes what can go wrong in Hivemind and how to recover.

---

## Overview

Hivemind coordinates multiple Claude Code instances via file-based communication. Failures can occur at several layers:

1. **Agent-level** - Individual Claude instance issues
2. **Coordination-level** - State machine or file sync problems
3. **System-level** - Electron app or OS issues

---

## 1. Agent Timeout

### What Happens
A Claude instance doesn't respond or complete its task within expected time.

### Detection
- Claude state stays `starting` for >30 seconds
- No output in terminal pane for extended period
- State file not updated despite active work

### Recovery
1. Check terminal pane for error messages
2. Try sending `Ctrl+C` to interrupt stuck process
3. Use "Refresh" button to restart Claude in that pane
4. If stuck repeatedly: check for permission prompts or rate limiting

### Prevention
- Keep tasks small and focused
- Use checkpoints to save progress incrementally
- Monitor Claude running state via UI badges

---

## 2. Crash Mid-Write

### What Happens
Process terminates while writing to state.json or other critical files, potentially corrupting data.

### Detection
- App crashes or freezes unexpectedly
- state.json contains malformed JSON on restart
- "Unexpected token" errors in console

### Recovery
1. **Atomic writes protect state.json** - We use temp file + rename pattern
2. If state.json is corrupted: delete it, app will recreate default state
3. Check for `.tmp` files in workspace - these are incomplete writes

### Prevention
- Atomic write pattern already implemented in `writeState()` (main.js:336-358)
- Keep workspace on local disk (not network drive) for reliable renames
- Regular backups of workspace/ folder for important projects

---

## 3. Stuck State

### What Happens
Workflow gets stuck in a state with no clear path forward.

### Detection
- State doesn't change despite agent activity
- File watcher not triggering transitions
- `state.json` timestamp unchanged for >15 minutes

### Recovery
1. Check `workspace/build/blockers.md` for unresolved issues
2. Manually transition state via Settings → Debug → Force State
3. Restart the app to reset watchers
4. Review `workspace/console.log` for error messages

### Prevention
- Each state should have clear exit conditions
- Reviewer should catch unclear requirements before execution
- Use friction logging to document where workflow gets stuck

---

## 4. File Watcher Miss

### What Happens
chokidar doesn't detect a file change, so state transition doesn't fire.

### Detection
- Agent wrote expected file (e.g., `checkpoint.md`) but state didn't change
- Verified file exists and has correct name

### Recovery
1. Make a minor edit to the file and save again
2. Click "Sync" button to force state reload
3. Restart app to reinitialize watchers
4. On Windows: check file wasn't saved with wrong line endings

### Prevention
- Use normalized paths (forward slashes in config)
- Ensure workspace folder is on local filesystem
- Don't use antivirus exclusions that might interfere with fs events

---

## 5. Parallel Worker Conflict

### What Happens
Worker A and Worker B modify the same file simultaneously, causing lost changes.

### Detection
- Git shows unexpected merge conflicts
- Work from one worker appears missing
- Inconsistent file state after parallel execution

### Recovery
1. Check git history for both versions
2. Manually merge the changes
3. Re-run the conflicting tasks with clearer file ownership

### Prevention
- **File ownership is operator responsibility** - don't assign overlapping files
- Use `files_touched` declarations in task specs (if implemented)
- Reviewer should check for potential conflicts before approving plan

---

## 6. Claude Permission Denied

### What Happens
Claude Code refuses to run a command due to permission settings.

### Detection
- Claude shows permission prompt that wasn't answered
- Tool use fails with permission error
- Agent reports "cannot perform action"

### Recovery
1. Answer the permission prompt in the terminal
2. Check Settings → Permissions for global permission overrides
3. Re-run the command after granting permission

### Prevention
- Set appropriate permission level in settings before starting work
- Use `--dangerously-skip-permissions` for automated workflows (with caution)
- Grant common permissions (Read, Write, Bash) upfront for trusted projects

---

## 7. PTY Process Death

### What Happens
The underlying shell (PowerShell/bash) dies unexpectedly.

### Detection
- Terminal pane shows "disconnected" or goes blank
- Claude state resets to `idle`
- No response to input

### Recovery
1. Use "Refresh" button to spawn new PTY
2. If stuck: restart the Electron app
3. Check system resources (RAM, CPU) for exhaustion

### Prevention
- Keep reasonable number of concurrent terminals (4 is fine)
- Monitor system resources during heavy workloads
- Close unused Claude sessions to free memory

---

## 8. Rate Limiting

### What Happens
Anthropic API returns rate limit errors.

### Detection
- Claude shows rate limit or quota error message
- Multiple agents start failing simultaneously
- Exponential delays in responses

### Recovery
1. Wait for rate limit to reset (usually 1-5 minutes)
2. Reduce parallel agents temporarily
3. Check Anthropic console for usage quotas

### Prevention
- Don't spawn all agents simultaneously
- Stagger agent starts by a few seconds
- Monitor cost tracking (when implemented) for unusual usage

---

## Quick Recovery Checklist

1. **Check console.log** - `workspace/console.log` captures renderer errors
2. **Check blockers.md** - Other agents may have logged the issue
3. **Check state.json** - Is the state what you expect?
4. **Restart app** - Resets watchers and PTY processes
5. **Delete .tmp files** - Clean up incomplete writes
6. **Re-sync context** - Broadcast shared_context.md to all agents

---

## Reporting New Failures

If you encounter a failure mode not documented here:

1. Log it to `workspace/friction/YYYY-MM-DD-description.md`
2. Include: what happened, expected behavior, steps to reproduce
3. Reviewer will assess and update this document

---

*Last Updated: January 2026*
