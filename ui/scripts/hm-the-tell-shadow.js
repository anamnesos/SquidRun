#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  DEFAULT_INTERVAL_MS,
  DEFAULT_LEDGER_PATH,
  DEFAULT_PID_PATH,
  DEFAULT_STATUS_PATH,
  isPidAlive,
  normalizeIntervalMs,
  readStatus,
  readShadowLedger,
  runShadowLoop,
  runShadowTick,
} = require('../modules/main/the-tell-shadow-runner');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/hm-the-tell-shadow.js once [--ledger <path>] [--status <path>]',
    '  node scripts/hm-the-tell-shadow.js start [--interval-ms <n>] [--no-immediate] [--ledger <path>] [--status <path>] [--pid <path>]',
    '  node scripts/hm-the-tell-shadow.js daemon [--interval-ms <n>] [--no-immediate] [--ledger <path>] [--status <path>] [--pid <path>]',
    '  node scripts/hm-the-tell-shadow.js status [--status <path>] [--pid <path>]',
    '  node scripts/hm-the-tell-shadow.js stop [--pid <path>]',
    '  node scripts/hm-the-tell-shadow.js tail [--ledger <path>] [--last <n>]',
  ].join('\n'));
}

function flagPath(flags, key, fallback) {
  return flags[key] ? path.resolve(String(flags[key])) : fallback;
}

function commonOptions(flags) {
  return {
    ledgerPath: flagPath(flags, 'ledger', DEFAULT_LEDGER_PATH),
    statusPath: flagPath(flags, 'status', DEFAULT_STATUS_PATH),
    pidPath: flagPath(flags, 'pid', DEFAULT_PID_PATH),
    intervalMs: normalizeIntervalMs(flags['interval-ms'] || DEFAULT_INTERVAL_MS),
    immediate: flags['no-immediate'] !== true,
  };
}

function readPid(pidPath) {
  try {
    return fs.readFileSync(pidPath, 'utf8').trim();
  } catch {
    return '';
  }
}

function startDetached(flags) {
  const options = commonOptions(flags);
  const existingPid = readPid(options.pidPath);
  if (isPidAlive(existingPid)) {
    return {
      ok: true,
      alreadyRunning: true,
      pid: Number(existingPid),
      pidPath: options.pidPath,
      ledgerPath: options.ledgerPath,
      statusPath: options.statusPath,
    };
  }

  const args = [
    __filename,
    'daemon',
    '--interval-ms', String(options.intervalMs),
    '--ledger', options.ledgerPath,
    '--status', options.statusPath,
    '--pid', options.pidPath,
  ];
  if (flags['no-immediate'] === true) args.push('--no-immediate');
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(__dirname, '..'),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  fs.mkdirSync(path.dirname(options.pidPath), { recursive: true });
  fs.writeFileSync(options.pidPath, String(child.pid), 'utf8');
  return {
    ok: true,
    started: true,
    pid: child.pid,
    pidPath: options.pidPath,
    ledgerPath: options.ledgerPath,
    statusPath: options.statusPath,
    intervalMs: options.intervalMs,
    immediate: flags['no-immediate'] !== true,
  };
}

function stopRunner(flags) {
  const pidPath = flagPath(flags, 'pid', DEFAULT_PID_PATH);
  const pid = readPid(pidPath);
  if (!pid) return { ok: true, stopped: false, reason: 'missing_pid', pidPath };
  if (!isPidAlive(pid)) {
    try { fs.unlinkSync(pidPath); } catch {}
    return { ok: true, stopped: false, reason: 'not_running', pid: Number(pid), pidPath };
  }
  process.kill(Number(pid), 'SIGTERM');
  return { ok: true, stopped: true, pid: Number(pid), pidPath };
}

function tailLedger(flags) {
  const ledgerPath = flagPath(flags, 'ledger', DEFAULT_LEDGER_PATH);
  const last = Math.max(1, Math.min(200, Number.parseInt(String(flags.last || '20'), 10) || 20));
  try {
    const ledger = readShadowLedger(ledgerPath);
    return {
      ok: true,
      ledgerPath,
      shadowStartedAtMs: ledger.shadowStartedAtMs,
      rows: ledger.rows.slice(-last),
    };
  } catch (error) {
    return { ok: false, ledgerPath, reason: error.code === 'ENOENT' ? 'missing_ledger' : error.message };
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || flags.help) {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command === 'once') {
    const result = await runShadowTick(commonOptions(flags));
    console.log(JSON.stringify({
      ok: result.ok,
      runId: result.runId,
      tickId: result.tickId,
      ledgerPath: result.ledgerPath,
      rowCount: result.rows.length,
      rows: result.rows,
    }, null, 2));
    return;
  }
  if (command === 'daemon') {
    await runShadowLoop(commonOptions(flags));
    return;
  }
  if (command === 'start') {
    console.log(JSON.stringify(startDetached(flags), null, 2));
    return;
  }
  if (command === 'status') {
    const pidPath = flagPath(flags, 'pid', DEFAULT_PID_PATH);
    const pid = readPid(pidPath);
    console.log(JSON.stringify({
      ...readStatus(flagPath(flags, 'status', DEFAULT_STATUS_PATH)),
      pid: pid ? Number(pid) : null,
      pidAlive: isPidAlive(pid),
      pidPath,
    }, null, 2));
    return;
  }
  if (command === 'stop') {
    console.log(JSON.stringify(stopRunner(flags), null, 2));
    return;
  }
  if (command === 'tail') {
    console.log(JSON.stringify(tailLedger(flags), null, 2));
    return;
  }

  throw new Error(`unknown_command:${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
