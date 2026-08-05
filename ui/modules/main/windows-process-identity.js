'use strict';

/**
 * PERSISTENT WINDOWS PROCESS-START IDENTITY, in one place.
 *
 * =====================================================================
 * WHY THIS IS AN EXTRACTION AND WHY IT HAD TO BECOME SHARED
 * =====================================================================
 * A PID is not an identity. Windows reuses them, and every "is that process
 * still alive?" check built on `process.kill(pid, 0)` answers a question nobody
 * asked: it says SOMETHING holds that number, not that the thing you care about
 * is still running. The distinction is invisible until the day a recycled PID
 * makes a dead owner look alive, or a live owner look retired.
 *
 * The tree already had exactly one production answer to this, inside
 * `codex-computer-use-standalone-controller.js`: query `Win32_Process`, bind
 * PID + `CreationDate` + `ExecutablePath` + a command-line digest, and REFUSE
 * when the creation identity is missing. That is the right rule. It was welded
 * to a daemon that owns a pid file, a script path and a pipe, so the v7 §4
 * Telegram legacy cutover fence — which has to prove the ORIGINAL legacy-capable
 * writer is retired, and can never accept "its PID is gone" as that proof —
 * could not reach it without dragging the daemon's policy along.
 *
 * So the query and the start-identity refusal live here; the daemon's policy
 * (which pid file, which script, which profile, which pipe) stays in the
 * controller. The controller keeps its exact existing reason strings through a
 * thin mapping, because this extraction is required to change NOTHING about its
 * behaviour, and its suites — not this comment — are what prove that.
 *
 * =====================================================================
 * ABSENT IS NOT THE SAME FACT AS UNVERIFIABLE
 * =====================================================================
 * Three outcomes, deliberately never collapsed to a boolean:
 *
 *   * the probe ran and found no such process   -> definitively absent;
 *   * the probe ran and found one               -> identity, compare it;
 *   * the probe could not run, or answered in a shape we do not understand
 *                                               -> UNVERIFIABLE.
 *
 * A caller proving retirement may act on the first and must HOLD on the third.
 * Folding them together is how "we could not check" becomes "it is gone".
 */

const { execFile } = require('node:child_process');

const { sha256 } = require('./canonical-json');

/** Neutral probe outcomes. Callers with their own vocabulary may remap them. */
const PROCESS_PROBE_REASONS = Object.freeze({
  PID_INVALID: 'process_pid_invalid',
  PROBE_FAILED: 'process_probe_failed',
  PROBE_INVALID: 'process_probe_invalid',
  FOUND: 'process_found',
  MISSING: 'process_missing',
});

/** Refusals from the identity layer above the raw probe. */
const PROCESS_IDENTITY_REASONS = Object.freeze({
  PLATFORM_UNSUPPORTED: 'process_identity_platform_unsupported',
  PID_INVALID: 'process_identity_pid_invalid',
  UNVERIFIABLE: 'process_identity_unverifiable',
  ABSENT: 'process_identity_absent',
  PID_MISMATCH: 'process_identity_pid_mismatch',
  START_IDENTITY_MISSING: 'process_identity_start_identity_missing',
});

const PROCESS_IDENTITY_SCHEMA = 'squidrun.windows_process_identity.v1';

function optionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

/**
 * The raw `Win32_Process` probe.
 *
 * `Select-Object` names the exact columns rather than serialising the whole CIM
 * instance: an identity built from whatever the object happened to carry would
 * change shape with the OS build, and this feeds a content-derived id.
 */
function queryWindowsProcess(pid, options = {}) {
  const reasons = options.reasons || PROCESS_PROBE_REASONS;
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return Promise.resolve({ ok: false, reason: reasons.PID_INVALID, process: null });
  }
  const runner = options.execFile || execFile;
  const script = [
    `$item = Get-CimInstance Win32_Process -Filter "ProcessId = ${numericPid}"`,
    'if ($null -eq $item) { Write-Output "null"; exit 0 }',
    '$item | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress',
  ].join('; ');
  return new Promise((resolve) => {
    runner(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            reason: reasons.PROBE_FAILED,
            error: error.message,
            stderr: String(stderr || ''),
            process: null,
          });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || 'null').trim() || 'null');
          resolve({
            ok: Boolean(parsed),
            reason: parsed ? reasons.FOUND : reasons.MISSING,
            process: parsed || null,
          });
        } catch (parseError) {
          resolve({
            ok: false,
            reason: reasons.PROBE_INVALID,
            error: parseError.message,
            process: null,
          });
        }
      }
    );
  });
}

/**
 * The persistent identity of one process, or a NAMED refusal.
 *
 * `absent: true` is set only when the probe itself succeeded and reported no
 * such process. Every other failure leaves it false, because a caller deciding
 * "the original writer is retired" may only act on the first.
 */
function readProcessStartIdentity(queried, pid, reasons = PROCESS_PROBE_REASONS) {
  const numericPid = Number(pid);
  if (!queried || typeof queried !== 'object') {
    return { ok: false, reason: PROCESS_IDENTITY_REASONS.UNVERIFIABLE, absent: false };
  }
  if (queried.ok !== true) {
    const absent = queried.reason === reasons.MISSING;
    return {
      ok: false,
      reason: absent ? PROCESS_IDENTITY_REASONS.ABSENT : PROCESS_IDENTITY_REASONS.UNVERIFIABLE,
      absent,
      probeReason: optionalString(queried.reason, null),
    };
  }

  const info = queried.process;
  if (!info || typeof info !== 'object') {
    return { ok: false, reason: PROCESS_IDENTITY_REASONS.UNVERIFIABLE, absent: false };
  }
  const reportedPid = Number(info.ProcessId ?? info.processId);
  if (!Number.isInteger(reportedPid) || reportedPid !== numericPid) {
    // A probe that answers about a different process is not a weaker answer, it
    // is an answer to a different question.
    return {
      ok: false,
      reason: PROCESS_IDENTITY_REASONS.PID_MISMATCH,
      absent: false,
      reportedPid: Number.isInteger(reportedPid) ? reportedPid : null,
    };
  }

  const creationDate = optionalString(info.CreationDate ?? info.creationDate, null);
  const executablePath = optionalString(info.ExecutablePath ?? info.executablePath, null);
  // A MISSING COMMAND LINE IS MISSING IDENTITY, NOT AN EMPTY ONE (Architect
  // #174). Hashing `''` produces a perfectly valid-looking digest that every
  // process without a readable command line would share, so an identity built
  // on it distinguishes nothing while reading as complete. Windows withholds
  // `CommandLine` for processes this token cannot open — that is exactly the
  // case where a caller must HOLD instead of binding.
  const commandLine = optionalString(info.CommandLine ?? info.commandLine, null);
  // MISSING CREATION IDENTITY IS A REFUSAL, NOT A NULL FIELD. Without it the
  // only thing left distinguishing this process from a PID-reused successor is
  // the number itself, which is exactly the identity this module exists to
  // refuse to rely on.
  if (!creationDate || !executablePath || !commandLine) {
    return {
      ok: false,
      reason: PROCESS_IDENTITY_REASONS.START_IDENTITY_MISSING,
      absent: false,
      creationDate,
      executablePath,
      commandLine: commandLine === null ? null : '[present]',
    };
  }

  return {
    ok: true,
    identity: Object.freeze({
      schema: PROCESS_IDENTITY_SCHEMA,
      pid: numericPid,
      creationDate,
      executablePath,
      // THE DIGEST, NOT THE LINE. Command lines carry tokens (paths, ids) that
      // have no business inside a content-derived fence id, and equality is the
      // only property any caller here needs.
      commandLineSha256: sha256(commandLine),
      name: optionalString(info.Name ?? info.name, null),
      parentProcessId: Number.isInteger(Number(info.ParentProcessId ?? info.parentProcessId))
        ? Number(info.ParentProcessId ?? info.parentProcessId)
        : null,
    }),
  };
}

/**
 * Probe `pid` and return its persistent start identity.
 *
 * Windows only, and stated as such rather than degraded: on another platform
 * this returns a refusal instead of a weaker identity, because a caller that
 * silently accepted one would be proving retirement from a PID again.
 */
async function probeProcessStartIdentity(pid, options = {}) {
  const platform = optionalString(options.platform, process.platform);
  if (platform !== 'win32') {
    return { ok: false, reason: PROCESS_IDENTITY_REASONS.PLATFORM_UNSUPPORTED, absent: false, platform };
  }
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { ok: false, reason: PROCESS_IDENTITY_REASONS.PID_INVALID, absent: false };
  }
  const query = options.queryProcess || queryWindowsProcess;
  let queried;
  try {
    queried = await query(numericPid, { platform, execFile: options.execFile });
  } catch (error) {
    // A THROWN PROBE IS UNVERIFIABLE, never absent. This is the branch where a
    // broken injection would otherwise read as "the process is gone".
    return {
      ok: false,
      reason: PROCESS_IDENTITY_REASONS.UNVERIFIABLE,
      absent: false,
      error: error?.message || String(error),
    };
  }
  return readProcessStartIdentity(queried, numericPid);
}

/**
 * Exact equality over the persistent fields. Missing fields never match.
 *
 * BOTH SIDES MUST CARRY THE SCHEMA (Architect #174). Without that check any
 * object shaped like an identity — a caller's literal, a row read back from
 * somewhere untrusted, a partially populated draft — compares as authoritative,
 * and "these two processes are the same" becomes a claim about property names.
 */
function processIdentitiesEqual(left, right) {
  if (!left || !right) return false;
  if (left.schema !== PROCESS_IDENTITY_SCHEMA || right.schema !== PROCESS_IDENTITY_SCHEMA) return false;
  const pid = Number(left.pid);
  if (!Number.isInteger(pid) || pid !== Number(right.pid)) return false;
  const fields = ['creationDate', 'executablePath', 'commandLineSha256'];
  return fields.every((field) => {
    const a = optionalString(left[field], null);
    const b = optionalString(right[field], null);
    return a !== null && a === b;
  });
}

module.exports = Object.freeze({
  PROCESS_PROBE_REASONS,
  PROCESS_IDENTITY_REASONS,
  PROCESS_IDENTITY_SCHEMA,
  queryWindowsProcess,
  readProcessStartIdentity,
  probeProcessStartIdentity,
  processIdentitiesEqual,
});
