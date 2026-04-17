#!/bin/bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
exec node "$PROJECT_DIR/.claude/hooks/user-prompt-timestamp.js"
