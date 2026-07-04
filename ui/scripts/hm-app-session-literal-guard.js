#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const APP_SESSION_LITERAL_RE = /\bapp-session-\d+(?:(?::|-)[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)?\b/g;
const APP_SESSION_LITERAL_EXACT_RE = /^app-session-\d+(?:(?::|-)[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)?$/;

const SCANNED_EXTENSIONS_RE = /\.(?:cjs|js|json|md|mjs|ts|tsx)$/i;
const IGNORED_DIRS = new Set([
  '.git',
  '.squidrun',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

const SELF_EXCLUDED_PATHS = new Set([
  'ui/scripts/hm-app-session-literal-guard.js',
  'ui/__tests__/app-session-literal-guard.test.js',
]);

const DEFAULT_ALLOWLIST = Object.freeze([
  {
    path: 'ui/modules/main/system-protected-evals.js',
    literal: 'app-session-462',
    count: 10,
    reason: 'Historical Phase 2 protected-evals route-metadata exhibit; verifies legacy pins stay fenced while new pins fail.',
  },
  {
    path: 'ui/modules/main/system-protected-evals.js',
    literal: 'app-session-462:eunbyeol',
    count: 2,
    reason: 'Historical Phase 2 cross-scope mismatch exhibit paired with the route-metadata protected eval.',
  },
  {
    path: 'ui/modules/main/system-protected-evals.js',
    literal: 'app-session-999',
    count: 2,
    reason: 'Historical negative route-metadata fixture paired with the protected-evals app-session-462 exhibit.',
  },
  {
    path: 'ui/__tests__/hm-send-surface-claim-guard.test.js',
    literal: 'app-session-386',
    count: 2,
    reason: 'Historical surface-claim guard fixture proving session claims cannot masquerade as current route proof.',
  },
  {
    path: 'ui/__tests__/missing-arm-watchdog.test.js',
    literal: 'app-session-406',
    count: 1,
    reason: 'Historical TrustQuote watchdog fixture for main-session projection, not current session authority.',
  },
  {
    path: 'ui/__tests__/missing-arm-watchdog.test.js',
    literal: 'app-session-406:trustquote',
    count: 14,
    reason: 'Historical TrustQuote watchdog fixture for scoped-arm liveness, not current session authority.',
  },
  {
    path: 'ui/__tests__/fixtures/mira-core-intent-queue-contract.json',
    literal: 'app-session-326',
    count: 14,
    reason: 'Historical Mira intent-queue contract sample; fixture data only, not route authority.',
  },
  {
    path: 'ui/__tests__/fixtures/mira-core-intent-queue-contract.json',
    literal: 'app-session-327',
    count: 1,
    reason: 'Historical Mira intent-queue alternate-session contract sample; fixture data only.',
  },
  {
    path: 'ui/__tests__/fixtures/mira-core-local-acceptance-contract.json',
    literal: 'app-session-326',
    count: 5,
    reason: 'Historical Mira local-acceptance contract sample; fixture data only, not route authority.',
  },
  {
    path: 'ui/__tests__/fixtures/mira-core-orientation-contract.json',
    literal: 'app-session-328',
    count: 1,
    reason: 'Historical Mira orientation contract sample; fixture data only, not route authority.',
  },
  {
    path: 'ui/__tests__/fixtures/mira-core-perception-contract.json',
    literal: 'app-session-326',
    count: 3,
    reason: 'Historical Mira perception contract sample; fixture data only, not route authority.',
  },
  {
    path: 'ui/__tests__/fixtures/mira-core-proposal-contract.json',
    literal: 'app-session-328',
    count: 14,
    reason: 'Historical Mira proposal contract sample; fixture data only, not route authority.',
  },
  {
    path: 'ui/__tests__/fixtures/mira-core-snapshot-contract.json',
    literal: 'app-session-328:eunbyeol',
    count: 1,
    reason: 'Historical Mira snapshot cross-scope contract sample; fixture data only.',
  },
]);

function normalizeRelPath(filePath = '') {
  return String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function normalizeLiteral(value = '') {
  return String(value || '').trim();
}

function classifyAppSessionLiteralScope(filePath = '') {
  const normalized = normalizeRelPath(filePath);
  if (!normalized || !SCANNED_EXTENSIONS_RE.test(normalized)) return null;

  const lowered = normalized.toLowerCase();
  const baseName = lowered.split('/').pop() || '';

  if (lowered === 'ui/modules/main/system-protected-evals.js') {
    return 'protected eval source';
  }
  if (/(^|\/)__tests__\/fixtures\//.test(lowered) || /(^|\/)fixtures?\//.test(lowered)) {
    return 'fixture path';
  }
  if (/(?:guard|watchdog|eval|fixture)/i.test(baseName)) {
    return 'guard/watchdog/eval/fixture file';
  }

  return null;
}

function shouldSkipDir(dirName = '') {
  return IGNORED_DIRS.has(String(dirName || '').toLowerCase());
}

function readCandidateFiles(rootPath = DEFAULT_ROOT, options = {}) {
  const root = path.resolve(rootPath || DEFAULT_ROOT);
  const excludePaths = options.excludePaths || SELF_EXCLUDED_PATHS;
  const files = [];

  function walk(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) walk(path.join(dirPath, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const absPath = path.join(dirPath, entry.name);
      const relPath = normalizeRelPath(path.relative(root, absPath));
      if (excludePaths.has(relPath)) continue;
      if (!classifyAppSessionLiteralScope(relPath)) continue;

      files.push({
        path: relPath,
        text: fs.readFileSync(absPath, 'utf8'),
      });
    }
  }

  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function findAppSessionLiteralOccurrences(text = '') {
  const occurrences = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');

  lines.forEach((lineText, index) => {
    APP_SESSION_LITERAL_RE.lastIndex = 0;
    let match = APP_SESSION_LITERAL_RE.exec(lineText);
    while (match) {
      occurrences.push({
        literal: match[0],
        line: index + 1,
        column: match.index + 1,
        lineText,
      });
      match = APP_SESSION_LITERAL_RE.exec(lineText);
    }
  });

  return occurrences;
}

function allowlistKey(filePath = '', literal = '') {
  return `${normalizeRelPath(filePath)}\u0000${normalizeLiteral(literal)}`;
}

function normalizeAllowlist(allowlist = DEFAULT_ALLOWLIST) {
  const entries = [];
  const invalid = [];
  const seen = new Set();

  for (const rawEntry of allowlist || []) {
    const entry = {
      path: normalizeRelPath(rawEntry?.path),
      literal: normalizeLiteral(rawEntry?.literal),
      count: Number(rawEntry?.count),
      reason: String(rawEntry?.reason || '').trim(),
    };
    const key = allowlistKey(entry.path, entry.literal);

    if (!entry.path || !entry.literal || !APP_SESSION_LITERAL_EXACT_RE.test(entry.literal)) {
      invalid.push({ ...entry, reasonCode: 'invalid_path_or_literal' });
      continue;
    }

    if (!Number.isInteger(entry.count) || entry.count < 1) {
      invalid.push({ ...entry, reasonCode: 'invalid_count' });
      continue;
    }
    if (entry.reason.length < 24) {
      invalid.push({ ...entry, reasonCode: 'missing_or_weak_reason' });
      continue;
    }
    if (seen.has(key)) {
      invalid.push({ ...entry, reasonCode: 'duplicate_allowlist_entry' });
      continue;
    }

    seen.add(key);
    entries.push(entry);
  }

  return { entries, invalid };
}

function evaluateAppSessionLiteralGuard({
  root = DEFAULT_ROOT,
  files = null,
  allowlist = DEFAULT_ALLOWLIST,
  excludePaths,
} = {}) {
  const effectiveExcludePaths = excludePaths || (files ? new Set() : SELF_EXCLUDED_PATHS);
  const scannedFiles = (files || readCandidateFiles(root, { excludePaths: effectiveExcludePaths }))
    .map((file) => ({
      path: normalizeRelPath(file.path),
      text: String(file.text || ''),
    }))
    .filter((file) => classifyAppSessionLiteralScope(file.path));

  const { entries: allowlistEntries, invalid: invalidAllowlistEntries } = normalizeAllowlist(allowlist);
  const allowlistByKey = new Map(allowlistEntries.map((entry) => [allowlistKey(entry.path, entry.literal), entry]));
  const occurrencesByKey = new Map();
  const violations = invalidAllowlistEntries.map((entry) => ({
    type: 'invalid_allowlist_entry',
    path: entry.path,
    literal: entry.literal,
    expectedCount: entry.count,
    reasonCode: entry.reasonCode,
  }));

  for (const file of scannedFiles) {
    const scope = classifyAppSessionLiteralScope(file.path);
    for (const occurrence of findAppSessionLiteralOccurrences(file.text)) {
      const key = allowlistKey(file.path, occurrence.literal);
      if (!occurrencesByKey.has(key)) {
        occurrencesByKey.set(key, {
          path: file.path,
          literal: occurrence.literal,
          scope,
          occurrences: [],
        });
      }
      occurrencesByKey.get(key).occurrences.push(occurrence);
    }
  }

  const allowlisted = [];
  for (const [key, group] of occurrencesByKey.entries()) {
    const allowlistEntry = allowlistByKey.get(key);
    if (!allowlistEntry) {
      violations.push({
        type: 'unallowlisted_app_session_literal',
        path: group.path,
        literal: group.literal,
        scope: group.scope,
        occurrences: group.occurrences,
      });
      continue;
    }

    if (group.occurrences.length !== allowlistEntry.count) {
      violations.push({
        type: 'allowlist_count_mismatch',
        path: group.path,
        literal: group.literal,
        scope: group.scope,
        expectedCount: allowlistEntry.count,
        actualCount: group.occurrences.length,
        reason: allowlistEntry.reason,
        occurrences: group.occurrences,
      });
      continue;
    }

    allowlisted.push({
      path: group.path,
      literal: group.literal,
      count: group.occurrences.length,
      reason: allowlistEntry.reason,
    });
  }

  for (const entry of allowlistEntries) {
    if (!occurrencesByKey.has(allowlistKey(entry.path, entry.literal))) {
      violations.push({
        type: 'unused_allowlist_entry',
        path: entry.path,
        literal: entry.literal,
        expectedCount: entry.count,
        reason: entry.reason,
      });
    }
  }

  return {
    ok: violations.length === 0,
    scannedFiles: scannedFiles.length,
    scopedFilesWithLiterals: occurrencesByKey.size,
    allowlisted,
    violations,
  };
}

function printUsage() {
  process.stdout.write([
    'Usage: node ui/scripts/hm-app-session-literal-guard.js [--root <path>] [--json]',
    '',
    'Fails if guard/watchdog/eval/fixture code contains hard-coded app-session literals outside the exact historical allowlist.',
  ].join('\n'));
}

function parseArgs(argv = []) {
  const args = {
    root: DEFAULT_ROOT,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--root' && argv[i + 1]) {
      args.root = path.resolve(argv[i + 1]);
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function printTextReport(report) {
  if (report.ok) {
    process.stdout.write([
      `[app-session-literal-guard] PASS scanned ${report.scannedFiles} scoped file(s).`,
      `[app-session-literal-guard] Allowlisted historical sample groups: ${report.allowlisted.length}.`,
    ].join('\n'));
    return;
  }

  process.stderr.write(`[app-session-literal-guard] FAIL ${report.violations.length} violation(s)\n`);
  for (const violation of report.violations) {
    if (violation.type === 'unallowlisted_app_session_literal') {
      process.stderr.write(`- ${violation.path}: ${violation.literal} (${violation.scope}) is not allowlisted\n`);
      for (const occurrence of violation.occurrences.slice(0, 5)) {
        process.stderr.write(`  ${violation.path}:${occurrence.line}:${occurrence.column} ${occurrence.lineText.trim()}\n`);
      }
      continue;
    }
    if (violation.type === 'allowlist_count_mismatch') {
      process.stderr.write(`- ${violation.path}: ${violation.literal} expected ${violation.expectedCount}, found ${violation.actualCount}\n`);
      continue;
    }
    process.stderr.write(`- ${violation.type}: ${violation.path || '(unknown path)'} ${violation.literal || ''} ${violation.reasonCode || ''}\n`);
  }
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      process.exit(0);
    }

    const report = evaluateAppSessionLiteralGuard({ root: args.root });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printTextReport(report);
      process.stdout.write('\n');
    }
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`[app-session-literal-guard] ERROR ${error.message}\n`);
    process.exit(2);
  }
}

module.exports = {
  APP_SESSION_LITERAL_EXACT_RE,
  APP_SESSION_LITERAL_RE,
  DEFAULT_ALLOWLIST,
  SELF_EXCLUDED_PATHS,
  classifyAppSessionLiteralScope,
  evaluateAppSessionLiteralGuard,
  findAppSessionLiteralOccurrences,
  normalizeAllowlist,
  normalizeRelPath,
  readCandidateFiles,
};
