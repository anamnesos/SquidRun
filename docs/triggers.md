# Trigger Files Reference

This is the canonical reference for trigger file messaging in Hivemind.

## Preferred: WebSocket Messaging

**Use `hm-send.js` for agent-to-agent messaging — faster and more reliable than file triggers.**

```bash
node D:/projects/hivemind/ui/scripts/hm-send.js <target> "(ROLE #N): message"
```

| Target | Reaches |
|--------|---------|
| `architect` | Architect (pane 1) |
| `devops` | DevOps (pane 2) |
| `analyst` | Analyst (pane 5) |

**Why WebSocket over file triggers:**
- Zero message loss (file triggers lose 40%+ under rapid messaging)
- Faster delivery (~10ms vs 500ms+ file watcher debounce)
- No path resolution bugs

## Fallback: Trigger Files

**Always use ABSOLUTE paths to avoid ghost folder bugs.**

All trigger files live here:
```
D:\projects\hivemind\workspace\triggers\
```

### Canonical trigger files

| Pane | Role | Trigger file |
|------|------|--------------|
| 1 | Architect | `architect.txt` |
| 2 | DevOps | `devops.txt` |
| 5 | Analyst | `analyst.txt` |

### Broadcast and group triggers

| File | Who Gets Triggered |
|------|-------------------|
| `all.txt` | All pane agents |
| `workers.txt` | DevOps + Analyst |

## Message format (required)

Every message must use this exact format:

```
(ROLE #N): your message here
```

**Rules:**
- `ROLE` is the **sender's role**, not the target's role.
  - Example: DevOps -> Architect writes `(DEVOPS #1): ...` into `architect.txt`.
- `#N` must increment per sender. Duplicates are ignored.
- Start at `#1` each session.

## Legacy trigger names (still supported)

These are maintained for backward compatibility but should not be used for new work:

| Legacy name | Current target |
|------------|----------------|
| `lead.txt` | `architect.txt` |
| `orchestrator.txt` | `devops.txt` |
| `infra.txt` | `devops.txt` |
| `backend.txt` | `devops.txt` |
| `investigator.txt` | `analyst.txt` |

**Removed (no longer routed):** `frontend.txt`, `reviewer.txt`, `worker-a.txt`, `worker-b.txt`

## Examples

**WebSocket (preferred):**
```bash
node D:/projects/hivemind/ui/scripts/hm-send.js architect "(DEVOPS #1): Build complete, ready for review"
```

**PowerShell trigger file:**
```powershell
"(DEVOPS #1): message" | Set-Content -Path "D:\projects\hivemind\workspace\triggers\architect.txt"
```

**Bash trigger file:**
```bash
echo "(ANA #1): message" > "D:/projects/hivemind/workspace/triggers/architect.txt"
```

## Notes

- Trigger files are read and cleared after processing.
- WebSocket messaging (`hm-send.js`) is preferred over trigger files for reliability.
- Frontend and Reviewer communicate via Agent Teams SendMessage (internal to Architect pane), not triggers.
