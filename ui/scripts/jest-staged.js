#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function toLines(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isUiJavaScriptFile(filePath = '') {
  return /^ui\/.+\.js$/i.test(String(filePath || '').trim());
}

function isUiTestFile(filePath = '') {
  return /^ui\/.+\.test\.js$/i.test(String(filePath || '').trim());
}

function toUiRelativePath(filePath = '') {
  return String(filePath || '').replace(/^ui\//i, '');
}

function extractAddedTestNames(diffText = '') {
  const names = [];
  const regex = /^\+\s*(?:test|it)\(\s*['"`]([^'"`]+)['"`]/gm;
  let match = null;
  while ((match = regex.exec(String(diffText || ''))) !== null) {
    const name = String(match[1] || '').trim();
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function escapeRegex(text = '') {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildJestPlan(stagedFiles = [], diffProvider = () => '') {
  const normalizedFiles = Array.from(new Set(
    (Array.isArray(stagedFiles) ? stagedFiles : [])
      .map((filePath) => String(filePath || '').trim())
      .filter(Boolean)
  ));
  const stagedUiJsFiles = normalizedFiles.filter(isUiJavaScriptFile);
  const stagedTestFiles = stagedUiJsFiles.filter(isUiTestFile);

  const targetedRuns = stagedTestFiles.map((testFile) => {
    const testNames = extractAddedTestNames(diffProvider(testFile));
    return {
      type: 'test-file',
      file: testFile,
      uiPath: toUiRelativePath(testFile),
      testNames,
    };
  });

  const shouldUseRelatedTests = stagedTestFiles.length === 0;
  const relatedFiles = shouldUseRelatedTests
    ? stagedUiJsFiles
      .filter((filePath) => !isUiTestFile(filePath))
      .map(toUiRelativePath)
    : [];

  return {
    stagedUiJsFiles,
    stagedTestFiles,
    targetedRuns,
    // ONE RUN FOR EVERY STAGED TEST FILE, IN ONE JEST PROCESS.
    //
    // The per-file loop below used to spawn one Jest per staged test file, each
    // narrowed by a --testNamePattern built from that file's newly ADDED test
    // names. Two things were wrong with it.
    //
    // First, it was not deterministic in the way a gate has to be: with seven
    // staged test files, six ran and printed and the seventh exited non-zero
    // with NO output at all, while the byte-identical command succeeded when
    // run on its own. A gate that fails silently on its last item is worse than
    // no gate, because the failure looks like the work rather than like the
    // tool.
    //
    // Second, the narrowing quietly WEAKENED coverage. A modified test file
    // yields zero extracted names and therefore ran in full, while a file whose
    // names were extracted ran only those - so adding a test to a file could
    // run less of it than touching a comment in the same file would.
    //
    // One process, every staged test path, no name filter: strictly more
    // coverage than before and nothing left to be non-deterministic about.
    // `targetedRuns` is retained because it carries the extracted names, which
    // the tests assert on and which stay useful for reporting.
    testPaths: stagedTestFiles.map(toUiRelativePath),
    relatedFiles,
    hasWork: targetedRuns.length > 0 || relatedFiles.length > 0,
  };
}

function runGit(repoRoot, args = []) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runJest(uiRoot, args = []) {
  const jestBin = path.join(uiRoot, 'node_modules', 'jest', 'bin', 'jest.js');
  return spawnSync(process.execPath, [jestBin, '--runInBand', '--passWithNoTests', '--silent', ...args], {
    cwd: uiRoot,
    stdio: 'inherit',
    shell: false,
  });
}

function buildTargetedJestArgs(run = {}) {
  const args = ['--runTestsByPath', run.uiPath];
  if (Array.isArray(run.testNames) && run.testNames.length > 0) {
    args.push(`--testNamePattern=${run.testNames.map(escapeRegex).join('|')}`);
  }
  return args;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const uiRoot = path.join(repoRoot, 'ui');
  const stagedFiles = toLines(runGit(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
  const plan = buildJestPlan(stagedFiles, (filePath) => (
    runGit(repoRoot, ['diff', '--cached', '-U0', '--', filePath])
  ));

  if (!plan.hasWork) {
    process.stdout.write('No staged UI JavaScript test targets. Skipping Jest.\n');
    return;
  }

  if (plan.testPaths.length > 0) {
    const result = runJest(uiRoot, ['--runTestsByPath', ...plan.testPaths]);
    exitOnFailure(result, `staged test files: ${plan.testPaths.join(', ')}`);
  }

  if (plan.relatedFiles.length > 0) {
    const result = runJest(uiRoot, ['--findRelatedTests', ...plan.relatedFiles]);
    exitOnFailure(result, `related tests for: ${plan.relatedFiles.join(', ')}`);
  }
}

/**
 * A FAILING GATE MUST SAY WHY IT FAILED.
 *
 * `process.exit(result.status || 1)` threw away everything spawnSync knows. A
 * spawn that never started returns status null with an `error`, and a process
 * killed by a signal returns status null with a `signal` - both became a bare
 * exit 1 with no output, which is exactly how a tool defect gets mistaken for a
 * broken change. There is deliberately no retry here: re-running a failure is
 * how a flaky gate becomes a green one.
 */
function exitOnFailure(result, what) {
  if (result && result.status === 0) return;
  const status = result ? result.status : null;
  const signal = result ? result.signal : null;
  const error = result && result.error ? (result.error.message || String(result.error)) : null;
  process.stderr.write(`Jest gate failed for ${what}\n`);
  process.stderr.write(`  status=${status === null || status === undefined ? 'null' : status}\n`);
  if (signal) process.stderr.write(`  signal=${signal}\n`);
  if (error) process.stderr.write(`  spawnError=${error}\n`);
  if (status === null || status === undefined) {
    process.stderr.write('  (a null status means the Jest process never produced an exit code)\n');
  }
  process.exit(typeof status === 'number' && status !== 0 ? status : 1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  extractAddedTestNames,
  buildJestPlan,
  buildTargetedJestArgs,
  exitOnFailure,
  _internals: {
    escapeRegex,
    isUiJavaScriptFile,
    isUiTestFile,
    toUiRelativePath,
  },
};
