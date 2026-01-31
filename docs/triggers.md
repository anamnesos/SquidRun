# Trigger Files Reference

This is the canonical reference for trigger file messaging in Hivemind.

## Where to write trigger files
All trigger files live here:

```
workspace/triggers/
```

## Canonical trigger files (use these)
| Pane | Role | Trigger file | Notes |
|------|------|--------------|-------|
| 1 | Architect | `architect.txt` | Primary coordinator |
| 2 | Infra | `infra.txt` | CI/CD + build scripts |
| 3 | Frontend | `frontend.txt` | UI/CSS/renderer |
| 4 | Backend | `backend.txt` | Daemon/processes |
| 5 | Analyst | `analyst.txt` | Debugging/root cause |
| 6 | Reviewer | `reviewer.txt` | Code review |

### Broadcast
- `all.txt` -> sends to all panes

### Group triggers
- `workers.txt` -> Frontend + Backend
- `implementers.txt` -> Infra + Frontend + Backend
- `others-{role}.txt` -> everyone except `{role}`
  - Examples: `others-architect.txt`, `others-infra.txt`, `others-frontend.txt`, `others-backend.txt`, `others-analyst.txt`, `others-reviewer.txt`
  - Legacy group names still supported: `others-lead.txt`, `others-orchestrator.txt`, `others-worker-a.txt`, `others-worker-b.txt`, `others-investigator.txt`

## Legacy trigger names (still supported)
These are maintained for backward compatibility:

| Legacy name | Current target |
|------------|----------------|
| `lead.txt` | `architect.txt` |
| `orchestrator.txt` | `infra.txt` |
| `worker-a.txt` | `frontend.txt` |
| `worker-b.txt` | `backend.txt` |
| `investigator.txt` | `analyst.txt` |

## Message format (required)
Every message must use this exact format:

```
(ROLE #N): your message here
```

**Rules:**
- `ROLE` is the **sender's role**, not the target's role.
  - Example: Reviewer -> Architect writes `(REVIEWER #12): ...` into `architect.txt`.
- `#N` must increment per sender. Duplicates are ignored.
- Start at `#1` each session.

## Windows PowerShell examples
**Direct message:**
```
"(INFRA #1): message" | Set-Content -Path "D:\projects\hivemind\workspace\triggers\architect.txt"
```

**Broadcast:**
```
"(ARCHITECT #1): update" | Set-Content -Path "D:\projects\hivemind\workspace\triggers\all.txt"
```

## Bash examples
**Direct message:**
```
echo "(INFRA #1): message" > "/path/to/workspace/triggers/architect.txt"
```

**Heredoc (multi-line):**
```
cat <<'EOF' > "/path/to/workspace/triggers/architect.txt"
(ANALYST #3): line one
line two
EOF
```

## Common pitfalls
- Single quotes + apostrophes: avoid single-quoted strings if your text contains `'`.
- Wrong role name: messages are dropped if `ROLE` does not match expected format.
- Sequence reset: restarting without resetting `#N` can cause "duplicate" drops.

## Notes
- Trigger files are read and cleared after processing.
- Legacy names are supported but should be avoided for new work.
