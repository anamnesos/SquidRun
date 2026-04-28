#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const COUNTER_PATH = path.join(PROJECT_DIR, '.squidrun', 'runtime', 'auto-continue-counter.json');
const LOG_PATH = path.join(PROJECT_DIR, '.squidrun', 'runtime', 'auto-continue.log');
const MAX_CONSECUTIVE = Number.parseInt(process.env.SQUIDRUN_AUTO_CONTINUE_MAX || '5', 10) || 5;

const CONTINUATION_PHRASES = [
  /\bcontinuing with\b/i,
  /\bcontinuing on\b/i,
  /\bnext i['']ll\b/i,
  /\bnext i will\b/i,
  /\bmoving on to\b/i,
  /\bmoving to\b/i,
  /\bgoing to (?:ship|continue|build|implement|wire|tackle|do)\b/i,
  /\bnow i['']ll\b/i,
  /\bnow i will\b/i,
  /\bstarting (?:on|with) (?:the )?(?:next|last|second|third|final)\b/i,
];

const FINAL_PHRASES = [
  /\bholding\.?\s*$/i,
  /\bstanding by\.?\s*$/i,
  /\bdone\.?\s*$/i,
  /\bcomplete\.?\s*$/i,
  /\bawaiting\b/i,
];

function readCounter() {
  try {
    if (!fs.existsSync(COUNTER_PATH)) return { count: 0, lastTurnId: null };
    const raw = fs.readFileSync(COUNTER_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { count: 0, lastTurnId: null };
  }
}

function writeCounter(state) {
  try {
    fs.mkdirSync(path.dirname(COUNTER_PATH), { recursive: true });
    fs.writeFileSync(COUNTER_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function logEvent(event) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8');
  } catch { /* ignore */ }
}

let payload = '';
process.stdin.on('data', (c) => { payload += c; });
process.stdin.on('end', () => {
  let parsed;
  try { parsed = JSON.parse(payload); } catch { process.exit(0); }

  const transcriptPath = parsed.transcript_path || parsed.transcriptPath;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) { process.exit(0); }

  let lastAssistant = '';
  let lastTurnId = null;
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === 'assistant' && entry?.message?.content) {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          lastAssistant = content
            .filter((c) => c && c.type === 'text')
            .map((c) => String(c.text || ''))
            .join('\n');
        } else if (typeof content === 'string') {
          lastAssistant = content;
        }
        lastTurnId = entry.uuid || entry.message?.id || null;
        break;
      }
    }
  } catch {
    process.exit(0);
  }

  if (!lastAssistant) { process.exit(0); }

  // If the message ends with a final-state phrase, honor the stop.
  if (FINAL_PHRASES.some((re) => re.test(lastAssistant))) {
    process.exit(0);
  }

  const hasContinuationPhrase = CONTINUATION_PHRASES.some((re) => re.test(lastAssistant));
  if (!hasContinuationPhrase) { process.exit(0); }

  const state = readCounter();
  if (state.lastTurnId === lastTurnId) {
    process.exit(0);
  }
  if ((state.count || 0) >= MAX_CONSECUTIVE) {
    logEvent({ event: 'cap_reached', count: state.count, max: MAX_CONSECUTIVE });
    writeCounter({ count: 0, lastTurnId });
    process.exit(0);
  }

  const newCount = (state.count || 0) + 1;
  writeCounter({ count: newCount, lastTurnId });
  logEvent({ event: 'auto_continue', count: newCount, max: MAX_CONSECUTIVE, lastAssistantTail: lastAssistant.slice(-200) });

  // Block stop, force a continuation turn.
  process.stderr.write(`Auto-continue (${newCount}/${MAX_CONSECUTIVE}): your last message indicated continuing work. Proceed with the next concrete step you described. To stop the auto-continue chain, end your next message with "Holding." or "Standing by."`);
  process.exit(2);
});
