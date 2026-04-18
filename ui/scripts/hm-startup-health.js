#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const envPath = path.join(projectRoot, '.env');
const settingsPath = path.join(projectRoot, 'ui', 'settings.json');
const supervisorStatusPath = path.join(projectRoot, '.squidrun', 'runtime', 'supervisor-status.json');
const supervisorPidPath = path.join(projectRoot, '.squidrun', 'runtime', 'supervisor.pid');
const supervisorScriptPath = path.join(projectRoot, 'ui', 'supervisor-daemon.js');

const REQUIRED_LANES = [
  'SQUIDRUN_ORACLE_WATCH',
  'SQUIDRUN_MARKET_SCANNER_AUTOMATION',
  'SQUIDRUN_CRYPTO_TRADING_AUTOMATION',
  'SQUIDRUN_PAPER_TRADING_AUTOMATION',
];

function readEnv() {
  if (!fs.existsSync(envPath)) return {};
  const text = fs.readFileSync(envPath, 'utf8');
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function flipEnvVar(key, newValue) {
  const text = fs.readFileSync(envPath, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (!re.test(text)) {
    fs.appendFileSync(envPath, `\n${key}=${newValue}\n`, 'utf8');
    return 'appended';
  }
  fs.writeFileSync(envPath, text.replace(re, `${key}=${newValue}`), 'utf8');
  return 'updated';
}

function readSettings() {
  if (!fs.existsSync(settingsPath)) return null;
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return null; }
}

function flipSetting(key, value) {
  const settings = readSettings();
  if (!settings) return 'no_settings_file';
  settings[key] = value;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return 'updated';
}

function readSupervisorStatus() {
  if (!fs.existsSync(supervisorStatusPath)) return null;
  try { return JSON.parse(fs.readFileSync(supervisorStatusPath, 'utf8')); } catch { return null; }
}

function readSupervisorPid() {
  if (!fs.existsSync(supervisorPidPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(supervisorPidPath, 'utf8'));
    return Number(data.pid) || null;
  } catch { return null; }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killPid(pid) {
  if (process.platform === 'win32') {
    spawnSync('cmd.exe', ['/c', `taskkill /F /PID ${pid}`], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

function spawnSupervisor() {
  const child = spawn('node', [supervisorScriptPath, '--daemon'], {
    cwd: projectRoot,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  if (child && typeof child.unref === 'function') child.unref();
  return child?.pid || null;
}

function getDefiStatus() {
  const result = spawnSync('node', [path.join(projectRoot, 'ui', 'scripts', 'hm-defi-status.js')], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.status !== 0) return { ok: false, error: result.stderr || 'defi-status failed' };
  const acct = result.stdout.match(/Account value:\s*([\d.]+)/);
  const positions = [];
  const posRe = /^\s+(\w+):\s*size=(-?[\d.]+),\s*entry=([\d.]+),\s*unrealizedPnl=(-?[\d.]+)/gm;
  let match;
  while ((match = posRe.exec(result.stdout))) {
    positions.push({
      asset: match[1],
      size: Number(match[2]),
      entry: Number(match[3]),
      unrealizedPnl: Number(match[4]),
    });
  }
  return { ok: true, accountValue: acct ? Number(acct[1]) : null, positions };
}

function run({ autoFix = true } = {}) {
  const report = { ts: new Date().toISOString(), autoFix, fixes: [], warnings: [], blockers: [] };

  const env = readEnv();
  for (const lane of REQUIRED_LANES) {
    const value = env[lane];
    if (value !== '1') {
      if (autoFix) {
        flipEnvVar(lane, '1');
        report.fixes.push({ kind: 'env', key: lane, was: value || 'unset', now: '1' });
      } else {
        report.warnings.push({ kind: 'env', key: lane, value: value || 'unset', need: '1' });
      }
    }
  }

  const settings = readSettings();
  if (settings && settings.watcherEnabled === false) {
    if (autoFix) {
      flipSetting('watcherEnabled', true);
      report.fixes.push({ kind: 'settings', key: 'watcherEnabled', was: false, now: true });
    } else {
      report.warnings.push({ kind: 'settings', key: 'watcherEnabled', value: false, need: true });
    }
  }

  const status = readSupervisorStatus();
  const pid = readSupervisorPid();
  const alive = isPidAlive(pid);
  const lanesNeedReboot = report.fixes.some((f) => f.kind === 'env' || f.kind === 'settings');

  if (!alive) {
    report.warnings.push({ kind: 'supervisor', issue: 'pid_dead', pid });
    if (autoFix) {
      const newPid = spawnSupervisor();
      report.fixes.push({ kind: 'supervisor', action: 'spawned', pid: newPid });
    }
  } else if (lanesNeedReboot) {
    if (autoFix) {
      killPid(pid);
      const start = Date.now();
      while (isPidAlive(pid) && Date.now() - start < 4000) {
        spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'sleep', process.platform === 'win32' ? ['/c', 'timeout', '/t', '1', '/nobreak'] : ['1'], { stdio: 'ignore' });
      }
      const newPid = spawnSupervisor();
      report.fixes.push({ kind: 'supervisor', action: 'restarted', oldPid: pid, newPid });
    } else {
      report.warnings.push({ kind: 'supervisor', issue: 'env_changed_needs_restart', pid });
    }
  }

  const defi = getDefiStatus();
  if (!defi.ok) {
    report.blockers.push({ kind: 'defi', issue: defi.error });
  } else {
    report.defi = { accountValue: defi.accountValue, positionCount: defi.positions.length, positions: defi.positions };
  }

  if (status) {
    const lanesOff = [];
    for (const k of ['oracleWatch', 'cryptoTradingAutomation', 'marketScannerAutomation', 'paperTradingAutomation']) {
      if (status[k] && status[k].enabled === false) lanesOff.push(k);
    }
    if (lanesOff.length > 0) {
      report.warnings.push({ kind: 'lanes_still_disabled_in_status', lanes: lanesOff, note: 'may need supervisor restart to pick up env/settings' });
    }
  }

  const handoffPath = path.join(projectRoot, '.squidrun', 'handoffs', 'session.md');
  if (fs.existsSync(handoffPath)) {
    const ageMs = Date.now() - fs.statSync(handoffPath).mtimeMs;
    if (ageMs > 60 * 60 * 1000) {
      report.warnings.push({ kind: 'stale_handoff', path: '.squidrun/handoffs/session.md', ageMinutes: Math.round(ageMs / 60000), note: 'handoff is older than 1h — fresh agent context may be misleading' });
    }
  }

  const cruft = scanCruft();
  if (cruft.totalBytes > 1024 * 1024) {
    if (autoFix && cruft.deletable.length > 0) {
      let bytesFreed = 0;
      for (const p of cruft.deletable) {
        try { bytesFreed += fs.statSync(p).size; fs.unlinkSync(p); } catch {}
      }
      report.fixes.push({ kind: 'cruft', deleted: cruft.deletable.length, bytesFreed });
    } else {
      report.warnings.push({ kind: 'cruft', files: cruft.deletable.length, totalBytes: cruft.totalBytes });
    }
  }

  return report;
}

function scanCruft() {
  const candidates = [];
  const runtimeDir = path.join(projectRoot, '.squidrun', 'runtime');
  const workspaceDir = path.join(projectRoot, 'workspace');
  if (fs.existsSync(runtimeDir)) {
    for (const entry of fs.readdirSync(runtimeDir)) {
      if (/^_tmp\d*-supervisor/.test(entry) || entry === '_arch_comms.json' || entry === '_stash_diff.patch') {
        candidates.push(path.join(runtimeDir, entry));
      }
    }
  }
  if (fs.existsSync(workspaceDir)) {
    for (const entry of fs.readdirSync(workspaceDir)) {
      if (/^tmp-session(?:e3|\d+)-/.test(entry)) {
        candidates.push(path.join(workspaceDir, entry));
      }
    }
  }
  let totalBytes = 0;
  const deletable = [];
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > 1) {
        totalBytes += stat.size;
        deletable.push(p);
      }
    } catch {}
  }
  return { totalBytes, deletable };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const autoFix = !args.includes('--report-only');
  const json = args.includes('--json');
  const report = run({ autoFix });
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(`[startup-health] ts=${report.ts} autoFix=${report.autoFix}\n`);
    if (report.defi) {
      process.stdout.write(`[startup-health] defi: equity=$${report.defi.accountValue} positions=${report.defi.positionCount}\n`);
      for (const p of report.defi.positions) {
        process.stdout.write(`[startup-health]   ${p.asset} size=${p.size} entry=${p.entry} pnl=$${p.unrealizedPnl.toFixed(2)}\n`);
      }
    }
    if (report.fixes.length) process.stdout.write(`[startup-health] fixes: ${JSON.stringify(report.fixes)}\n`);
    if (report.warnings.length) process.stdout.write(`[startup-health] warnings: ${JSON.stringify(report.warnings)}\n`);
    if (report.blockers.length) process.stdout.write(`[startup-health] BLOCKERS: ${JSON.stringify(report.blockers)}\n`);
    if (!report.fixes.length && !report.warnings.length && !report.blockers.length) {
      process.stdout.write(`[startup-health] all systems nominal\n`);
    }
  }
}

module.exports = { run };
