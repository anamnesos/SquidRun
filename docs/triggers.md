# Trigger Files Reference

This is the canonical reference for trigger file messaging in Hivemind.

## Preferred: WebSocket Messaging

**Use `hm-send.js` for agent-to-agent messaging — faster and more reliable than file triggers.**

```bash
node ui/scripts/hm-send.js <target> "(ROLE #N): message"
```

| Target | Reaches |
|--------|---------|
| `architect` | Architect (pane 1) |
| `builder` | Builder (pane 2) |
| `oracle` | Oracle (pane 5) |

Legacy targets `devops` and `analyst` still work and route to Builder/Oracle respectively.

**Why WebSocket over file triggers:**
- Zero message loss (file triggers lose 40%+ under rapid messaging)
- Faster delivery (~10ms vs 500ms+ file watcher debounce)
- No path resolution bugs

## Fallback: Trigger Files

**Always use ABSOLUTE paths to avoid ghost folder bugs.**

All trigger files live here:
```
.hivemind/triggers/
```
Legacy fallback: `workspace/triggers/`

### Canonical trigger files

| Pane | Role | Trigger file |
|------|------|--------------|
| 1 | Architect | `architect.txt` |
| 2 | Builder | `builder.txt` |
| 5 | Oracle | `oracle.txt` |

### Broadcast and group triggers

| File | Who Gets Triggered |
|------|-------------------|
| `all.txt` | All pane agents |
| `workers.txt` | Builder |

## Message format (required)

Every message must use this exact format:

```
(ROLE #N): your message here
```

**Rules:**
- `ROLE` is the **sender's role**, not the target's role.
  - Example: Builder -> Architect writes `(BUILDER #1): ...` into `architect.txt`.
- `#N` must increment per sender. Duplicates are ignored.
- Start at `#1` each session.

## Legacy trigger names (still supported)

These are maintained for backward compatibility but should not be used for new work:

| Legacy name | Current target |
|------------|----------------|
| `lead.txt` | `architect.txt` |
| `devops.txt` | `builder.txt` |
| `analyst.txt` | `oracle.txt` |
| `orchestrator.txt` | `builder.txt` |
| `infra.txt` | `builder.txt` |
| `backend.txt` | `builder.txt` |
| `investigator.txt` | `oracle.txt` |

**Removed (no longer routed):** `frontend.txt`, `reviewer.txt`, `worker-a.txt`, `worker-b.txt`

## Examples

**WebSocket (preferred):**
```bash
node ui/scripts/hm-send.js architect "(BUILDER #1): Build complete, ready for review"
```

**PowerShell trigger file:**
```powershell
"(BUILDER #1): message" | Set-Content -Path ".hivemind/triggers/architect.txt"
```

**Bash trigger file:**
```bash
echo "(ORACLE #1): message" > ".hivemind/triggers/architect.txt"
```

## Notes

- Trigger files are read and cleared after processing.
- WebSocket messaging (`hm-send.js`) is preferred over trigger files for reliability.
