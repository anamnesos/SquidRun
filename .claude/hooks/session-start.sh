#!/bin/bash
# SessionStart hook: Log session initialization and inject context
# Fires on startup, resume, clear, and compact

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

AUDIT_DIR="D:/projects/squidrun/.squidrun/runtime"
mkdir -p "$AUDIT_DIR"
echo "$TIMESTAMP | SessionStart ($SOURCE) | session=$SESSION_ID" >> "$AUDIT_DIR/architect-audit.log"

# On compact/resume, output reminder context
if [ "$SOURCE" = "compact" ] || [ "$SOURCE" = "resume" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Session resumed/compacted. Re-read CLAUDE.md and workspace/knowledge/ for context. Check hm-comms history for recent messages."}}'
fi

exit 0
