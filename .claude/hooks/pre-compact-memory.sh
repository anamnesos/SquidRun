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

# Output context that should survive compaction
cat <<CONTEXT
COMPACTION SURVIVAL NOTES:
- You are the Architect (Pane 1) in SquidRun session. Read CLAUDE.md and ROLES.md for role rules.
- Telegram replies: When user messages via [Telegram from ...], reply on Telegram via hm-send.js telegram. User is NOT at PC.
- Screenshots: .squidrun/screenshots/latest.png
- Long messages (>500 chars): Use --file with temp file for hm-send.js
- Agent comms: node ui/scripts/hm-send.js <target> "(ROLE #N): message"
- Comms history: node ui/scripts/hm-comms.js history --last N
- Check workspace/knowledge/ for shared procedural memory.
- Check .squidrun/app-status.json for current session number.

CASE OPERATIONS (CRITICAL — read before replying to 은별):
- 은별 Telegram: cd D:/projects/squidrun/ui && node ../tools/send-long-telegram.js 8754356993 <filepath>
- James Telegram: node ui/scripts/hm-send.js telegram --file <filepath> (ENGLISH ONLY)
- NEVER use Claude Code subagents. Use Builder/Oracle via hm-send.js.
- MUST read workspace/knowledge/case-operations.md for pending items before replying to 은별.
- Three cases: Jeon Myeongsam (fraud), Hillstate (apartment), Qeline (counterfeit). NEVER mix.

TRADING (CRITICAL — ALL agents must know this):
- Alpaca = PAPER/FAKE money. Hyperliquid = REAL money. Only Hyperliquid matters.
- MUST read workspace/knowledge/trading-operations.md on every startup.
- Run hm-defi-status.js EVERY consultation cycle to check real positions.
- Don't wait for prompts. Actively seek trades. Report results not plans.

SESSION HANDOFF:
- MUST read $LATEST_HANDOFF_PATH on startup.
- Update this file at end of every session or before compaction with: open positions, pending items, unresolved concerns, key feedback.
- This file IS the memory between sessions. Keep it current.
CONTEXT

# Inject Agency Layer verbatim anchors and profiles
if command -v node >/dev/null 2>&1; then
  node "$PROJECT_DIR/ui/scripts/hm-hook-injection.js"
fi
