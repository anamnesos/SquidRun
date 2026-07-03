#!/usr/bin/env node
'use strict';

/**
 * GATE INSIDE THE LOOP v0 (organism charter S465, Builder organ):
 * a pre-flight a pane runs on its OWN draft before it ships. The comms
 * hooks gate what leaves; nothing gated what an agent believed - this
 * week's invented test bound and false "4/4" both happened between a
 * mind and the tree. Three mechanical checks, letters-forward:
 *
 *   CITED GREENS   - "N/M" test claims verify against a real jest run
 *                    (--suite) or are flagged UNVERIFIED, never assumed.
 *   REAL HASHES    - commit hashes referenced in the draft must exist.
 *   REAL PATHS     - repo paths referenced in the draft must exist.
 *
 * Usage:
 *   node ui/scripts/hm-claim-preflight.js check --file <draft> [--suite <testfile>]
 *   node ui/scripts/hm-claim-preflight.js check --text "..." [--suite <testfile>]
 * Exit 0 = claims hold (or only UNVERIFIED warnings), 1 = a claim is FALSE.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function extractClaims(text) {
  const body = String(text || '');
  const claims = { testCounts: [], hashes: [], paths: [] };
  // "13/13" style counts near test-ish words (same line, either side).
  for (const line of body.split('\n')) {
    if (!/\b(test|suite|contract|green|pass|spec)\w*/i.test(line)) continue;
    for (const match of line.matchAll(/\b(\d{1,4})\/(\d{1,4})\b/g)) {
      const passed = Number(match[1]);
      const total = Number(match[2]);
      // Dates/fractions noise guard: totals of 0 or absurd ratios skipped.
      if (total > 0 && passed <= total) claims.testCounts.push({ passed, total, line: line.trim().slice(0, 120) });
    }
  }
  // Commit-hash-shaped tokens (7-10 hex, must contain a digit - the same
  // heuristic the face humanizer uses, so English words survive).
  for (const match of body.matchAll(/\b(?=[0-9a-f]{7,10}\b)[a-f]*\d[0-9a-f]*\b/g)) {
    claims.hashes.push(match[0]);
  }
  // Repo-relative paths (ui/..., workspace/..., .squidrun/... with a dot-ext
  // or trailing dir). Skip obvious globs and placeholders.
  for (const match of body.matchAll(/\b(?:ui|workspace|docs)\/[\w./-]+\.\w{1,6}\b/g)) {
    if (match[0].includes('*') || match[0].includes('<')) continue;
    claims.paths.push(match[0]);
  }
  return claims;
}

function verifyHash(hash) {
  try {
    execFileSync('git', ['cat-file', '-e', `${hash}^{commit}`], { cwd: PROJECT_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runSuite(suitePath) {
  // A real jest run is the ONLY acceptable green citation (false-4/4 lesson:
  // a claim's suite must be run, not remembered).
  const jestBin = path.join(PROJECT_ROOT, 'ui', 'node_modules', 'jest', 'bin', 'jest.js');
  // Jest writes its summary to STDERR even on success - spawnSync captures
  // both streams regardless of exit code (the live self-test caught the
  // execFileSync version ignoring stderr on the success path).
  const run = spawnSync(process.execPath, [jestBin, suitePath, '--silent', '--ci'], {
    cwd: path.join(PROJECT_ROOT, 'ui'),
    encoding: 'utf8',
  });
  return parseJestCounts(`${run.stdout || ''}\n${run.stderr || ''}`);
}

function parseJestCounts(output) {
  const match = String(output).match(/Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed, (\d+) total/);
  if (!match) return null;
  return {
    failed: Number(match[1] || 0),
    skipped: Number(match[2] || 0),
    passed: Number(match[3]),
    total: Number(match[4]),
  };
}

function preflight(text, { suite = null, skipSuiteRun = false } = {}) {
  const claims = extractClaims(text);
  const findings = [];

  for (const hash of [...new Set(claims.hashes)]) {
    if (!verifyHash(hash)) {
      findings.push({ level: 'FALSE', check: 'real-hash', detail: `commit ${hash} does not exist in this repo` });
    }
  }

  for (const claimPath of [...new Set(claims.paths)]) {
    if (!fs.existsSync(path.join(PROJECT_ROOT, claimPath))) {
      findings.push({ level: 'FALSE', check: 'real-path', detail: `${claimPath} does not exist` });
    }
  }

  if (claims.testCounts.length > 0) {
    if (suite && !skipSuiteRun) {
      const counts = runSuite(suite);
      if (!counts) {
        findings.push({ level: 'FALSE', check: 'cited-green', detail: `suite ${suite} produced no parseable result` });
      } else {
        for (const claim of claims.testCounts) {
          const matches = (claim.passed === counts.passed && claim.total === counts.total)
            || (claim.passed === counts.passed && claim.passed === claim.total && counts.failed === 0);
          if (!matches) {
            findings.push({
              level: 'FALSE',
              check: 'cited-green',
              detail: `claimed ${claim.passed}/${claim.total} but ${suite} says ${counts.passed} passed, ${counts.failed} failed, ${counts.total} total`,
            });
          }
        }
      }
    } else {
      for (const claim of claims.testCounts) {
        findings.push({
          level: 'UNVERIFIED',
          check: 'cited-green',
          detail: `"${claim.passed}/${claim.total}" claimed with no --suite to verify against (${claim.line})`,
        });
      }
    }
  }

  const falseCount = findings.filter((f) => f.level === 'FALSE').length;
  return { ok: falseCount === 0, findings, claims };
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'check') {
    console.log('Usage: hm-claim-preflight.js check --file <draft>|--text "..." [--suite <testfile>]');
    return 2;
  }
  let text = '';
  let suite = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--file') text = fs.readFileSync(args[i + 1], 'utf8');
    if (args[i] === '--text') text = String(args[i + 1] || '');
    if (args[i] === '--suite') suite = args[i + 1];
  }
  if (!text.trim()) {
    console.log('No draft text provided.');
    return 2;
  }
  const result = preflight(text, { suite });
  for (const finding of result.findings) {
    console.log(`[${finding.level}] ${finding.check}: ${finding.detail}`);
  }
  if (result.ok && result.findings.length === 0) console.log('PREFLIGHT CLEAN: all extracted claims verified.');
  else if (result.ok) console.log('PREFLIGHT PASS with warnings: verify greens before shipping them.');
  else console.log('PREFLIGHT FAIL: a claim in this draft is false. Fix the claim or fix the world.');
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { extractClaims, preflight, parseJestCounts };
