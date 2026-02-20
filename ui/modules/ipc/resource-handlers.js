/**
 * Resource usage IPC handlers
 * Channels: resource:get-usage
 */

const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const log = require('../logger');

const MAX_BUFFER = 1024 * 1024;
const DEFAULT_USAGE_CACHE_TTL_MS = 7000;

let lastSystemSample = null; // { idle, total }
const lastProcessSample = new Map(); // pid -> { cpuSec, timestamp }

function getSystemCpuUsage() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }

  if (!lastSystemSample) {
    lastSystemSample = { idle, total };
    return null;
  }

  const idleDiff = idle - lastSystemSample.idle;
  const totalDiff = total - lastSystemSample.total;
  lastSystemSample = { idle, total };

  if (totalDiff <= 0) return null;
  const usage = (1 - idleDiff / totalDiff) * 100;
  return Math.max(0, Math.min(100, Math.round(usage * 10) / 10));
}

function bytesToMB(bytes) {
  if (!bytes || !Number.isFinite(bytes)) return null;
  return Math.round(bytes / 1024 / 1024);
}

function getDriveLetter(workspacePath) {
  const normalized = String(workspacePath || '').trim();
  const windowsDriveMatch = normalized.match(/^([a-zA-Z]):(?:[\\/]|$)/);
  if (windowsDriveMatch) {
    return windowsDriveMatch[1].toUpperCase();
  }
  const root = path.parse(normalized).root || '';
  const letter = root.replace(/[:\\\/]/g, '');
  return letter || 'C';
}

function execFileAsync(file, args = []) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

function normalizePidList(pids) {
  const normalized = [];
  for (const pid of pids) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) continue;
    normalized.push(numericPid);
  }
  return Array.from(new Set(normalized));
}

async function getDiskUsage(workspacePath) {
  try {
    if (process.platform === 'win32') {
      const rawDrive = getDriveLetter(workspacePath);
      const drive = /^[A-Z]$/.test(rawDrive) ? rawDrive : 'C';
      const psScript = `Get-PSDrive -Name '${drive}' | Select-Object Used,Free,Name | ConvertTo-Json -Compress`;
      const output = await execFileAsync('powershell', ['-NoProfile', '-Command', psScript]);
      if (!output) return null;
      const data = JSON.parse(output);
      const used = Number(data.Used) || 0;
      const free = Number(data.Free) || 0;
      const total = used + free;
      const usedPct = total > 0 ? Math.round((used / total) * 100) : null;
      return {
        drive: data.Name,
        totalGB: total ? Math.round(total / 1024 / 1024 / 1024) : null,
        freeGB: free ? Math.round(free / 1024 / 1024 / 1024) : null,
        usedPercent: usedPct
      };
    }

    const output = await execFileAsync('df', ['-kP', String(workspacePath || '')]);
    const lines = output.split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return null;
    const parts = last.replace(/\s+/g, ' ').split(' ');
    const totalKB = Number(parts[1]);
    const usedKB = Number(parts[2]);
    const availKB = Number(parts[3]);
    return {
      drive: parts[0],
      totalGB: totalKB ? Math.round(totalKB / 1024 / 1024) : null,
      freeGB: availKB ? Math.round(availKB / 1024 / 1024) : null,
      usedPercent: totalKB ? Math.round((usedKB / totalKB) * 100) : null
    };
  } catch (err) {
    log.warn('Resources', 'Disk usage lookup failed', err.message);
    return null;
  }
}

async function getProcessStats(pids) {
  const stats = {};
  const safePids = normalizePidList(pids);
  if (!safePids.length) return stats;

  if (process.platform === 'win32') {
    const ids = safePids.join(',');
    const psScript = `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Select-Object Id, CPU, WorkingSet64 | ConvertTo-Json -Compress`;
    const output = await execFileAsync('powershell', ['-NoProfile', '-Command', psScript]).catch((err) => {
      log.warn('Resources', 'Process usage lookup failed', err.message);
      return '';
    });
    if (!output) return stats;

    let data = [];
    try {
      data = JSON.parse(output);
    } catch {
      return stats;
    }
    if (!Array.isArray(data)) data = [data];

    const now = Date.now();
    for (const item of data) {
      const pid = Number(item.Id);
      if (!pid) continue;
      const cpuSec = Number(item.CPU) || 0;
      const memMB = bytesToMB(Number(item.WorkingSet64));
      const prev = lastProcessSample.get(pid);
      let cpuPercent = null;
      if (prev) {
        const deltaCpu = cpuSec - prev.cpuSec;
        const deltaTime = (now - prev.timestamp) / 1000;
        if (deltaTime > 0) {
          cpuPercent = Math.max(0, Math.round(((deltaCpu / deltaTime) / os.cpus().length) * 1000) / 10);
        }
      }
      lastProcessSample.set(pid, { cpuSec, timestamp: now });
      stats[pid] = { cpuPercent, memMB };
    }
    return stats;
  }

  const output = await execFileAsync('ps', ['-p', safePids.join(','), '-o', 'pid=,pcpu=,rss=']).catch(() => '');
  if (!output) return stats;

  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const cpuPercent = Number(parts[1]);
    const rssKB = Number(parts[2]);
    stats[pid] = {
      cpuPercent: Number.isFinite(cpuPercent) ? Math.round(cpuPercent * 10) / 10 : null,
      memMB: rssKB ? Math.round(rssKB / 1024) : null
    };
  }

  return stats;
}

function registerResourceHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain || !WORKSPACE_PATH) return;
  const usageCacheTtlMs = Number.isFinite(ctx.resourceUsageCacheTtlMs)
    ? Math.max(0, ctx.resourceUsageCacheTtlMs)
    : DEFAULT_USAGE_CACHE_TTL_MS;
  let cachedUsage = null; // { value, timestamp }
  let inFlightUsage = null;

  ipcMain.handle('resource:get-usage', async () => {
    const now = Date.now();
    if (cachedUsage && (now - cachedUsage.timestamp) < usageCacheTtlMs) {
      return cachedUsage.value;
    }

    if (inFlightUsage) {
      return inFlightUsage;
    }

    inFlightUsage = (async () => {
      try {
        const terminals = ctx.daemonClient ? ctx.daemonClient.getTerminals() : [];
        const pids = terminals.map(t => t.pid).filter(pid => pid && pid > 0);
        const procStats = await getProcessStats(pids);

        const agents = {};
        for (const terminal of terminals) {
          const pid = terminal.pid;
          agents[String(terminal.paneId)] = {
            pid,
            alive: terminal.alive,
            mode: terminal.mode || 'pty',
            cpuPercent: procStats[pid]?.cpuPercent ?? null,
            memMB: procStats[pid]?.memMB ?? null
          };
        }

        const systemCpu = getSystemCpuUsage();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPercent = totalMem ? Math.round((usedMem / totalMem) * 100) : null;
        const disk = await getDiskUsage(WORKSPACE_PATH);

        const result = {
          success: true,
          system: {
            cpuPercent: systemCpu,
            memUsedMB: bytesToMB(usedMem),
            memTotalMB: bytesToMB(totalMem),
            memPercent,
            disk
          },
          agents
        };
        cachedUsage = {
          value: result,
          timestamp: Date.now(),
        };
        return result;
      } catch (err) {
        log.error('Resources', 'Failed to get usage', err.message);
        return { success: false, error: err.message };
      } finally {
        inFlightUsage = null;
      }
    })();

    return inFlightUsage;
  });
}


function unregisterResourceHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('resource:get-usage');
}

registerResourceHandlers.unregister = unregisterResourceHandlers;
module.exports = { registerResourceHandlers };
