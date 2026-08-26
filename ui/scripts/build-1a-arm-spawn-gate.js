'use strict';

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const UI_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(UI_ROOT, '..');
const JEST_PATH = path.join(UI_ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

const CORE_SUITES = [
  '__tests__/arm-liveness-probe.test.js',
  '__tests__/arm-liveness-daemon-integration.test.js',
  '__tests__/arm-spawn-journal.test.js',
  '__tests__/arm-spawn-transaction.test.js',
  '__tests__/addressed-terminal-spawn.test.js',
  '__tests__/daemon.test.js',
  '__tests__/terminal-daemon-addressed.test.js',
];

const APP_TEST_PATTERN = 'L0/L6|Build 1A|generation-kills';

const GATE_PATHS = [
  'ui/daemon-client.js',
  'ui/modules/addressed-terminal-spawn.js',
  'ui/modules/terminal-address-leases.js',
  'ui/modules/main/arm-liveness-probe.js',
  'ui/modules/main/arm-spawn-journal.js',
  'ui/modules/main/arm-spawn-transaction.js',
  'ui/modules/main/evidence-ledger-store.js',
  'ui/modules/main/squidrun-app.js',
  'ui/terminal-daemon.js',
  'ui/__tests__/addressed-terminal-spawn.test.js',
  'ui/__tests__/arm-liveness-daemon-integration.test.js',
  'ui/__tests__/arm-liveness-probe.test.js',
  'ui/__tests__/arm-spawn-journal.test.js',
  'ui/__tests__/arm-spawn-transaction.test.js',
  'ui/__tests__/daemon.test.js',
  'ui/__tests__/fixtures/arm-liveness-responder.js',
  'ui/__tests__/squidrun-app.test.js',
  'ui/__tests__/terminal-address-leases.test.js',
  'ui/__tests__/terminal-daemon-addressed.test.js',
  'ui/scripts/build-1a-arm-spawn-gate.js',
];

function usage() {
  console.log('Usage: node ui/scripts/build-1a-arm-spawn-gate.js --expect-commit <sha>');
}

function parseArgs(argv) {
  const options = { expectCommit: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--expect-commit') {
      options.expectCommit = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

function getHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  }).trim().toLowerCase();
}

function getScopedStatus() {
  return execFileSync('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...GATE_PATHS,
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function runJest(args) {
  const result = spawnSync(process.execPath, ['--no-warnings', JEST_PATH, ...args], {
    cwd: UI_ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

function runGate(expectedCommit) {
  if (!expectedCommit) throw new Error('--expect-commit is required');
  if (!/^[0-9a-f]{7,40}$/.test(expectedCommit)) {
    throw new Error('--expect-commit must be a 7-40 character hexadecimal commit id');
  }

  const head = getHead();
  if (!head.startsWith(expectedCommit) || (expectedCommit.length === 40 && head !== expectedCommit)) {
    throw new Error(`expect-commit failed: HEAD=${head} expected=${expectedCommit}`);
  }
  const scopedStatus = getScopedStatus();
  if (scopedStatus) {
    throw new Error(`expect-commit failed: Build 1A scope is dirty\n${scopedStatus}`);
  }
  console.log(`[BUILD 1A G0 PASS] HEAD matches ${head}`);

  const coreExit = runJest([
    '--runTestsByPath',
    ...CORE_SUITES,
    '--runInBand',
    '--detectOpenHandles',
  ]);
  if (coreExit !== 0) return coreExit;

  const appExit = runJest([
    '--runTestsByPath',
    '__tests__/squidrun-app.test.js',
    '--runInBand',
    '--detectOpenHandles',
    '--testNamePattern',
    APP_TEST_PATTERN,
  ]);
  if (appExit !== 0) return appExit;

  const finalHead = getHead();
  if (finalHead !== head) throw new Error(`HEAD changed during gate: before=${head} after=${finalHead}`);
  const finalScopedStatus = getScopedStatus();
  if (finalScopedStatus) throw new Error(`Build 1A scope changed during gate\n${finalScopedStatus}`);

  const receipts = [
    ['L0/L6', 'characterized ghost path remains impossible after refused spawn'],
    ['L1', 'own-pane ping produces generation-correlated routed journal proof'],
    ['L2', 'second live-lease spawn refuses without a second process'],
    ['L3', 'real two-client race yields one process and one refusal'],
    ['L4', 'external process death journals release and permits reclaim'],
    ['L5', 'daemon reconnect preserves address history and chains a new lease'],
    ['L7', 'spawn receipts name owner and named recovery event'],
    ['L8', 'throwaway TEST COPY profile tears down its daemon, PTYs, broker, and data root'],
  ];
  for (const [criterion, evidence] of receipts) {
    console.log(`[BUILD 1A SELF-CHECK ${criterion} PASS] ${evidence}`);
  }
  return 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  process.exitCode = runGate(options.expectCommit);
}

try {
  main();
} catch (error) {
  console.error(`[BUILD 1A GATE FAIL] ${error.message}`);
  process.exitCode = 1;
}
