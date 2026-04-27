#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const AUDIT_PATH = path.join(PROJECT_DIR, '.squidrun', 'runtime', 'permission-ask-violations.log');

const PHRASES = [
  /\bwant me to\b/i,
  /\bshould i\b/i,
  /\byour call\b/i,
  /\bdo you want\b/i,
  /\blet me know if you\b/i,
  /\bwould you like\b/i,
  /\bshall i\b/i,
  /\bdo you wish\b/i,
  /\bif you want me to\b/i,
  /\bwhich (?:do you|would you)\b/i,
  /\b\(a\) [^.]+ \(b\) [^.]+ \(c\)/i,
  /\bok with you\?/i,
];

let payload = '';
process.stdin.on('data', (c) => { payload += c; });
process.stdin.on('end', () => {
  let parsed;
  try { parsed = JSON.parse(payload); } catch { process.exit(0); }

  const transcriptPath = parsed.transcript_path || parsed.transcriptPath;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) { process.exit(0); }

  let lastAssistant = '';
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const role = entry?.message?.role || entry?.role;
      if (role !== 'assistant') continue;
      const content = entry?.message?.content || entry?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            lastAssistant += part.text + '\n';
          }
        }
      } else if (typeof content === 'string') {
        lastAssistant = content;
      }
      if (lastAssistant) break;
    }
  } catch { process.exit(0); }

  const hits = [];
  for (const re of PHRASES) {
    const m = lastAssistant.match(re);
    if (m) hits.push(m[0]);
  }

  if (hits.length === 0) { process.exit(0); }

  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, `${new Date().toISOString()} ${JSON.stringify(hits)}\n`, 'utf8');
  } catch {}

  const reason = `PERMISSION-ASK VIOLATION DETECTED in your last response. Phrases caught: ${JSON.stringify(hits)}. James has hard rule: do not route decisions back to him. Make the call yourself, act on it, and tell him what you did. Do not ask permission. Reissue the response without the permission-ask language.`;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason,
  }));
  process.exit(0);
});
