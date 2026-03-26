#!/bin/bash
# PreCompact hook: capture critical context before compaction and stage memory PRs.

set -u

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-D:/projects/squidrun}"
RUNTIME_DIR="$PROJECT_DIR/.squidrun/runtime"
export NODE_NO_WARNINGS=1

# Read session info from stdin once so we can both log it and pass it to the extractor.
INPUT=$(cat)
readarray -t PRECOMPACT_FIELDS < <(printf '%s' "$INPUT" | node -e "let data=''; process.stdin.on('data', (chunk) => data += chunk); process.stdin.on('end', () => { try { const payload = JSON.parse(data || '{}'); process.stdout.write(String(payload.session_id ?? 'unknown') + '\n'); process.stdout.write(String(payload.trigger ?? 'auto') + '\n'); } catch { process.stdout.write('unknown\nauto\n'); } });")
SESSION_ID="${PRECOMPACT_FIELDS[0]:-unknown}"
TRIGGER="${PRECOMPACT_FIELDS[1]:-auto}"

mkdir -p "$RUNTIME_DIR"
cd "$PROJECT_DIR" || exit 0

# Log the compaction event.
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "$TIMESTAMP | PreCompact ($TRIGGER) | session=$SESSION_ID" >> "$RUNTIME_DIR/compaction-log.txt"

# Best-effort extraction: stage candidate memory PRs before the context window dies.
if command -v node >/dev/null 2>&1; then
  printf '%s' "$INPUT" | node "$PROJECT_DIR/ui/scripts/hm-memory-extract.js" \
    --proposed-by precompact-hook \
    > "$RUNTIME_DIR/precompact-memory-last.json" 2>> "$RUNTIME_DIR/precompact-memory-errors.log" || true
fi

# Output context that should survive compaction
cat << 'CONTEXT'
COMPACTION SURVIVAL NOTES:
- You are the Architect (Pane 1) in SquidRun session. Read CLAUDE.md and ROLES.md for role rules.
- Telegram replies: When user messages via [Telegram from ...], reply on Telegram via hm-send.js telegram. User is NOT at PC.
- Screenshots: .squidrun/screenshots/latest.png
- Long messages (>500 chars): Use --file with temp file for hm-send.js
- Agent comms: node ui/scripts/hm-send.js <target> "(ROLE #N): message"
- Comms history: node ui/scripts/hm-comms.js history --last N
- Check workspace/knowledge/ for shared procedural memory.
- Check .squidrun/app-status.json for current session number.
CONTEXT

# Inject Agency Layer verbatim anchors and profiles
if command -v node >/dev/null 2>&1; then
  node "$PROJECT_DIR/ui/scripts/hm-hook-injection.js"
fi
