#!/usr/bin/env node
/**
 * hm-compat-count: Compatibility marker counter + baseline diff gate.
 *
 * Usage:
 *   node ui/scripts/hm-compat-count.js
 *   node ui/scripts/hm-compat-count.js --baseline
 *   node ui/scripts/hm-compat-count.js --diff
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const HM_SEARCH_PATH = path.resolve(__dirname, 'hm-search.js');
const BASELINE_PATH = path.join(PROJECT_ROOT, '.squidrun', 'baselines', 'compat-baseline.json');
const BASELINE_RELATIVE_PATH = '.squidrun/baselines/compat-baseline.json';
const DEBT_EXCEPTION_REGEX = /DEBT-EXCEPTION:([^:\s]+):([^:\s]+):(\d{4}-\d{2}-\d{2}):([^\r\n]+)/;

const CATEGORIES = [
  {
    key: 'hivemind_refs',
    description: 'hivemind references in ui/',
    searchPath: 'ui',
    pattern: '(?i)\\bhivemind\\b',
  },
  {
    key: 'dual_read_aliases',
    description: 'legacy dual-read alias entries in ui/config.js',
    searchPath: 'ui/config.js',
    pattern: '^\\s*[\'"]?(lead|arch|director|devops|orchestrator|infra|infrastructure|backend|worker-b|workerb|implementer-b|implementerb|back|analyst|ana|investigator)[\'"]?\\s*:',
  },
  {
    key: 'config_fallback_fields',
    description: 'fallback field references in ui/config.js',
    searchPath: 'ui/config.js',
    pattern: '(?i)\\b[a-z0-9_]*fallback[a-z0-9_]*\\b',
  },
];

function usage() {
  console.log('Usage: node ui/scripts/hm-compat-count.js [--baseline|--diff]');
  console.log('  --baseline   Write current counts to .squidrun/baselines/compat-baseline.json');
  console.log('  --diff       Compare current counts against baseline and fail only on net increase');
}

function parseArgs(argv) {
  const state = {
    baseline: false,
    diff: false,
    help: false,
  };

  for (const token of argv) {
    if (token === '--baseline') {
      state.baseline = true;
      continue;
    }
    if (token === '--diff') {
      state.diff = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      state.help = true;
      continue;
    }
    return { error: `Unknown option: ${token}` };
  }

  if (state.baseline && state.diff) {
    return { error: 'Use either --baseline or --diff, not both.' };
  }

  return state;
}

function countMatchesViaHmSearch(pattern, searchPath) {
  const result = spawnSync(
    process.execPath,
    [HM_SEARCH_PATH, pattern, searchPath, '--regex'],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024 * 16,
    }
  );

  if (result.error) {
    throw new Error(`Failed to run hm-search.js: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(`hm-search.js exited ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }

  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
}

function collectCounts() {
  const categories = {};
  let total = 0;

  for (const category of CATEGORIES) {
    const count = countMatchesViaHmSearch(category.pattern, category.searchPath);
    categories[category.key] = {
      count,
      path: category.searchPath,
      pattern: category.pattern,
      description: category.description,
    };
    total += count;
  }

  return {
    categories,
    total,
  };
}

function writeBaseline(report) {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    categories: report.categories,
    total: report.total,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readBaselineSafe() {
  if (!fs.existsSync(BASELINE_PATH)) {
    return {
      ok: false,
      reason: 'missing',
    };
  }

  try {
    const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, reason: 'invalid-json' };
    }
    return { ok: true, baseline: parsed };
  } catch (_) {
    return {
      ok: false,
      reason: 'invalid-json',
    };
  }
}

function getCountFromBaselineCategory(entry) {
  if (!entry) return 0;
  if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
  if (typeof entry.count === 'number' && Number.isFinite(entry.count)) return entry.count;
  return 0;
}

function getCurrentCommitMessage() {
  const envCandidates = [
    process.env.HM_COMMIT_MESSAGE,
    process.env.COMMIT_MESSAGE,
    process.env.GIT_COMMIT_MESSAGE,
    process.env.CI_COMMIT_MESSAGE,
  ];

  for (const candidate of envCandidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  const result = spawnSync('git', ['log', '-1', '--pretty=%B'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    return '';
  }
  return String(result.stdout || '').trim();
}

function parseDebtException(commitMessage) {
  if (typeof commitMessage !== 'string' || !commitMessage) return null;
  const match = commitMessage.match(DEBT_EXCEPTION_REGEX);
  if (!match) return null;

  const [, id, owner, expiry, rationale] = match;
  const expiryDate = new Date(`${expiry}T23:59:59Z`);
  if (Number.isNaN(expiryDate.getTime())) {
    return {
      id,
      owner,
      expiry,
      rationale: rationale.trim(),
      valid: false,
      reason: 'invalid-expiry',
    };
  }

  const now = Date.now();
  const expired = now > expiryDate.getTime();
  return {
    id,
    owner,
    expiry,
    rationale: rationale.trim(),
    valid: !expired,
    reason: expired ? 'expired' : 'active',
  };
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    usage();
    process.exit(1);
  }

  if (parsed.help) {
    usage();
    process.exit(0);
  }

  let current = null;
  try {
    current = collectCounts();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }

  if (parsed.baseline) {
    writeBaseline(current);
    printJson({
      mode: 'baseline',
      baselinePath: BASELINE_RELATIVE_PATH,
      categories: current.categories,
      total: current.total,
    });
    process.exit(0);
  }

  if (!parsed.diff) {
    printJson({
      mode: 'count',
      categories: current.categories,
      total: current.total,
    });
    process.exit(0);
  }

  const baselineResult = readBaselineSafe();
  if (!baselineResult.ok) {
    printJson({
      mode: 'diff',
      baselinePath: BASELINE_RELATIVE_PATH,
      baselineFound: false,
      guidance: [
        `Baseline not available (${baselineResult.reason}).`,
        `Create one with: node ui/scripts/hm-compat-count.js --baseline`,
        'Diff gate is non-blocking until a baseline exists.',
      ],
      categories: current.categories,
      total: current.total,
      diff: null,
      gate: {
        passed: true,
        skipped: true,
        reason: 'baseline-missing-or-invalid',
      },
    });
    process.exit(0);
  }

  const baseline = baselineResult.baseline;
  const baselineCategories = baseline.categories && typeof baseline.categories === 'object'
    ? baseline.categories
    : {};
  const baselineTotal = Number.isFinite(Number(baseline.total)) ? Number(baseline.total) : 0;

  const categoryDiff = {};
  for (const category of CATEGORIES) {
    const currentCount = getCountFromBaselineCategory(current.categories[category.key]);
    const baselineCount = getCountFromBaselineCategory(baselineCategories[category.key]);
    categoryDiff[category.key] = currentCount - baselineCount;
  }

  const totalDelta = current.total - baselineTotal;
  const commitMessage = getCurrentCommitMessage();
  const debtException = parseDebtException(commitMessage);
  const hasValidDebtException = Boolean(debtException && debtException.valid);
  const shouldFail = totalDelta > 0 && !hasValidDebtException;

  printJson({
    mode: 'diff',
    baselinePath: BASELINE_RELATIVE_PATH,
    categories: current.categories,
    total: current.total,
    baseline: {
      categories: baselineCategories,
      total: baselineTotal,
    },
    diff: {
      categories: categoryDiff,
      total: totalDelta,
    },
    gate: {
      passed: !shouldFail,
      reason: shouldFail
        ? 'net-increase-without-valid-debt-exception'
        : (totalDelta > 0 ? 'net-increase-allowed-by-debt-exception' : 'no-net-increase'),
      debtException: debtException || null,
    },
  });

  process.exit(shouldFail ? 1 : 0);
}

main();
