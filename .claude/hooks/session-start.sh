#!/bin/bash
# SessionStart hook: Log session initialization and inject context
# Fires on startup, resume, clear, and compact

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).source||'unknown')}catch{console.log('unknown')}})" 2>/dev/null || echo "unknown")
SESSION_ID=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).session_id||'unknown')}catch{console.log('unknown')}})" 2>/dev/null || echo "unknown")
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

AGENCY_LAYER=""
AI_BRIEFING=""
if command -v node >/dev/null 2>&1; then
  AGENCY_LAYER=$(
    printf '%s' "$INPUT" \
      | node "$PROJECT_DIR/ui/scripts/hm-hook-injection.js" 2>> "$AUDIT_DIR/hook-injection-errors.log" \
      | sed '/^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9][0-9] \[[A-Z]\+\]/d'
  )
fi
AI_BRIEFING_PATH="$PROJECT_DIR/.squidrun/handoffs/ai-briefing.md"
if [ -f "$AI_BRIEFING_PATH" ]; then
  AI_BRIEFING=$(cat "$AI_BRIEFING_PATH")
fi
LATEST_HANDOFF_PATH="workspace/knowledge/session-handoff.md"
if command -v node >/dev/null 2>&1; then
  LATEST_HANDOFF_PATH=$(
    node - "$PROJECT_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const projectDir = process.argv[2];
const candidates = [
  path.join(projectDir, '.squidrun', 'handoffs', 'session.md'),
  path.join(projectDir, '.squidrun', 'handoffs', 'last-session.md'),
  path.join(projectDir, '.squidrun', 'handoffs', 'last-session-summary.md'),
];
const knowledgeDir = path.join(projectDir, 'workspace', 'knowledge');
try {
  for (const entry of fs.readdirSync(knowledgeDir)) {
    if (/^session-\d+-handoff\.md$/i.test(entry)) {
      candidates.push(path.join(knowledgeDir, entry));
    }
  }
} catch {}
const ranked = candidates
  .filter((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  })
  .map((candidate) => ({ candidate, mtimeMs: fs.statSync(candidate).mtimeMs }))
  .sort((left, right) => right.mtimeMs - left.mtimeMs);
const chosen = ranked[0]?.candidate || path.join(projectDir, '.squidrun', 'handoffs', 'session.md');
console.log(path.relative(projectDir, chosen).replace(/\\/g, '/'));
NODE
  )
fi

PREFIX="Session started."
if [ "$SOURCE" = "compact" ] || [ "$SOURCE" = "resume" ]; then
  PREFIX="Session resumed/compacted."
fi

COMBINED_CONTEXT="$PREFIX\n\nMANDATORY READS BEFORE DOING ANYTHING:\n1. $LATEST_HANDOFF_PATH - Latest session handoff with open items, live positions, and James's feedback\n2. workspace/knowledge/trading-operations.md - Hyperliquid=REAL money, Alpaca=FAKE. Check positions FIRST.\n3. workspace/knowledge/case-operations.md - 은별 pending items and routing rules.\n\nROUTING: 은별=send-long-telegram.js 8754356993. James=hm-send.js telegram (ENGLISH ONLY). Use Builder/Oracle not subagents.\n\nTRADING: Alpaca is paper. Hyperliquid is real. Run hm-defi-status.js every cycle. Don't wait for prompts.\n\n$AI_BRIEFING\n\n$AGENCY_LAYER"
JSON_SAFE_CONTEXT=$(echo -n "$COMBINED_CONTEXT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(d)))" 2>/dev/null || echo '"context unavailable"')

echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":'"$JSON_SAFE_CONTEXT"'}}'

exit 0
