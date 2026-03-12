#!/bin/bash
# PostToolUse hook: Capture results for replay/observability
# Logs successful tool completions with key result info

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
TOOL_ID=$(echo "$INPUT" | jq -r '.tool_use_id // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Log completion
AUDIT_DIR="D:/projects/squidrun/.squidrun/runtime"
mkdir -p "$AUDIT_DIR"
echo "$TIMESTAMP | DONE | $TOOL_NAME | $TOOL_ID" >> "$AUDIT_DIR/architect-audit.log"

exit 0
