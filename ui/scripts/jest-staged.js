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
  return /^ui\/(?:.*\/)?__tests__\/.+\.test\.js$/i.test(String(filePath || '').trim());
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

  for (const run of plan.targetedRuns) {
    const args = ['--runTestsByPath', run.uiPath];
    if (Array.isArray(run.testNames) && run.testNames.length > 0) {
      args.push('--testNamePattern', run.testNames.map(escapeRegex).join('|'));
    }
    const result = runJest(uiRoot, args);
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }

  if (plan.relatedFiles.length > 0) {
    const result = runJest(uiRoot, ['--findRelatedTests', ...plan.relatedFiles]);
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }
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
  _internals: {
    escapeRegex,
    isUiJavaScriptFile,
    isUiTestFile,
    toUiRelativePath,
  },
};
