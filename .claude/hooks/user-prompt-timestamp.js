#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function buildStamp(now = new Date()) {
  const format = (timeZone, suffix) => {
    const value = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);

    return `${value.replace(',', '')} ${suffix}`;
  };

  return `[${format('America/Los_Angeles', 'PDT')} / ${format('Asia/Seoul', 'KST')}]`;
}

async function readHookInput() {
  return new Promise((resolve) => {
    let stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      stdin += chunk;
    });
    process.stdin.on('error', () => resolve({}));
    process.stdin.on('end', () => {
      if (!stdin.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(stdin));
      } catch {
        resolve({});
      }
    });
    process.stdin.resume();
  });
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function extractPromptText(payload = {}) {
  const candidates = [
    payload.prompt,
    payload.user_prompt,
    payload.message,
    payload.input,
    payload.text,
    payload.content,
  ];

  for (const candidate of candidates) {
    const normalized = toText(candidate, '');
    if (normalized) return normalized;
  }

  if (Array.isArray(payload.messages)) {
    const latestUser = [...payload.messages].reverse().find((entry) => {
      return entry && typeof entry === 'object' && String(entry.role || '').toLowerCase() === 'user';
    });
    const normalized = toText(latestUser?.content || latestUser?.text || '', '');
    if (normalized) return normalized;
  }

  return '';
}

function isInternalSystemMessage(value) {
  const text = toText(value, '').toUpperCase();
  if (!text) return false;
  return text.startsWith('[WATCHDOG]') || text.startsWith('[AGENT MSG - REPLY VIA HM-SEND.JS]');
}

function buildAuditPath(projectDir) {
  return path.join(projectDir, '.squidrun', 'runtime', 'user-prompt-hook.log');
}

function appendAudit(projectDir, line) {
  try {
    const targetPath = buildAuditPath(projectDir);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.appendFileSync(targetPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // Best effort only.
  }
}

function emitContext(additionalContext) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };

  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function main() {
  const payload = await readHookInput();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
  const promptText = extractPromptText(payload);
  if (promptText && !isInternalSystemMessage(promptText)) {
    appendAudit(projectDir, '[recall-disabled] UserPromptSubmit no longer injects recall results.');
  }
  const additionalContext = buildStamp();
  emitContext(additionalContext);
}

main().catch(() => {
  emitContext(buildStamp());
});
