const { execFile } = require('child_process');
const os = require('os');

const { extractClaudeSessionIdFromCommand } = require('./cli-resume-invocation');

function normalizeSessionId(value) {
  const id = String(value || '').trim();
  return id || null;
}

function normalizeProcessRows(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function powershellQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

async function findWindowsClaudeSessionProcesses(sessionId, options = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id) return [];
  const shell = options.powershellPath || 'powershell.exe';
  const script = [
    `$sid = ${powershellQuote(id)}`,
    '$self = $PID',
    'Get-CimInstance Win32_Process | Where-Object {',
    '  $cmd = $_.CommandLine',
    '  $_.ProcessId -ne $self -and $cmd -and $cmd.ToLower().Contains("claude") -and (',
    '    $cmd.Contains("--session-id " + $sid) -or',
    '    $cmd.Contains("--session-id=" + $sid) -or',
    '    $cmd.Contains("--resume " + $sid) -or',
    '    $cmd.Contains("--resume=" + $sid)',
    '  )',
    '} | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
  ].join('\n');
  try {
    const { stdout } = await execFilePromise(shell, [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], { windowsHide: true, timeout: options.timeoutMs || 5000 });
    const text = String(stdout || '').trim();
    if (!text) return [];
    return normalizeProcessRows(JSON.parse(text)).map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      name: row.Name || null,
      commandLine: row.CommandLine || '',
    })).filter((row) => Number.isFinite(row.pid) && row.pid > 0);
  } catch (err) {
    if (typeof options.onError === 'function') options.onError(err);
    return [];
  }
}

async function findUnixClaudeSessionProcesses(sessionId, options = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id) return [];
  try {
    const { stdout } = await execFilePromise('ps', ['-eo', 'pid=,ppid=,comm=,args='], {
      timeout: options.timeoutMs || 5000,
    });
    return String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          name: match[3],
          commandLine: match[4] || '',
        };
      })
      .filter(Boolean)
      .filter((row) => {
        if (!Number.isFinite(row.pid) || row.pid <= 0 || row.pid === process.pid) return false;
        const cmd = String(row.commandLine || '');
        return /claude/i.test(cmd)
          && (
            cmd.includes(`--session-id ${id}`)
            || cmd.includes(`--session-id=${id}`)
            || cmd.includes(`--resume ${id}`)
            || cmd.includes(`--resume=${id}`)
          );
      });
  } catch (err) {
    if (typeof options.onError === 'function') options.onError(err);
    return [];
  }
}

function findClaudeSessionProcesses(sessionId, options = {}) {
  if (typeof options.findProcesses === 'function') {
    return Promise.resolve(options.findProcesses(sessionId));
  }
  return os.platform() === 'win32'
    ? findWindowsClaudeSessionProcesses(sessionId, options)
    : findUnixClaudeSessionProcesses(sessionId, options);
}

async function killWindowsProcessTree(pid, options = {}) {
  await execFilePromise(options.taskkillPath || 'taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: options.timeoutMs || 5000,
  });
  return { pid, signal: 'taskkill_tree' };
}

async function killUnixProcessTree(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
    return { pid, signal: 'SIGTERM_PROCESS_GROUP' };
  } catch (_) {
    process.kill(pid, 'SIGTERM');
    return { pid, signal: 'SIGTERM' };
  }
}

function killProcessTree(pid, options = {}) {
  if (typeof options.killProcessTree === 'function') {
    return Promise.resolve(options.killProcessTree(pid));
  }
  return os.platform() === 'win32'
    ? killWindowsProcessTree(pid, options)
    : killUnixProcessTree(pid);
}

async function reapClaudeSessionProcesses(sessionId, options = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id) {
    return { ok: false, reason: 'missing_session_id', sessionId: null, matched: [], killed: [] };
  }
  const rows = normalizeProcessRows(await findClaudeSessionProcesses(id, options))
    .filter((row) => {
      const pid = Number(row?.pid ?? row?.ProcessId);
      return Number.isFinite(pid) && pid > 0 && pid !== process.pid;
    })
    .map((row) => ({
      pid: Number(row.pid ?? row.ProcessId),
      ppid: row.ppid ?? row.ParentProcessId ?? null,
      name: row.name ?? row.Name ?? null,
      commandLine: row.commandLine ?? row.CommandLine ?? '',
    }));

  const killed = [];
  const failed = [];
  for (const row of rows) {
    try {
      const result = await killProcessTree(row.pid, options);
      killed.push({ ...row, ...(result && typeof result === 'object' ? result : {}) });
    } catch (err) {
      failed.push({ ...row, error: err?.message || String(err) });
    }
  }

  return {
    ok: failed.length === 0,
    sessionId: id,
    matched: rows,
    killed,
    failed,
  };
}

async function reapClaudeSessionForCommand(command, options = {}) {
  const sessionId = extractClaudeSessionIdFromCommand(command);
  if (!sessionId) {
    return { ok: true, skipped: true, reason: 'command_not_pinned', sessionId: null };
  }
  return reapClaudeSessionProcesses(sessionId, options);
}

module.exports = {
  extractClaudeSessionIdFromCommand,
  findClaudeSessionProcesses,
  findWindowsClaudeSessionProcesses,
  findUnixClaudeSessionProcesses,
  reapClaudeSessionProcesses,
  reapClaudeSessionForCommand,
  _internals: {
    normalizeProcessRows,
    powershellQuote,
  },
};
