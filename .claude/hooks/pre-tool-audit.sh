#!/bin/bash
# PreToolUse hook: Audit log all tool calls
# Logs tool usage to a rotating audit file for replay/observability

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
TOOL_ID=$(echo "$INPUT" | jq -r '.tool_use_id // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Extract command for Bash tools, file_path for file tools
DETAIL=""
case "$TOOL_NAME" in
  Bash)
    DETAIL=$(echo "$INPUT" | jq -r '.tool_input.command // "" | .[0:200]')
    ;;
  Edit|Write|Read)
    DETAIL=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
    ;;
  Agent)
    DETAIL=$(echo "$INPUT" | jq -r '.tool_input.description // .tool_input.prompt // "" | .[0:200]')
    ;;
  *)
    DETAIL=$(echo "$INPUT" | jq -r '.tool_input | tostring | .[0:200]')
    ;;
esac

# Append to audit log
AUDIT_DIR="D:/projects/squidrun/.squidrun/runtime"
mkdir -p "$AUDIT_DIR"
echo "$TIMESTAMP | $TOOL_NAME | $TOOL_ID | $DETAIL" >> "$AUDIT_DIR/architect-audit.log"

# Allow the action (exit 0, no blocking)
exit 0
