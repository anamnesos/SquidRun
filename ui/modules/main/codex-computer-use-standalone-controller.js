'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { DaemonClient } = require('../../daemon-client');
const { PIPE_PATH } = require('../../config');
const {
  buildArmDurableAddress,
  validateSpawnResult,
} = require('./arm-spawn-transaction');
const {
  buildOfficialListWindowsVerification,
  browserPipeSnapshotTransitionAllowed,
  confirmCodexComputerUsePipeGeneration,
  defaultListBrowserPipes,
  prepareCodexComputerUseNativeBridge,
  resolveOfficialComputerUseClientPath,
} = require('./codex-computer-use-native-bridge');
const {
  DEFAULT_PROOF_TIMEOUT_MS,
  armCodexComputerUseProofClaim,
  buildCodexComputerUseProofInvocation,
  canonicalJson,
  sha256,
  sha256File,
  verifyCodexComputerUseProofJournal,
} = require('./codex-computer-use-proof');

const STANDALONE_CONTROLLER_SCHEMA =
  'squidrun.codex_computer_use_standalone_controller.v1';
const EXACT_ORACLE_COMMAND = 'codex --yolo';
const VERIFIER_ROLE = 'Oracle';
const VERIFIER_PANE_PREFIX = 'cua-verifier-';
const VERIFIER_APP_ROOM_ID = 'computer-use-proof';
const DEFAULT_DAEMON_ACK_TIMEOUT_MS = 5000;
const DEFAULT_STARTUP_OUTPUT_TIMEOUT_MS = 15000;
const DEFAULT_STARTUP_SETTLE_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 2500;
const MAX_VERIFIER_OUTPUT_TAIL_CHARS = 8192;
const FATAL_VERIFIER_OUTPUT_PATTERN =
  /Error loading config\.toml:|invalid shell environment policy in session-flags/iu;

function optionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizePath(value) {
  const text = optionalString(value, '');
  return text ? path.resolve(text) : '';
}

function pathsEqual(left, right, platform = process.platform) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function boundedPositiveInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tokenizeCommandLine(commandLine) {
  const tokens = [];
  const matcher = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  let match;
  while ((match = matcher.exec(String(commandLine || ''))) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function commandInvokesExactScript(commandLine, scriptPath, platform = process.platform) {
  const tokens = tokenizeCommandLine(commandLine);
  return tokens.length >= 2 && pathsEqual(tokens[1], scriptPath, platform);
}

function defaultQueryWindowsProcess(pid, options = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return Promise.resolve({ ok: false, reason: 'daemon_pid_invalid', process: null });
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
            reason: 'daemon_process_probe_failed',
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
            reason: parsed ? 'daemon_process_found' : 'daemon_process_missing',
            process: parsed || null,
          });
        } catch (parseError) {
          resolve({
            ok: false,
            reason: 'daemon_process_probe_invalid',
            error: parseError.message,
            process: null,
          });
        }
      }
    );
  });
}

function daemonIdentityComparable(identity = {}) {
  return {
    pid: Number(identity.pid) || null,
    createdAt: optionalString(identity.createdAt, null),
    scriptPath: normalizePath(identity.scriptPath),
    pipePath: optionalString(identity.pipePath, null),
    executablePath: normalizePath(identity.executablePath),
    commandLineSha256: optionalString(identity.commandLineSha256, null),
  };
}

function daemonIdentitiesEqual(left, right, platform = process.platform) {
  const a = daemonIdentityComparable(left);
  const b = daemonIdentityComparable(right);
  return a.pid === b.pid
    && a.createdAt === b.createdAt
    && pathsEqual(a.scriptPath, b.scriptPath, platform)
    && a.pipePath === b.pipePath
    && pathsEqual(a.executablePath, b.executablePath, platform)
    && a.commandLineSha256 === b.commandLineSha256;
}

async function probeExistingMainDaemonIdentity(input = {}, dependencies = {}) {
  const platform = optionalString(input.platform, process.platform);
  const profile = optionalString(input.profile, 'main').toLowerCase();
  const projectRoot = normalizePath(input.projectRoot || input.workspace || process.cwd());
  const workspace = normalizePath(input.workspace || projectRoot);
  const daemonScriptPath = normalizePath(
    input.daemonScriptPath || path.join(projectRoot, 'ui', 'terminal-daemon.js')
  );
  const daemonPidPath = normalizePath(
    input.daemonPidPath || path.join(projectRoot, '.squidrun', 'runtime', 'daemon.pid')
  );
  const pipePath = optionalString(input.pipePath, PIPE_PATH);
  if (platform !== 'win32') {
    return { ok: false, reason: 'standalone_controller_is_windows_only' };
  }
  if (profile !== 'main') {
    return { ok: false, reason: 'standalone_controller_non_main_profile_refused' };
  }
  if (!pathsEqual(projectRoot, workspace, platform)) {
    return { ok: false, reason: 'standalone_controller_workspace_root_mismatch' };
  }

  const readFile = dependencies.readFile || fs.readFileSync;
  let pid;
  try {
    pid = Number.parseInt(String(readFile(daemonPidPath, 'utf8')).trim(), 10);
  } catch (error) {
    return {
      ok: false,
      reason: 'existing_daemon_pid_file_unreadable',
      error: error?.message || String(error),
      daemonPidPath,
    };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'existing_daemon_pid_invalid', daemonPidPath };
  }

  const queryProcess = dependencies.queryProcess || defaultQueryWindowsProcess;
  const queried = await queryProcess(pid, { platform });
  const processInfo = queried?.process || null;
  const processPid = Number(processInfo?.ProcessId ?? processInfo?.processId);
  const commandLine = optionalString(
    processInfo?.CommandLine ?? processInfo?.commandLine,
    ''
  );
  const createdAt = optionalString(
    processInfo?.CreationDate ?? processInfo?.creationDate,
    null
  );
  const executablePath = optionalString(
    processInfo?.ExecutablePath ?? processInfo?.executablePath,
    ''
  );
  if (queried?.ok !== true || processPid !== pid) {
    return {
      ok: false,
      reason: queried?.reason || 'existing_daemon_process_missing',
      pid,
      daemonPidPath,
    };
  }
  if (!commandInvokesExactScript(commandLine, daemonScriptPath, platform)) {
    return {
      ok: false,
      reason: 'existing_daemon_exact_script_identity_mismatch',
      pid,
      daemonPidPath,
      daemonScriptPath,
    };
  }
  if (!createdAt || !executablePath) {
    return {
      ok: false,
      reason: 'existing_daemon_start_identity_missing',
      pid,
      daemonPidPath,
      daemonScriptPath,
    };
  }
  return {
    ok: true,
    reason: 'existing_main_daemon_identity_confirmed',
    identity: {
      schema: `${STANDALONE_CONTROLLER_SCHEMA}.daemon_identity`,
      pid,
      createdAt,
      scriptPath: daemonScriptPath,
      pipePath,
      executablePath: normalizePath(executablePath),
      commandLineSha256: sha256(commandLine),
      daemonPidPath,
      projectRoot,
      profile,
    },
  };
}

function normalizeTerminalIdentity(terminal = {}) {
  return {
    paneId: optionalString(terminal.paneId, null),
    pid: Number(terminal.pid) || null,
    alive: terminal.alive === true,
    createdAt: terminal.createdAt ?? null,
    mode: optionalString(terminal.mode, null),
    cwd: normalizePath(terminal.cwd),
    durableAddress: optionalString(terminal.durableAddress, null),
    spawnLeaseId: optionalString(terminal.spawnLeaseId, null),
  };
}

function terminalMatchesAddressedGeneration(terminal = {}, generation = {}) {
  const normalized = normalizeTerminalIdentity(terminal);
  const expected = normalizeTerminalIdentity(generation);
  if (!normalized.paneId || !expected.paneId
    || !normalized.pid || !expected.pid
    || !normalized.durableAddress || !expected.durableAddress
    || !normalized.spawnLeaseId || !expected.spawnLeaseId) {
    return false;
  }
  const createdAtMatches = expected.createdAt === null
    || normalized.createdAt === expected.createdAt;
  return normalized.paneId === expected.paneId
    && normalized.pid === expected.pid
    && normalized.durableAddress === expected.durableAddress
    && normalized.spawnLeaseId === expected.spawnLeaseId
    && createdAtMatches;
}

function normalizeTerminalSnapshot(terminals = []) {
  return (Array.isArray(terminals) ? terminals : [])
    .map(normalizeTerminalIdentity)
    .filter((terminal) => terminal.paneId)
    .sort((left, right) => left.paneId.localeCompare(right.paneId));
}

function protectedTerminalSnapshotsEqual(before = [], after = [], excludedPaneId = null) {
  const excluded = optionalString(excludedPaneId, null);
  const filter = (terminal) => terminal.paneId !== excluded;
  return canonicalJson(normalizeTerminalSnapshot(before).filter(filter))
    === canonicalJson(normalizeTerminalSnapshot(after).filter(filter));
}

function requestTerminalSnapshot(daemonClient, options = {}) {
  if (!daemonClient || typeof daemonClient.list !== 'function'
    || typeof daemonClient.on !== 'function') {
    return Promise.resolve({
      ok: false,
      reason: 'daemon_terminal_snapshot_unavailable',
      terminals: [],
    });
  }
  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs,
    DEFAULT_SNAPSHOT_TIMEOUT_MS,
    100,
    10000
  );
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof daemonClient.off === 'function') daemonClient.off('list', onList);
      else if (typeof daemonClient.removeListener === 'function') {
        daemonClient.removeListener('list', onList);
      }
      resolve(result);
    };
    const onList = (terminals) => {
      finish({
        ok: true,
        reason: 'daemon_terminal_snapshot_received',
        terminals: normalizeTerminalSnapshot(terminals),
      });
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason: 'daemon_terminal_snapshot_timeout',
        terminals: [],
      });
    }, timeoutMs);
    daemonClient.on('list', onList);
    const sent = daemonClient.list();
    if (sent === false) {
      finish({
        ok: false,
        reason: 'daemon_terminal_snapshot_send_failed',
        terminals: [],
      });
    }
  });
}

function createPaneStartupOutputLatch(daemonClient, paneId, options = {}) {
  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs,
    DEFAULT_STARTUP_OUTPUT_TIMEOUT_MS,
    100,
    60000
  );
  const settleMs = boundedPositiveInteger(
    options.settleMs,
    DEFAULT_STARTUP_SETTLE_MS,
    25,
    5000
  );
  const id = String(paneId);
  let startupSettled = false;
  let cleanupStarted = false;
  let outputBytes = 0;
  let outputTail = '';
  const outputHash = crypto.createHash('sha256');
  let expectedGeneration = null;
  let lifecycleFailure = null;
  let cleanupExit = null;
  const queuedExitEvents = [];
  let settleTimer = null;
  let timeoutTimer = null;
  let resolveWait;
  let resolveFailure;
  const wait = new Promise((resolve) => {
    resolveWait = resolve;
  });
  const failureWait = new Promise((resolve) => {
    resolveFailure = resolve;
  });
  const outputEvidence = () => {
    let digest = null;
    try {
      digest = outputHash.copy().digest('hex');
    } catch (_) {
      digest = null;
    }
    return {
      outputBytes,
      outputSha256: digest,
      outputTail,
    };
  };
  const sanitizeOutput = (value) => String(value || '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '');
  const cleanup = () => {
    clearTimeout(settleTimer);
    clearTimeout(timeoutTimer);
    if (typeof daemonClient.off === 'function') {
      daemonClient.off('data', onData);
      daemonClient.off('disconnected', onDisconnected);
      daemonClient.off('exit', onExit);
    } else if (typeof daemonClient.removeListener === 'function') {
      daemonClient.removeListener('data', onData);
      daemonClient.removeListener('disconnected', onDisconnected);
      daemonClient.removeListener('exit', onExit);
    }
  };
  const finishStartup = (result) => {
    if (startupSettled) return;
    startupSettled = true;
    clearTimeout(settleTimer);
    clearTimeout(timeoutTimer);
    resolveWait({
      ...result,
      ...outputEvidence(),
    });
  };
  const recordFailure = (result) => {
    if (lifecycleFailure) return lifecycleFailure;
    lifecycleFailure = {
      ok: false,
      status: 'blocked',
      paneId: id,
      ...result,
      ...outputEvidence(),
    };
    resolveFailure(lifecycleFailure);
    return lifecycleFailure;
  };
  const classifyExit = (event) => {
    if (!expectedGeneration) {
      queuedExitEvents.push(event);
      return;
    }
    const eventIdentity = normalizeTerminalIdentity(event.metadata);
    const requiredIdentityPresent = Boolean(
      eventIdentity.pid
      && eventIdentity.durableAddress
      && eventIdentity.spawnLeaseId
    );
    if (!requiredIdentityPresent) {
      const failure = recordFailure({
        reason: 'standalone_verifier_exit_identity_unverifiable',
        exitCode: event.code,
        exit: eventIdentity,
      });
      if (!startupSettled) {
        finishStartup({
          ...failure,
          reason: 'standalone_verifier_exited_before_ready',
          lifecycleReason: failure.reason,
        });
      }
      return;
    }
    if (!terminalMatchesAddressedGeneration(eventIdentity, expectedGeneration)) return;
    const exit = {
      ...eventIdentity,
      exitCode: event.code,
    };
    if (cleanupStarted) {
      cleanupExit = exit;
      return;
    }
    const failure = recordFailure({
      reason: 'standalone_verifier_generation_exited',
      exitCode: event.code,
      exit,
    });
    if (!startupSettled) {
      finishStartup({
        ...failure,
        reason: 'standalone_verifier_exited_before_ready',
        lifecycleReason: failure.reason,
      });
    }
  };
  const onData = (eventPaneId, data) => {
    if (String(eventPaneId) !== id) return;
    const raw = String(data || '');
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes <= 0) return;
    outputBytes += bytes;
    outputHash.update(raw, 'utf8');
    outputTail = `${outputTail}${sanitizeOutput(raw)}`
      .slice(-MAX_VERIFIER_OUTPUT_TAIL_CHARS);
    if (FATAL_VERIFIER_OUTPUT_PATTERN.test(outputTail)) {
      const failure = recordFailure({
        reason: 'standalone_verifier_fatal_startup_output',
      });
      finishStartup(failure);
      return;
    }
    if (startupSettled) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      finishStartup({
        ok: true,
        reason: 'standalone_verifier_startup_output_observed',
        paneId: id,
      });
    }, settleMs);
  };
  const onExit = (eventPaneId, code, metadata = {}) => {
    if (String(eventPaneId) !== id) return;
    classifyExit({
      code,
      metadata: {
        ...metadata,
        paneId: eventPaneId,
      },
    });
  };
  const onDisconnected = () => {
    if (cleanupStarted) return;
    const failure = recordFailure({
      reason: 'standalone_verifier_daemon_disconnected',
    });
    finishStartup(failure);
  };
  daemonClient.on('data', onData);
  daemonClient.on('disconnected', onDisconnected);
  daemonClient.on('exit', onExit);
  timeoutTimer = setTimeout(() => {
    finishStartup({
      ok: false,
      reason: 'standalone_verifier_startup_output_timeout',
      paneId: id,
    });
  }, timeoutMs);
  return {
    bindGeneration: (generation) => {
      expectedGeneration = normalizeTerminalIdentity(generation);
      if (!expectedGeneration.pid
        || !expectedGeneration.durableAddress
        || !expectedGeneration.spawnLeaseId
        || expectedGeneration.paneId !== id) {
        const failure = recordFailure({
          reason: 'standalone_verifier_generation_identity_invalid',
        });
        finishStartup(failure);
        return failure;
      }
      for (const event of queuedExitEvents.splice(0)) classifyExit(event);
      return {
        ok: true,
        reason: 'standalone_verifier_generation_bound',
        generation: { ...expectedGeneration },
      };
    },
    beginCleanup: () => {
      cleanupStarted = true;
    },
    evidence: () => ({
      generation: expectedGeneration ? { ...expectedGeneration } : null,
      failure: lifecycleFailure ? { ...lifecycleFailure } : null,
      cleanupExit: cleanupExit ? { ...cleanupExit } : null,
      ...outputEvidence(),
    }),
    getFailure: () => lifecycleFailure,
    waitForFailure: () => failureWait,
    wait: () => wait,
    dispose: cleanup,
  };
}

function daemonWriteAccepted(result) {
  return result?.success === true
    && String(result.status || '').toLowerCase() === 'accepted';
}

function freshVerifierIdentity(projectRoot, createId = crypto.randomUUID) {
  const uuid = String(createId()).toLowerCase();
  const paneId = `${VERIFIER_PANE_PREFIX}${uuid}`;
  const durableAddress = buildArmDurableAddress({
    workspacePath: projectRoot,
    profileName: 'main',
    appRoomId: VERIFIER_APP_ROOM_ID,
    armKey: paneId,
    paneId,
  });
  return { paneId, durableAddress, uuid };
}

function safeProofArtifactRoot(claim) {
  const journalPath = normalizePath(claim?.proof?.journalPath);
  if (!journalPath) return null;
  const proofRoot = path.dirname(journalPath);
  const tempRoot = normalizePath(os.tmpdir());
  const relative = path.relative(tempRoot, proofRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(proofRoot).startsWith('squidrun-cua-proof-')) {
    return null;
  }
  return proofRoot;
}

function cleanupProofArtifacts(claim, options = {}) {
  const proofRoot = safeProofArtifactRoot(claim);
  if (!proofRoot) return { ok: false, reason: 'proof_artifact_root_refused' };
  try {
    (options.removeDirectory || fs.rmSync)(proofRoot, {
      recursive: true,
      force: true,
    });
    return { ok: true, reason: 'proof_artifacts_removed', proofRoot };
  } catch (error) {
    return {
      ok: false,
      reason: 'proof_artifact_cleanup_failed',
      error: error?.message || String(error),
      proofRoot,
    };
  }
}

function publicDaemonIdentity(identity = {}) {
  const comparable = daemonIdentityComparable(identity);
  return {
    pid: comparable.pid,
    createdAt: comparable.createdAt,
    scriptPath: comparable.scriptPath,
    pipePath: comparable.pipePath,
    executablePath: comparable.executablePath,
    commandLineSha256: comparable.commandLineSha256,
  };
}

async function runStandaloneCodexComputerUseProof(input = {}, dependencies = {}) {
  const platform = optionalString(input.platform, process.platform);
  const projectRoot = normalizePath(input.projectRoot || input.workspace || process.cwd());
  const workspace = normalizePath(input.workspace || projectRoot);
  const profile = optionalString(input.profile, 'main').toLowerCase();
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || defaultSleep;
  const createId = dependencies.randomUUID || crypto.randomUUID;
  const proofTimeoutMs = boundedPositiveInteger(
    input.proofTimeoutMs,
    DEFAULT_PROOF_TIMEOUT_MS,
    1000,
    180000
  );
  const pollIntervalMs = boundedPositiveInteger(
    input.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    25,
    2000
  );
  const command = optionalString(input.command, EXACT_ORACLE_COMMAND);

  if (input.executeCurrentSessionProof !== true) {
    return {
      ok: false,
      schema: STANDALONE_CONTROLLER_SCHEMA,
      status: 'blocked',
      reason: 'explicit_current_session_proof_authorization_required',
    };
  }
  if (platform !== 'win32') {
    return {
      ok: false,
      schema: STANDALONE_CONTROLLER_SCHEMA,
      status: 'blocked',
      reason: 'standalone_controller_is_windows_only',
    };
  }
  if (profile !== 'main') {
    return {
      ok: false,
      schema: STANDALONE_CONTROLLER_SCHEMA,
      status: 'blocked',
      reason: 'standalone_controller_non_main_profile_refused',
    };
  }
  if (!pathsEqual(projectRoot, workspace, platform)) {
    return {
      ok: false,
      schema: STANDALONE_CONTROLLER_SCHEMA,
      status: 'blocked',
      reason: 'standalone_controller_workspace_root_mismatch',
    };
  }
  if (command !== EXACT_ORACLE_COMMAND) {
    return {
      ok: false,
      schema: STANDALONE_CONTROLLER_SCHEMA,
      status: 'blocked',
      reason: 'standalone_controller_exact_fresh_oracle_command_required',
    };
  }
  if (input.launchOwner !== true) {
    return {
      ok: false,
      schema: STANDALONE_CONTROLLER_SCHEMA,
      status: 'blocked',
      reason: 'explicit_codex_desktop_owner_launch_required',
    };
  }

  const verifier = freshVerifierIdentity(projectRoot, createId);
  if (!verifier.durableAddress || ['1', '2', '3'].includes(verifier.paneId)) {
    return {
      ok: false,
      schema: STANDALONE_CONTROLLER_SCHEMA,
      status: 'blocked',
      reason: 'standalone_verifier_identity_invalid',
    };
  }

  const probeDaemonIdentity = dependencies.probeDaemonIdentity
    || probeExistingMainDaemonIdentity;
  const daemonProbeInput = {
    platform,
    profile,
    projectRoot,
    workspace,
    pipePath: input.pipePath || PIPE_PATH,
    daemonPidPath: input.daemonPidPath,
    daemonScriptPath: input.daemonScriptPath,
  };
  const daemonBeforeProbe = await probeDaemonIdentity(daemonProbeInput);
  if (daemonBeforeProbe?.ok !== true) {
    return {
      ok: false,
      schema: STANDALONE_CONTROLLER_SCHEMA,
      status: 'blocked',
      reason: daemonBeforeProbe?.reason || 'existing_main_daemon_preflight_failed',
      daemonPreflight: daemonBeforeProbe || null,
    };
  }
  const daemonBefore = daemonBeforeProbe.identity;
  const createDaemonClient = dependencies.createDaemonClient
    || ((options) => new DaemonClient(options));
  const daemonClient = createDaemonClient({
    profileName: 'main',
    pipePath: daemonBefore.pipePath,
  });
  if (!daemonClient || typeof daemonClient.connectExisting !== 'function') {
    return {
      ok: false,
      schema: STANDALONE_CONTROLLER_SCHEMA,
      status: 'blocked',
      reason: 'connect_existing_daemon_api_unavailable',
    };
  }

  let spawned = null;
  let claim = null;
  let startupLatch = null;
  let primaryResult = null;
  let cleanupResult = null;
  let beforeSnapshot = null;
  let afterSpawnSnapshot = null;
  let finalSnapshot = null;
  let browserPipesBefore = null;
  let browserPipesAfter = null;
  let journalSha256 = null;
  let proofArtifactCleanup = null;
  const consumedIds = new Set();
  const setPrimaryResult = (result = {}, extra = {}) => {
    primaryResult = {
      schema: STANDALONE_CONTROLLER_SCHEMA,
      authoritativeComputerUseReady: false,
      ...result,
      ...extra,
    };
    return primaryResult;
  };
  const setVerifierLifecycleFailure = (failure, fallbackReason) =>
    setPrimaryResult({
      ok: false,
      status: 'blocked',
      reason: failure?.reason || fallbackReason || 'standalone_verifier_lifecycle_failed',
      verifierLifecycle: failure || startupLatch?.evidence?.() || null,
    });

  try {
    const connected = await daemonClient.connectExisting();
    if (connected !== true) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: 'existing_daemon_pipe_connect_failed',
      }, {
        daemon: publicDaemonIdentity(daemonBefore),
      });
    }
    const daemonAfterConnectProbe = await probeDaemonIdentity(daemonProbeInput);
    if (daemonAfterConnectProbe?.ok !== true
      || !daemonIdentitiesEqual(daemonBefore, daemonAfterConnectProbe.identity, platform)) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: 'existing_daemon_identity_changed_during_connect',
      }, {
        daemonBefore: publicDaemonIdentity(daemonBefore),
        daemonAfterConnect: daemonAfterConnectProbe?.identity
          ? publicDaemonIdentity(daemonAfterConnectProbe.identity)
          : null,
      });
    }

    const snapshotTerminals = dependencies.requestTerminalSnapshot
      || requestTerminalSnapshot;
    const before = await snapshotTerminals(daemonClient, {
      timeoutMs: input.snapshotTimeoutMs,
    });
    if (before?.ok !== true) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: before?.reason || 'daemon_terminal_snapshot_failed',
      });
    }
    beforeSnapshot = before.terminals;
    if (beforeSnapshot.some((terminal) =>
      terminal.paneId === verifier.paneId
      || terminal.durableAddress === verifier.durableAddress)) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: 'standalone_verifier_identity_collision',
      });
    }

    const prepareBridge = dependencies.prepareBridge
      || prepareCodexComputerUseNativeBridge;
    const preflight = await prepareBridge({
      platform,
      projectRoot,
      workspace,
      paneId: verifier.paneId,
      profile,
      launchOwner: true,
      timeoutMs: input.prepareTimeoutMs,
      intervalMs: input.prepareIntervalMs,
    });
    if (preflight?.ok !== true || !preflight.generation) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: preflight?.reason || 'codex_computer_use_preflight_failed',
        preflight: preflight || null,
      });
    }
    browserPipesBefore = preflight.browserPipeSnapshot?.after || null;
    if (!browserPipesBefore?.ok) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: 'browser_pipe_snapshot_unavailable',
      });
    }

    claim = {
      claimId: createId(),
      paneId: verifier.paneId,
      workspace,
      projectRoot,
      profile,
      platform,
      generation: preflight.generation,
      createdAt: new Date(now()).toISOString(),
      commandAuthorizedAt: null,
      postSpawnConfirmedAt: null,
    };
    const resolveClientPath = dependencies.resolveClientPath
      || resolveOfficialComputerUseClientPath;
    const clientPath = resolveClientPath({
      codexHome: preflight?.bridge?.config?.codexHome,
      projectRoot,
    });
    const armProofClaim = dependencies.armProofClaim
      || armCodexComputerUseProofClaim;
    const armed = await armProofClaim({
      claim,
      bridge: preflight.bridge,
      clientPath,
      projectRoot,
      codexHome: preflight?.bridge?.config?.codexHome,
      platform,
    });
    if (armed?.ok !== true) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: armed?.reason || 'codex_computer_use_proof_arm_failed',
      });
    }

    const confirmGeneration = dependencies.confirmGeneration
      || confirmCodexComputerUsePipeGeneration;
    const confirmInput = {
      platform,
      projectRoot,
      workspace,
      paneId: verifier.paneId,
      profile,
    };
    const beforeSpawnGeneration = await confirmGeneration(
      claim.generation,
      confirmInput
    );
    if (beforeSpawnGeneration?.ok !== true) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: beforeSpawnGeneration?.reason
          || 'computer_use_pipe_generation_changed_before_spawn',
      });
    }
    claim.commandAuthorizedAt = new Date(now()).toISOString();
    const buildProofInvocation = dependencies.buildProofInvocation
      || buildCodexComputerUseProofInvocation;
    const invocation = buildProofInvocation(command, claim, { platform });
    if (invocation?.ok !== true) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: invocation?.reason || 'codex_computer_use_proof_invocation_failed',
      });
    }

    const createStartupLatch = dependencies.createStartupLatch
      || createPaneStartupOutputLatch;
    startupLatch = createStartupLatch(daemonClient, verifier.paneId, {
      timeoutMs: input.startupOutputTimeoutMs,
      settleMs: input.startupSettleMs,
    });
    const sourceMessageId = optionalString(
      input.sourceMessageId,
      `current-session-cua-proof:${claim.claimId}`
    );
    const owner = 'squidrun-current-session-cua-controller';
    const recoveryEvent = 'current_session_computer_use_proof';
    const expectedResponseClass = 'computer_use.list_windows.attestation';
    const spawnResult = await daemonClient.spawnAddressed({
      durableAddress: verifier.durableAddress,
      paneId: verifier.paneId,
      cwd: workspace,
      dryRun: false,
      mode: 'pty-command',
      env: {
        ...claim.proofSpawnEnv,
        SQUIDRUN_ROLE: VERIFIER_ROLE,
        SQUIDRUN_PANE_ID: verifier.paneId,
        SQUIDRUN_PROFILE: 'main',
        SQUIDRUN_PROJECT_ROOT: projectRoot,
        SQUIDRUN_CUA_CONTROLLER_SCHEMA: STANDALONE_CONTROLLER_SCHEMA,
      },
      owner,
      recoveryEvent,
      sourceMessageId,
      expectedResponseClass,
      options: {
        paneCommand: invocation.command,
        spawnCommandOnCreate: true,
      },
    }, {
      timeoutMs: boundedPositiveInteger(
        input.daemonAckTimeoutMs,
        DEFAULT_DAEMON_ACK_TIMEOUT_MS,
        100,
        30000
      ),
    });
    const validatedSpawn = validateSpawnResult(spawnResult, {
      durableAddress: verifier.durableAddress,
      paneId: verifier.paneId,
      sourceMessageId,
      expectedResponseClass,
      owner,
      recoveryEvent,
    });
    if (!validatedSpawn.ok) {
      if (spawnResult?.ok === true && spawnResult?.spawnLeaseId) {
        spawned = {
          durableAddress: verifier.durableAddress,
          spawnLeaseId: spawnResult.spawnLeaseId,
          paneId: verifier.paneId,
          sourceMessageId,
        };
      }
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: validatedSpawn.reason || 'standalone_verifier_spawn_failed',
      });
    }
    spawned = {
      durableAddress: verifier.durableAddress,
      spawnLeaseId: validatedSpawn.spawnLeaseId,
      paneId: verifier.paneId,
      pid: validatedSpawn.pid,
      createdAt: validatedSpawn.terminal.createdAt ?? null,
      sourceMessageId,
    };
    claim.daemonSpawnObservedAt = new Date(now()).toISOString();
    claim.daemonSpawnPid = validatedSpawn.pid;
    const boundGeneration = startupLatch?.bindGeneration?.(spawned);
    if (boundGeneration?.ok !== true) {
      return setVerifierLifecycleFailure(
        boundGeneration,
        'standalone_verifier_generation_bind_failed'
      );
    }

    const startup = await startupLatch.wait();
    if (startup?.ok !== true) {
      return setVerifierLifecycleFailure(
        startup,
        'standalone_verifier_startup_failed'
      );
    }
    let verifierFailure = startupLatch?.getFailure?.() || null;
    if (verifierFailure) {
      return setVerifierLifecycleFailure(verifierFailure);
    }
    const afterSpawnGeneration = await confirmGeneration(
      claim.generation,
      confirmInput
    );
    verifierFailure = startupLatch?.getFailure?.() || null;
    if (verifierFailure) {
      return setVerifierLifecycleFailure(verifierFailure);
    }
    if (afterSpawnGeneration?.ok !== true) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: afterSpawnGeneration?.reason
          || 'computer_use_pipe_generation_changed_after_spawn',
      });
    }
    claim.postSpawnConfirmedAt = new Date(now()).toISOString();

    const afterSpawn = await snapshotTerminals(daemonClient, {
      timeoutMs: input.snapshotTimeoutMs,
    });
    verifierFailure = startupLatch?.getFailure?.() || null;
    if (verifierFailure) {
      return setVerifierLifecycleFailure(verifierFailure);
    }
    if (afterSpawn?.ok !== true) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: afterSpawn?.reason || 'daemon_terminal_snapshot_failed_after_spawn',
      });
    }
    afterSpawnSnapshot = afterSpawn.terminals;
    const targetTerminal = afterSpawnSnapshot.find((terminal) =>
      terminal.paneId === verifier.paneId);
    if (!targetTerminal
      || targetTerminal.pid !== validatedSpawn.pid
      || targetTerminal.durableAddress !== verifier.durableAddress
      || targetTerminal.spawnLeaseId !== validatedSpawn.spawnLeaseId
      || !protectedTerminalSnapshotsEqual(
        beforeSnapshot,
        afterSpawnSnapshot,
        verifier.paneId
      )) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: 'protected_terminal_pid_invariant_changed_after_spawn',
      });
    }

    const buildVerification = dependencies.buildVerification
      || buildOfficialListWindowsVerification;
    const plan = buildVerification({
      bridge: afterSpawnGeneration.bridge,
      trustedClaim: claim,
      projectRoot,
      paneId: verifier.paneId,
      platform,
    });
    if (plan?.ok !== true) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: plan?.reason || 'codex_computer_use_list_windows_plan_failed',
      });
    }
    verifierFailure = startupLatch?.getFailure?.() || null;
    if (verifierFailure) {
      return setVerifierLifecycleFailure(verifierFailure);
    }
    claim.listWindowsPlanId = createId();
    claim.listWindowsPlanIssuedAt = new Date(now()).toISOString();
    claim.proof.state = 'pending';
    claim.proof.deadlineAtMs = now() + proofTimeoutMs;

    const promptAck = await daemonClient.writeAndWaitAck(
      verifier.paneId,
      plan.prompt,
      {
        eventId: `cua-proof-prompt-${claim.listWindowsPlanId}`,
        correlationId: claim.claimId,
        source: 'codex-computer-use-standalone-controller',
      },
      { timeoutMs: DEFAULT_DAEMON_ACK_TIMEOUT_MS }
    );
    verifierFailure = startupLatch?.getFailure?.() || null;
    if (verifierFailure) {
      return setVerifierLifecycleFailure(verifierFailure);
    }
    if (!daemonWriteAccepted(promptAck)) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: 'standalone_verifier_prompt_write_failed',
      });
    }
    const enterDelayMs = boundedPositiveInteger(input.enterDelayMs, 50, 0, 2000);
    if (enterDelayMs > 0 && typeof startupLatch?.waitForFailure === 'function') {
      const enterDelayOutcome = await Promise.race([
        Promise.resolve(sleep(enterDelayMs)).then(() => null),
        startupLatch.waitForFailure(),
      ]);
      if (enterDelayOutcome) {
        return setVerifierLifecycleFailure(enterDelayOutcome);
      }
    } else {
      await sleep(enterDelayMs);
    }
    const enterAck = await daemonClient.writeAndWaitAck(
      verifier.paneId,
      '\r',
      {
        eventId: `cua-proof-enter-${claim.listWindowsPlanId}`,
        correlationId: claim.claimId,
        source: 'codex-computer-use-standalone-controller',
      },
      { timeoutMs: DEFAULT_DAEMON_ACK_TIMEOUT_MS }
    );
    verifierFailure = startupLatch?.getFailure?.() || null;
    if (verifierFailure) {
      return setVerifierLifecycleFailure(verifierFailure);
    }
    if (!daemonWriteAccepted(enterAck)) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: 'standalone_verifier_prompt_submit_failed',
      });
    }

    const verifyJournal = dependencies.verifyJournal
      || verifyCodexComputerUseProofJournal;
    let verification = null;
    while (now() <= claim.proof.deadlineAtMs) {
      verifierFailure = startupLatch?.getFailure?.() || null;
      if (verifierFailure) {
        verification = {
          ...verifierFailure,
          verifierLifecycle: verifierFailure,
        };
        break;
      }
      const currentGeneration = await confirmGeneration(
        claim.generation,
        confirmInput
      );
      if (currentGeneration?.ok !== true) {
        verification = {
          ok: false,
          status: 'blocked',
          reason: currentGeneration?.reason
            || 'computer_use_pipe_generation_changed_during_proof',
        };
        break;
      }
      verification = await verifyJournal(claim, {
        consumedIds,
        platform,
      });
      verifierFailure = startupLatch?.getFailure?.() || null;
      if (verifierFailure) {
        verification = {
          ...verifierFailure,
          verifierLifecycle: verifierFailure,
        };
        break;
      }
      if (verification?.ok === true || verification?.status !== 'pending') break;
      if (typeof startupLatch?.waitForFailure === 'function') {
        const pollOutcome = await Promise.race([
          Promise.resolve(sleep(pollIntervalMs)).then(() => null),
          startupLatch.waitForFailure(),
        ]);
        if (pollOutcome) {
          verification = {
            ...pollOutcome,
            verifierLifecycle: pollOutcome,
          };
          break;
        }
      } else {
        await sleep(pollIntervalMs);
      }
    }
    if (!verification || verification?.status === 'pending') {
      verification = await verifyJournal(claim, {
        consumedIds,
        platform,
        now: () => claim.proof.deadlineAtMs + 1,
      });
    }
    if (verification?.ok !== true) {
      return setPrimaryResult({
        ok: false,
        status: 'blocked',
        reason: verification?.reason || 'codex_computer_use_proof_failed',
        verification: verification || null,
        verifierLifecycle: verification?.verifierLifecycle
          || startupLatch?.evidence?.()
          || null,
      });
    }
    try {
      journalSha256 = sha256File(claim.proof.journalPath);
    } catch (_) {
      journalSha256 = null;
    }
    return setPrimaryResult({
      ok: true,
      status: 'passed',
      reason: 'current_session_computer_use_list_windows_proved',
      authoritativeComputerUseReady: true,
      verification: {
        sessionId: verification.sessionId,
        turnId: verification.turnId,
        toolUseId: verification.toolUseId,
        operation: verification.operation,
        windowCount: verification.windowCount,
        officialClientPath: verification.officialClientPath,
        officialClientSha256: verification.officialClientSha256,
      },
      claim: {
        claimId: claim.claimId,
        planId: claim.listWindowsPlanId,
        paneId: verifier.paneId,
        generation: claim.generation,
        toolInputSha256: claim.proof.canonicalPlan.toolInputSha256,
        journalSha256,
      },
    });
  } catch (error) {
    return setPrimaryResult({
      ok: false,
      status: 'blocked',
      reason: 'standalone_controller_exception',
      error: error?.message || String(error),
    });
  } finally {
    startupLatch?.beginCleanup?.();
    if (spawned?.spawnLeaseId) {
      try {
        cleanupResult = await daemonClient.killAddressed({
          durableAddress: spawned.durableAddress,
          spawnLeaseId: spawned.spawnLeaseId,
          paneId: spawned.paneId,
          sourceMessageId: spawned.sourceMessageId,
          reason: 'computer_use_proof_complete',
          recoveryEvent: 'current_session_computer_use_proof_cleanup',
        }, {
          timeoutMs: boundedPositiveInteger(
            input.daemonAckTimeoutMs,
            DEFAULT_DAEMON_ACK_TIMEOUT_MS,
            100,
            30000
          ),
        });
      } catch (error) {
        cleanupResult = {
          ok: false,
          reason: 'addressed_cleanup_exception',
          error: error?.message || String(error),
        };
      }
    }

    if (daemonClient?.connected) {
      const snapshotTerminals = dependencies.requestTerminalSnapshot
        || requestTerminalSnapshot;
      try {
        const final = await snapshotTerminals(daemonClient, {
          timeoutMs: input.snapshotTimeoutMs,
        });
        finalSnapshot = final?.ok === true ? final.terminals : null;
      } catch (_) {
        finalSnapshot = null;
      }
      const snapshotBrowserPipes = dependencies.snapshotBrowserPipes
        || defaultListBrowserPipes;
      try {
        browserPipesAfter = await snapshotBrowserPipes({ platform });
      } catch (error) {
        browserPipesAfter = {
          ok: false,
          reason: 'browser_pipe_snapshot_failed',
          error: error?.message || String(error),
          pipes: [],
        };
      }
    }

    let daemonAfterProbe = null;
    try {
      daemonAfterProbe = await probeDaemonIdentity(daemonProbeInput);
    } catch (_) {
      daemonAfterProbe = null;
    }
    const cleanupRequired = Boolean(spawned?.spawnLeaseId);
    const addressedGenerationTerminal = cleanupRequired && Array.isArray(finalSnapshot)
      ? finalSnapshot.find((terminal) =>
        terminal.alive === true
        && terminalMatchesAddressedGeneration(terminal, spawned)) || null
      : null;
    const addressedGenerationAbsent = !cleanupRequired
      || (Array.isArray(finalSnapshot) && !addressedGenerationTerminal);
    const samePaneSuccessor = cleanupRequired && Array.isArray(finalSnapshot)
      ? finalSnapshot.find((terminal) =>
        terminal.paneId === verifier.paneId
        && terminal.alive === true
        && !terminalMatchesAddressedGeneration(terminal, spawned)) || null
      : null;
    const paneIdAbsent = !cleanupRequired
      || (
        Array.isArray(finalSnapshot)
        && !finalSnapshot.some((terminal) =>
          terminal.paneId === verifier.paneId && terminal.alive === true)
      );
    const cleanupSafe = !cleanupRequired || addressedGenerationAbsent;
    const targetAbsent = addressedGenerationAbsent;
    const terminalsPreserved = !Array.isArray(beforeSnapshot)
      || (
        Array.isArray(finalSnapshot)
        && protectedTerminalSnapshotsEqual(
          beforeSnapshot,
          finalSnapshot,
          verifier.paneId
        )
      );
    const daemonPreserved = daemonAfterProbe?.ok === true
      && daemonIdentitiesEqual(daemonBefore, daemonAfterProbe.identity, platform);
    const browserPipesPreserved = !browserPipesBefore
      || (
        browserPipesAfter?.ok === true
        && browserPipeSnapshotTransitionAllowed(
          browserPipesBefore,
          browserPipesAfter
        )
      );

    const proofArtifactsCreated = Boolean(claim?.proof?.journalPath);
    if (proofArtifactsCreated) {
      proofArtifactCleanup = (dependencies.cleanupProofArtifacts
        || cleanupProofArtifacts)(claim);
    }
    const verifierLifecycleEvidence = startupLatch?.evidence?.() || null;
    startupLatch?.dispose?.();
    daemonClient?.disconnect?.();

    if (primaryResult) {
      primaryResult.cleanup = {
        addressedLease: cleanupResult,
        addressedGenerationAbsent,
        paneIdAbsent,
        samePaneSuccessor,
        targetAbsent,
        protectedTerminalsPreserved: terminalsPreserved,
        daemonPreserved,
        browserPipesPreserved,
        proofArtifacts: proofArtifactCleanup,
      };
      if (!primaryResult.verifierLifecycle && verifierLifecycleEvidence) {
        primaryResult.verifierLifecycle = verifierLifecycleEvidence;
      }
      primaryResult.invariants = {
        daemonBefore: publicDaemonIdentity(daemonBefore),
        daemonAfter: daemonAfterProbe?.identity
          ? publicDaemonIdentity(daemonAfterProbe.identity)
          : null,
        protectedTerminalPidsBefore: normalizeTerminalSnapshot(beforeSnapshot || [])
          .map(({ paneId, pid, createdAt }) => ({ paneId, pid, createdAt })),
        protectedTerminalPidsAfter: normalizeTerminalSnapshot(finalSnapshot || [])
          .map(({ paneId, pid, createdAt }) => ({ paneId, pid, createdAt })),
      };
      const successorRequiresFailClosed = Boolean(
        samePaneSuccessor && primaryResult.ok === true
      );
      if (!cleanupSafe || !targetAbsent || !terminalsPreserved
        || !daemonPreserved || !browserPipesPreserved
        || (proofArtifactsCreated && proofArtifactCleanup?.ok !== true)
        || successorRequiresFailClosed) {
        primaryResult.ok = false;
        primaryResult.status = 'blocked';
        primaryResult.authoritativeComputerUseReady = false;
        primaryResult.originalReason = primaryResult.reason;
        primaryResult.reason = successorRequiresFailClosed
          ? 'standalone_verifier_same_pane_successor_present'
          : 'standalone_controller_cleanup_or_invariant_failed';
      }
    }
  }
}

module.exports = {
  DEFAULT_DAEMON_ACK_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  DEFAULT_STARTUP_OUTPUT_TIMEOUT_MS,
  EXACT_ORACLE_COMMAND,
  STANDALONE_CONTROLLER_SCHEMA,
  VERIFIER_APP_ROOM_ID,
  VERIFIER_PANE_PREFIX,
  VERIFIER_ROLE,
  cleanupProofArtifacts,
  commandInvokesExactScript,
  createPaneStartupOutputLatch,
  daemonIdentitiesEqual,
  daemonWriteAccepted,
  freshVerifierIdentity,
  normalizeTerminalSnapshot,
  probeExistingMainDaemonIdentity,
  protectedTerminalSnapshotsEqual,
  requestTerminalSnapshot,
  runStandaloneCodexComputerUseProof,
  terminalMatchesAddressedGeneration,
  tokenizeCommandLine,
};
