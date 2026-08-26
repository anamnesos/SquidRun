#!/usr/bin/env node
/**
 * hm-surface-audit
 *
 * Scans staged changes for net-new public surface area:
 * - IPC channel names
 * - ui/scripts/hm-*.js entrypoints
 * - environment variables
 * - settings keys
 *
 * Usage:
 *   node ui/scripts/hm-surface-audit.js [--enforce] [--commit-message "..."] [--commit-message-file <path>]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENTRYPOINT_RE = /^ui\/scripts\/hm-[a-z0-9-]+\.js$/i;
const SETTINGS_FILE_RE = /(^|\/).*settings.*\.json$/i;
const ENV_ASSIGN_FILE_RE = /\.(?:ya?ml|env|sh|bash|zsh|ps1|cmd|bat)$/i;
const DEBT_EXCEPTION_RE = /\bDEBT-EXCEPTION(?:\s*[:#-]\s*[A-Za-z0-9._/-]+)?\b/;

const IPC_CALL_RE = /\b(?:ipcMain|ipcRenderer|webContents|event\.sender)\.(?:handle|on|once|off|invoke|send|sendSync)\(\s*['"`]([^'"`]+)['"`]/g;
const ENV_PROCESS_RE = /process\.env(?:\.([A-Z][A-Z0-9_]+)|\[['"`]([A-Z][A-Z0-9_]+)['"`]\])/g;
const ENV_ASSIGN_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*[:=]/;
const SETTINGS_KEY_RE = /^\s*["']([A-Za-z0-9_.-]+)["']\s*:/;

function parseArgs(argv) {
  const args = {
    enforce: false,
    commitMessage: '',
    commitMessageFile: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--enforce') {
      args.enforce = true;
      continue;
    }
    if (token === '--commit-message' && i + 1 < argv.length) {
      args.commitMessage = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--commit-message-file' && i + 1 < argv.length) {
      args.commitMessageFile = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
}

function runGit(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : '';
    const message = stderr || error.message || `Failed command: ${command}`;
    throw new Error(message);
  }
}

function createBucket(name) {
  return {
    name,
    added: new Set(),
    removed: new Set(),
  };
}

function addSurface(bucket, sign, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return;
  if (sign === '+') bucket.added.add(normalized);
  if (sign === '-') bucket.removed.add(normalized);
}

function normalizeRepoPath(input) {
  return String(input || '').replace(/\\/g, '/');
}

function isHmEntrypoint(filePath) {
  return ENTRYPOINT_RE.test(normalizeRepoPath(filePath));
}

function isSettingsFile(filePath) {
  return SETTINGS_FILE_RE.test(normalizeRepoPath(filePath));
}

function collectIpcChannels(lineText, sign, buckets) {
  IPC_CALL_RE.lastIndex = 0;
  let match = IPC_CALL_RE.exec(lineText);
  while (match) {
    addSurface(buckets.ipcChannels, sign, match[1]);
    match = IPC_CALL_RE.exec(lineText);
  }
}

function collectEnvVars(filePath, lineText, sign, buckets) {
  ENV_PROCESS_RE.lastIndex = 0;
  let match = ENV_PROCESS_RE.exec(lineText);
  while (match) {
    const token = match[1] || match[2];
    addSurface(buckets.envVars, sign, token);
    match = ENV_PROCESS_RE.exec(lineText);
  }

  if (!ENV_ASSIGN_FILE_RE.test(filePath)) return;
  const assignMatch = ENV_ASSIGN_RE.exec(lineText);
  if (!assignMatch) return;
  addSurface(buckets.envVars, sign, assignMatch[1]);
}

function collectSettingsKeys(filePath, lineText, sign, buckets) {
  if (!isSettingsFile(filePath)) return;
  const match = SETTINGS_KEY_RE.exec(lineText);
  if (!match) return;
  addSurface(buckets.settingsKeys, sign, match[1]);
}

function parsePatch(diffText, buckets) {
  const lines = diffText.split(/\r?\n/);
  let currentFile = '';

  lines.forEach((line) => {
    if (line.startsWith('+++ b/')) {
      currentFile = normalizeRepoPath(line.slice('+++ b/'.length).trim());
      return;
    }
    if (!line.startsWith('+') && !line.startsWith('-')) {
      return;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      return;
    }

    const sign = line[0];
    const text = line.slice(1);
    collectIpcChannels(text, sign, buckets);
    collectEnvVars(currentFile, text, sign, buckets);
    collectSettingsKeys(currentFile, text, sign, buckets);
  });
}

function parseNameStatus(diffStatus, buckets) {
  diffStatus
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const parts = line.split('\t');
      const status = parts[0] || '';

      if (status.startsWith('R') || status.startsWith('C')) {
        const oldPath = normalizeRepoPath(parts[1] || '');
        const newPath = normalizeRepoPath(parts[2] || '');
        if (isHmEntrypoint(oldPath)) addSurface(buckets.hmEntrypoints, '-', oldPath);
        if (isHmEntrypoint(newPath)) addSurface(buckets.hmEntrypoints, '+', newPath);
        return;
      }

      const target = normalizeRepoPath(parts[1] || '');
      if (!isHmEntrypoint(target)) return;
      if (status.startsWith('A')) addSurface(buckets.hmEntrypoints, '+', target);
      if (status.startsWith('D')) addSurface(buckets.hmEntrypoints, '-', target);
    });
}

function minusSet(left, right) {
  const out = [];
  left.forEach((item) => {
    if (!right.has(item)) out.push(item);
  });
  return out.sort();
}

function summarizeBucket(bucket) {
  const addedOnly = minusSet(bucket.added, bucket.removed);
  const removedOnly = minusSet(bucket.removed, bucket.added);
  const pairCount = Math.min(addedOnly.length, removedOnly.length);
  const netNewCount = Math.max(0, addedOnly.length - removedOnly.length);

  return {
    name: bucket.name,
    addedOnly,
    removedOnly,
    pairCount,
    netNewCount,
  };
}

function readCommitMessage(args) {
  if (args.commitMessage) return args.commitMessage;
  if (args.commitMessageFile) {
    const resolved = path.resolve(args.commitMessageFile);
    if (!fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  }

  try {
    return runGit('git log -1 --pretty=%B');
  } catch {
    return '';
  }
}

function hasDebtExceptionToken(message) {
  return DEBT_EXCEPTION_RE.test(String(message || ''));
}

function printSummary(summaries) {
  summaries.forEach((summary) => {
    const addedCount = summary.addedOnly.length;
    const removedCount = summary.removedOnly.length;
    const pairInfo = summary.pairCount > 0 ? `, paired removals ${summary.pairCount}` : '';
    console.log(`- ${summary.name}: +${addedCount} / -${removedCount} => net-new ${summary.netNewCount}${pairInfo}`);

    if (addedCount > 0) {
      console.log(`  added: ${summary.addedOnly.join(', ')}`);
    }
    if (removedCount > 0) {
      console.log(`  removed: ${summary.removedOnly.join(', ')}`);
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.enforce ? 'enforce' : 'report';
  const buckets = {
    ipcChannels: createBucket('IPC channel names'),
    hmEntrypoints: createBucket('hm-*.js entrypoints'),
    envVars: createBucket('Environment variables'),
    settingsKeys: createBucket('Settings keys'),
  };

  let patch = '';
  let status = '';
  try {
    patch = runGit('git diff --cached --no-color --unified=0');
    status = runGit('git diff --cached --name-status --no-color');
  } catch (error) {
    console.error(`[hm-surface-audit] failed to read staged diff: ${error.message}`);
    process.exit(1);
  }

  console.log(`[hm-surface-audit] mode=${mode}`);
  if (!patch.trim() && !status.trim()) {
    console.log('No staged changes found.');
    process.exit(0);
  }

  parsePatch(patch, buckets);
  parseNameStatus(status, buckets);

  const summaries = [
    summarizeBucket(buckets.ipcChannels),
    summarizeBucket(buckets.hmEntrypoints),
    summarizeBucket(buckets.envVars),
    summarizeBucket(buckets.settingsKeys),
  ];

  printSummary(summaries);

  const totalNetNew = summaries.reduce((sum, item) => sum + item.netNewCount, 0);
  if (!args.enforce) {
    console.log(`[hm-surface-audit] report complete: total net-new surfaces=${totalNetNew}`);
    process.exit(0);
  }

  if (totalNetNew === 0) {
    console.log('[hm-surface-audit] enforce PASS: no unpaired net-new surfaces.');
    process.exit(0);
  }

  const commitMessage = readCommitMessage(args);
  if (hasDebtExceptionToken(commitMessage)) {
    console.log('[hm-surface-audit] enforce PASS: DEBT-EXCEPTION token present in commit message.');
    process.exit(0);
  }

  console.error('[hm-surface-audit] enforce FAIL: net-new public surfaces detected without paired removal or DEBT-EXCEPTION token.');
  console.error('Add a paired removal or include DEBT-EXCEPTION:<ticket-or-reason> in the commit message.');
  process.exit(1);
}

main();
