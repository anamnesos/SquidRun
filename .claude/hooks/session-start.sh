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

PROFILE="${SQUIDRUN_PROFILE:-main}"

STARTUP_HEALTH=""
if [ "$SOURCE" != "compact" ] && command -v node >/dev/null 2>&1; then
  STARTUP_HEALTH=$(
    node "$PROJECT_DIR/ui/scripts/hm-startup-health.js" "--profile=$PROFILE" 2>> "$AUDIT_DIR/startup-health-errors.log"
  )
fi

# Architect inbox summary — surface unread file-first sidechannel entries.
# Per agent-sidechannel-protocol-2026-04-29.md: agents may write to
# .squidrun/coord/architect-inbox.jsonl with thread-update / review-request /
# wake entries. Pull a short summary at startup so the architect doesn't miss
# them when the parent dispatch was a short pointer-only hm-send (or omitted).
INBOX_SUMMARY=""
if [ "$PROFILE" != "eunbyeol" ] && command -v node >/dev/null 2>&1; then
  if [ -f "$PROJECT_DIR/.squidrun/coord/architect-inbox.jsonl" ] && [ -f "$PROJECT_DIR/ui/scripts/hm-inbox-read.js" ]; then
    INBOX_SUMMARY=$(
      node "$PROJECT_DIR/ui/scripts/hm-inbox-read.js" architect --summary 2>> "$AUDIT_DIR/inbox-summary-errors.log" || true
    )
  fi
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
AI_BRIEFING_STATUS_PATH="$PROJECT_DIR/.squidrun/runtime/startup-briefing-status.json"
if [ -f "$AI_BRIEFING_PATH" ] && command -v node >/dev/null 2>&1; then
  AI_BRIEFING=$(
    node - "$AI_BRIEFING_PATH" "$AI_BRIEFING_STATUS_PATH" <<'NODE'
const fs = require('fs');
const briefingPath = process.argv[2];
const statusPath = process.argv[3];

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readStatus(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function stripLiveAccountBlocks(markdown) {
  const out = [];
  let skip = false;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (/^#{1,3}\s+/.test(line)) {
      const lower = line.toLowerCase();
      skip = /live account|verified live|live positions|open positions|hyperliquid.*snapshot/.test(lower);
    }
    if (!skip) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const raw = readText(briefingPath);
const status = readStatus(statusPath);
const generatedAtMs = Date.parse(status?.generatedAt || '');
const ageMinutes = Number.isFinite(generatedAtMs)
  ? Math.max(0, Math.round((Date.now() - generatedAtMs) / 60000))
  : null;

let body = raw.trim();
const notes = [];
if (ageMinutes === null) {
  notes.push('STALE SNAPSHOT generated at unknown time, account values may have moved.');
} else if (ageMinutes > 60) {
  notes.push(`STALE SNAPSHOT generated ${ageMinutes} minutes ago; live-account block omitted, account values may have moved.`);
  body = stripLiveAccountBlocks(body);
} else if (ageMinutes > 15) {
  notes.push(`STALE SNAPSHOT generated ${ageMinutes} minutes ago, account values may have moved.`);
} else {
  notes.push(`AI startup briefing age: ${ageMinutes} minutes.`);
}

process.stdout.write(`${notes.join('\n')}\n\n${body}\n`);
NODE
  )
elif [ -f "$AI_BRIEFING_PATH" ]; then
  AI_BRIEFING=$(cat "$AI_BRIEFING_PATH")
fi
LATEST_HANDOFF_PATH=".squidrun/handoffs/session.md"
ADDITIONAL_HANDOFF_CONTEXT=""
if command -v node >/dev/null 2>&1; then
  HANDOFF_SELECTION=$(
    node - "$PROJECT_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const projectDir = process.argv[2];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function rel(filePath) {
  return path.relative(projectDir, filePath).replace(/\\/g, '/');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const appStatus = readJson(path.join(projectDir, '.squidrun', 'app-status.json'));
const currentSession = Number(appStatus?.session);
const expectedSessionId = Number.isInteger(currentSession) && currentSession > 0
  ? `app-session-${currentSession}`
  : null;
const canonical = path.join(projectDir, '.squidrun', 'handoffs', 'session.md');
const canonicalContent = readText(canonical);
const canonicalValid = Boolean(canonicalContent)
  && (!expectedSessionId || new RegExp(`^-\\s+session_id:\\s*${escapeRegExp(expectedSessionId)}\\s*$`, 'm').test(canonicalContent));

const additional = [
  { path: path.join(projectDir, '.squidrun', 'handoffs', 'last-session.md'), label: 'last-session backup' },
  { path: path.join(projectDir, '.squidrun', 'handoffs', 'last-session-summary.md'), label: 'last-session summary' },
];
const knowledgeDir = path.join(projectDir, 'workspace', 'knowledge');
try {
  for (const entry of fs.readdirSync(knowledgeDir)) {
    if (/^session-\d+-handoff\.md$/i.test(entry)) {
      additional.push({ path: path.join(knowledgeDir, entry), label: 'knowledge handoff' });
    }
  }
} catch {}

const existingAdditional = additional.filter((entry) => {
    try {
      return fs.statSync(entry.path).isFile();
    } catch {
      return false;
    }
  });

const contextLines = [];
if (canonicalValid) {
  contextLines.push(`[Current handoff validated: ${rel(canonical)} matches app-status session ${currentSession}.]`);
} else {
  contextLines.push(`[Current handoff warning: ${rel(canonical)} does not validate against app-status session ${currentSession || 'unknown'}; do not treat older handoffs as current truth.]`);
}
if (existingAdditional.length > 0) {
  contextLines.push('ADDITIONAL HANDOFF CONTEXT (explicitly not current-session truth):');
  for (const entry of existingAdditional) {
    contextLines.push(`- ${entry.label}: ${rel(entry.path)}`);
  }
}

console.log(JSON.stringify({
  latestPath: rel(canonical),
  additionalContext: contextLines.join('\n'),
}));
NODE
  )
  LATEST_HANDOFF_PATH=$(printf '%s' "$HANDOFF_SELECTION" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).latestPath||'.squidrun/handoffs/session.md')}catch{console.log('.squidrun/handoffs/session.md')}})" 2>/dev/null)
  ADDITIONAL_HANDOFF_CONTEXT=$(printf '%s' "$HANDOFF_SELECTION" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).additionalContext||'')}catch{}})" 2>/dev/null)
fi

PREFIX="Session started."
if [ "$SOURCE" = "compact" ] || [ "$SOURCE" = "resume" ]; then
  PREFIX="Session resumed/compacted."
fi

if [ "$PROFILE" = "eunbyeol" ]; then
  # Eunbyeol window: case work only. NO trading context, NO trading routing,
  # NO architect agency layer. Cross-contamination here historically caused
  # agents to mix James's trading state into 은별's case window after compaction.
  COMBINED_CONTEXT="$PREFIX\n\n[EUNBYEOL WINDOW — case work only. Do not discuss trading, account balances, or Hyperliquid positions in this window. James has a separate trading window.]\n\nSYSTEM HEALTH (auto-fixed where safe):\n$STARTUP_HEALTH\n\nMANDATORY READS BEFORE REPLYING TO 은별:\n1. workspace/knowledge/case-operations.md - 은별 pending items dashboard + routing\n2. workspace/knowledge/handoff-corrections.md - drift guard: disputed facts that MUST be re-checked against source evidence\n3. D:/projects/Korean Fraud/reference/confirmed-facts.md - Qeline counterfeit case\n4. D:/projects/Hillstate Case/reference/confirmed-facts.md - Hillstate apartment fraud\n5. D:/projects/Jeon Myeongsam Case/reference/confirmed-facts.md - 전명삼 investment fraud\n\nROUTING: 은별 = node ../tools/send-long-telegram.js 8754356993 <filepath> (Korean only). Builder/Oracle = hm-send.js builder|oracle (NOT subagents).\n\nTERMINOLOGY: When you see 'session NNN' in handoffs/memory, that refers to a SquidRun session number — distinct from this CLI conversation and from Anthropic's per-conversation context. Don't conflate them.\n\nDO NOT auto-load: trading-operations.md, ai-briefing.md (trading half), Architect agency layer."
else
  COMBINED_CONTEXT="$PREFIX\n\nSYSTEM HEALTH (auto-fixed where safe):\n$STARTUP_HEALTH\n\nARCHITECT INBOX:\n$INBOX_SUMMARY\n\nMANDATORY READS BEFORE DOING ANYTHING:\n1. $LATEST_HANDOFF_PATH - Current session handoff with open items, live positions, and James's feedback\n2. workspace/knowledge/trading-operations.md - Hyperliquid=REAL money, Alpaca=FAKE. Check positions FIRST.\n3. workspace/knowledge/case-operations.md - 은별 pending items and routing rules.\n\n$ADDITIONAL_HANDOFF_CONTEXT\n\nROUTING: 은별=send-long-telegram.js 8754356993. James=hm-send.js telegram (ENGLISH ONLY). Use Builder/Oracle not subagents.\n\nTRADING: Alpaca is paper. Hyperliquid is real. Run hm-defi-status.js every cycle. Don't wait for prompts.\n\n$AI_BRIEFING\n\n$AGENCY_LAYER"
fi
JSON_SAFE_CONTEXT=$(echo -n "$COMBINED_CONTEXT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(d)))" 2>/dev/null || echo '"context unavailable"')

echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":'"$JSON_SAFE_CONTEXT"'}}'

exit 0
