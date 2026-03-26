#!/bin/bash
# SessionStart hook: Log session initialization and inject context
# Fires on startup, resume, clear, and compact

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-D:/projects/squidrun}"

AUDIT_DIR="$PROJECT_DIR/.squidrun/runtime"
mkdir -p "$AUDIT_DIR"
echo "$TIMESTAMP | SessionStart ($SOURCE) | session=$SESSION_ID" >> "$AUDIT_DIR/architect-audit.log"

# Architect startup wiring: auto-promote any staged Memory PRs so extracted
# facts flow back into workspace/knowledge before the coordinator reads context.
if [ "$SOURCE" != "compact" ] && command -v node >/dev/null 2>&1; then
  node "$PROJECT_DIR/ui/scripts/hm-memory-promote.js" approve --all \
    >> "$AUDIT_DIR/memory-pr-approval.log" 2>> "$AUDIT_DIR/memory-pr-approval-errors.log" || true
fi

# On compact/resume, output reminder context
if [ "$SOURCE" = "compact" ] || [ "$SOURCE" = "resume" ]; then
  # Build a combined string of the default context + the injected agency layer
  AGENCY_LAYER=""
  if command -v node >/dev/null 2>&1; then
    AGENCY_LAYER=$(node "$PROJECT_DIR/ui/scripts/hm-hook-injection.js")
  fi
  
  # Escape for JSON string
  COMBINED_CONTEXT="Session resumed/compacted. Re-read CLAUDE.md and workspace/knowledge/ for context. Check hm-comms history for recent messages.\n\n$AGENCY_LAYER"
  JSON_SAFE_CONTEXT=$(echo -n "$COMBINED_CONTEXT" | jq -Rs .)

  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":'"$JSON_SAFE_CONTEXT"'}}'
fi

exit 0
