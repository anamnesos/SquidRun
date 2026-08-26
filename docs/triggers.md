# Trigger Files Reference

This is the canonical reference for trigger file messaging in SquidRun.

## Preferred: WebSocket Messaging

**Use `hm-send.js` for agent-to-agent messaging — faster and more reliable than file triggers.**

```bash
node ui/scripts/hm-send.js <target> "(ROLE #N): message"
```

| Target | Reaches |
|--------|---------|
| `architect` | Architect (pane 1) |
| `builder` | Builder (pane 2) |
| `oracle` | Oracle (Pane 3) |
| `builder-bg-1` | Background Builder slot 1 (`bg-2-1`, Builder-owned) |
| `builder-bg-2` | Background Builder slot 2 (`bg-2-2`, Builder-owned) |
| `builder-bg-3` | Background Builder slot 3 (`bg-2-3`, Builder-owned) |

Use canonical targets (`architect`, `builder`, `oracle`) for all new work.
Legacy aliases are still accepted and normalized by the runtime compatibility map.

Background targets also accept synthetic pane IDs directly (`bg-2-1`, `bg-2-2`, `bg-2-3`) through the WebSocket broker.

For Builder control operations (spawn/list/kill/kill-all/map), use:
```bash
node ui/scripts/hm-bg.js <command>
```

**Why WebSocket over file triggers:**
- Zero message loss (file triggers lose 40%+ under rapid messaging)
- Faster delivery (~10ms vs 500ms+ file watcher debounce)
- No path resolution bugs

## Fallback: Trigger Files

**Always use ABSOLUTE paths to avoid ghost folder bugs.**

`hm-send.js` writes fallback trigger files to global state (`resolveGlobalPath('triggers')` from `ui/config.js`).
Compatibility watchers still monitor the coordination-root trigger path.

Stage 1-3 note: trigger-file fallback is role/pane-file based and does not map `builder-bg-*` aliases directly.
Background Builder messaging is expected to use the WebSocket route.

Coordination-root trigger path:
```
.squidrun/triggers/
```

### Canonical trigger files

| Pane | Role | Trigger file |
|------|------|--------------|
| 1 | Architect | `architect.txt` |
| 2 | Builder | `builder.txt` |
| 3 | Oracle | `oracle.txt` |

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

**Removed (no longer routed):** `frontend.txt`, `reviewer.txt`, `worker-a.txt`
**Legacy-compatible alias:** `worker-b.txt` still routes to Builder (`builder.txt`) for backward compatibility; prefer canonical targets for new work.

## Examples

**WebSocket (preferred):**
```bash
node ui/scripts/hm-send.js architect "(BUILDER #1): Build complete, ready for review"
```

```bash
node ui/scripts/hm-send.js builder-bg-1 "(BUILDER #7): Take ownership of docs + tests for commit 365099b."
```

```bash
node ui/scripts/hm-bg.js spawn --slot 2
```

**PowerShell trigger file:**
```powershell
"(BUILDER #1): message" | Set-Content -Path ".squidrun/triggers/architect.txt"
```

**Bash trigger file:**
```bash
echo "(ORACLE #1): message" > ".squidrun/triggers/architect.txt"
```

## Notes

- Trigger files are read and cleared after processing.
- WebSocket messaging (`hm-send.js`) is preferred over trigger files for reliability.
