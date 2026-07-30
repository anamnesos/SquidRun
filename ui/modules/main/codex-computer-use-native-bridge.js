'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  LIST_WINDOWS_PROOF_SCHEMA,
  sha256File,
} = require('./codex-computer-use-proof');

const BRIDGE_SCHEMA = 'squidrun.codex_computer_use_native_bridge.v1';
const PIPE_GENERATION_SCHEMA = 'squidrun.codex_computer_use_pipe_generation.v1';
const COMPUTER_USE_PLUGIN_SECTION = 'plugins."computer-use@openai-bundled"';
const NODE_REPL_ENV_SECTION = 'mcp_servers.node_repl.env';
const COMPUTER_USE_PIPE_PREFIX = '\\\\.\\pipe\\codex-computer-use-';
const CODEX_DESKTOP_AUMID = 'OpenAI.Codex_2p2nqsd0c76g0!App';
const DEFAULT_PREPARE_TIMEOUT_MS = 15000;
const DEFAULT_PREPARE_INTERVAL_MS = 250;

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function asIso(value, fallbackMs = Date.now()) {
  if (value instanceof Date) return value.toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  const text = toOptionalString(value, null);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function normalizePath(value) {
  const text = toOptionalString(value, '');
  if (!text) return '';
  return path.resolve(text);
}

function pathsEqual(left, right, platform = process.platform) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  return platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function normalizePipePath(value) {
  return toOptionalString(value, '')?.replace(/\//gu, '\\') || '';
}

function captureCodexComputerUsePipeGeneration(bridge = {}) {
  const pipePath = normalizePipePath(bridge.pipe?.path || bridge.config?.pipePath);
  if (bridge.pipeReady !== true
    || bridge.desktopOwner?.running !== true
    || bridge.pipe?.present !== true
    || bridge.pipe?.exactPipeIsUnique !== true
    || !isSupportedComputerUsePipePath(pipePath)) {
    return null;
  }
  return {
    schema: PIPE_GENERATION_SCHEMA,
    pipePath,
    configPath: normalizePath(bridge.config?.configPath),
    projectRoot: normalizePath(bridge.projectRoot),
    paneId: toOptionalString(bridge.paneId, null),
    profile: toOptionalString(bridge.profile, 'main').toLowerCase(),
  };
}

function pipeGenerationsEqual(left = {}, right = {}, platform = process.platform) {
  if (left.schema !== PIPE_GENERATION_SCHEMA || right.schema !== PIPE_GENERATION_SCHEMA) {
    return false;
  }
  return normalizePipePath(left.pipePath) === normalizePipePath(right.pipePath)
    && pathsEqual(left.configPath, right.configPath, platform)
    && pathsEqual(left.projectRoot, right.projectRoot, platform)
    && toOptionalString(left.paneId, null) === toOptionalString(right.paneId, null)
    && toOptionalString(left.profile, 'main').toLowerCase()
      === toOptionalString(right.profile, 'main').toLowerCase();
}

function isSupportedComputerUsePipePath(value) {
  const normalized = normalizePipePath(value);
  if (!normalized.startsWith(COMPUTER_USE_PIPE_PREFIX)) return false;
  const suffix = normalized.slice(COMPUTER_USE_PIPE_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(suffix);
}

function stripTomlComment(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return value.slice(0, index).trim();
  }
  return value.trim();
}

function parseTomlScalar(value) {
  const text = stripTomlComment(toOptionalString(value, ''));
  if (!text) return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function readTomlSectionAssignment(content, sectionName, key) {
  const source = toOptionalString(content, '');
  if (!source) return null;
  let inSection = false;
  for (const line of source.split(/\r?\n/u)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (header) {
      inSection = header[1].trim() === sectionName;
      continue;
    }
    if (!inSection) continue;
    const assignment = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/u);
    if (!assignment || assignment[1] !== key) continue;
    return parseTomlScalar(assignment[2]);
  }
  return null;
}

function resolveCodexHome(options = {}) {
  const env = options.env || process.env;
  const explicit = toOptionalString(options.codexHome || env.CODEX_HOME, null);
  if (explicit) return path.resolve(explicit);
  const home = toOptionalString(options.homeDir, null) || os.homedir();
  return path.join(home, '.codex');
}

function readCodexComputerUseConfig(options = {}) {
  const codexHome = resolveCodexHome(options);
  const configPath = path.resolve(options.configPath || path.join(codexHome, 'config.toml'));
  const readFile = options.readFile || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  let content;
  try {
    content = readFile(configPath);
  } catch (error) {
    return {
      ok: false,
      codexHome,
      configPath,
      reason: error?.code === 'ENOENT' ? 'codex_config_missing' : 'codex_config_unreadable',
      error: error?.message || String(error),
      pluginEnabled: false,
      nativePipeEnabled: false,
      pipePath: null,
    };
  }

  const pluginEnabled = readTomlSectionAssignment(
    content,
    COMPUTER_USE_PLUGIN_SECTION,
    'enabled'
  ) === true;
  const nativePipeEnabled = String(readTomlSectionAssignment(
    content,
    NODE_REPL_ENV_SECTION,
    'SKY_CUA_NATIVE_PIPE'
  ) || '') === '1';
  const pipePath = normalizePipePath(readTomlSectionAssignment(
    content,
    NODE_REPL_ENV_SECTION,
    'SKY_CUA_NATIVE_PIPE_DIRECTORY'
  ));

  return {
    ok: true,
    codexHome,
    configPath,
    pluginEnabled,
    nativePipeEnabled,
    pipePath: pipePath || null,
    pipePathSupported: isSupportedComputerUsePipePath(pipePath),
  };
}

function parseProcessRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  const text = toOptionalString(value, '');
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  } catch (_) {
    return [];
  }
}

function defaultExecFile(command, args, options = {}) {
  return new Promise((resolve) => {
    let spawned = false;
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        error: error || null,
        status: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
        spawned,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
    child.once('spawn', () => {
      spawned = true;
    });
  });
}

async function defaultListDesktopProcesses(options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    return { ok: false, reason: 'unsupported_platform', processes: [] };
  }
  const script = [
    "$rows = Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe' OR Name = 'chatgpt.exe'\" |",
    '  Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine',
    '$rows | ConvertTo-Json -Depth 4',
  ].join('\n');
  const runner = options.runner || defaultExecFile;
  const result = await runner('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: Number(options.processProbeTimeoutMs) || 5000,
    windowsHide: true,
  }) || {};
  if (result.error || (typeof result.status === 'number' && result.status !== 0)) {
    return {
      ok: false,
      reason: result.error?.code === 'ETIMEDOUT'
        ? 'desktop_owner_probe_timeout'
        : 'desktop_owner_probe_failed',
      error: result.error?.message || toOptionalString(result.stderr, null),
      processes: [],
    };
  }
  return {
    ok: true,
    processes: parseProcessRows(result.stdout),
  };
}

async function defaultLaunchCodexDesktopOwner(options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    return { ok: false, reason: 'unsupported_platform' };
  }
  const aumid = toOptionalString(options.aumid, CODEX_DESKTOP_AUMID);
  if (aumid !== CODEX_DESKTOP_AUMID) {
    return { ok: false, reason: 'codex_desktop_aumid_mismatch', aumid };
  }
  const command = 'explorer.exe';
  const args = [`shell:AppsFolder\\${CODEX_DESKTOP_AUMID}`];
  const runner = options.runner || defaultExecFile;
  try {
    const result = await runner(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }) || {};
    // explorer.exe hands shell:AppsFolder activation off asynchronously. Its
    // own exit status (including 1) is not AppX launch success/failure. Once
    // the exact allowlisted request was invoked, owner + pipe probes decide.
    const dispatchInvoked = result.spawned === true
      || result.ok === true
      || Number.isInteger(result.status);
    return {
      ok: dispatchInvoked,
      status: dispatchInvoked ? 'codex_desktop_owner_launch_requested' : 'blocked',
      reason: dispatchInvoked
        ? 'exact_codex_desktop_aumid_dispatch_invoked'
        : 'codex_desktop_aumid_launch_failed',
      command,
      args,
      aumid: CODEX_DESKTOP_AUMID,
      dispatchInvoked,
      exitStatus: typeof result.status === 'number' ? result.status : null,
      exitStatusAuthoritative: false,
      error: result.error?.message || result.error || null,
      stdout: toOptionalString(result.stdout, ''),
      stderr: toOptionalString(result.stderr, ''),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'codex_desktop_aumid_launch_failed',
      command,
      args,
      aumid: CODEX_DESKTOP_AUMID,
      error: error?.message || String(error),
    };
  }
}

async function defaultListBrowserPipes(options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    return { ok: false, reason: 'unsupported_platform', pipes: [] };
  }
  const script = [
    "$rows = Get-ChildItem -LiteralPath '\\\\.\\pipe\\' -ErrorAction Stop |",
    "  Where-Object { $_.Name -match 'browser|chrome|claude-mcp-browser' } |",
    '  Select-Object -ExpandProperty Name',
    '$rows | ConvertTo-Json',
  ].join('\n');
  const runner = options.runner || defaultExecFile;
  try {
    const result = await runner('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }) || {};
    if (result.error || (typeof result.status === 'number' && result.status !== 0)) {
      return {
        ok: false,
        reason: 'browser_pipe_snapshot_failed',
        pipes: [],
        error: result.error?.message || result.error || toOptionalString(result.stderr, null),
      };
    }
    const parsed = parseProcessRows(result.stdout);
    const pipes = parsed
      .flatMap((entry) => (typeof entry === 'string' ? [entry] : []))
      .filter(Boolean)
      .sort();
    return { ok: true, pipes };
  } catch (error) {
    return {
      ok: false,
      reason: 'browser_pipe_snapshot_failed',
      pipes: [],
      error: error?.message || String(error),
    };
  }
}

function defaultListComputerUsePipes(options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    return { ok: false, reason: 'unsupported_platform', pipes: [] };
  }
  const readdir = options.readdirPipes || (() => fs.readdirSync('\\\\.\\pipe\\'));
  try {
    const pipes = readdir()
      .map((entry) => normalizePipePath(`\\\\.\\pipe\\${entry}`))
      .filter((entry) => entry.startsWith(COMPUTER_USE_PIPE_PREFIX))
      .sort();
    return { ok: true, pipes };
  } catch (error) {
    return {
      ok: false,
      reason: 'computer_use_pipe_enumeration_failed',
      error: error?.message || String(error),
      pipes: [],
    };
  }
}

function isOfficialCodexBrowserPipeName(pipeName) {
  const name = toOptionalString(pipeName, '');
  const prefixes = ['codex-browser-use-', 'codex-browser-use\\'];
  const prefix = prefixes.find((candidate) => name.startsWith(candidate));
  if (!prefix) return false;
  const suffix = name.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    .test(suffix);
}

function browserPipeSnapshotTransitionAllowed(before = {}, after = {}) {
  if (before.ok !== true || after.ok !== true) return false;
  const existingPipes = Array.isArray(before.pipes) ? [...before.pipes] : [];
  const currentPipes = Array.isArray(after.pipes) ? [...after.pipes] : [];
  if (!existingPipes.every((pipeName) => typeof pipeName === 'string' && pipeName.length > 0)
    || !currentPipes.every((pipeName) => typeof pipeName === 'string' && pipeName.length > 0)) {
    return false;
  }

  const unmatchedCurrentPipes = [...currentPipes];
  for (const existingPipe of existingPipes) {
    const currentIndex = unmatchedCurrentPipes.indexOf(existingPipe);
    if (currentIndex < 0) return false;
    unmatchedCurrentPipes.splice(currentIndex, 1);
  }
  return unmatchedCurrentPipes.every(isOfficialCodexBrowserPipeName);
}

function processExecutableCandidate(processInfo = {}) {
  const executablePath = toOptionalString(
    processInfo.executablePath
      || processInfo.ExecutablePath
      || processInfo.path
      || processInfo.Path,
    null
  );
  if (executablePath) return executablePath;
  const commandLine = toOptionalString(
    processInfo.commandLine || processInfo.CommandLine,
    ''
  );
  const quoted = commandLine.match(/^\s*"([^"]+\.exe)"/iu);
  if (quoted) return quoted[1];
  return commandLine.split(/\s+/u)[0] || '';
}

function isOfficialCodexDesktopOwnerProcess(processInfo = {}) {
  const name = toOptionalString(processInfo.name || processInfo.Name, '').toLowerCase();
  if (name !== 'chatgpt.exe') return false;
  const executable = processExecutableCandidate(processInfo)
    .replace(/\//gu, '\\')
    .toLowerCase();
  return /\\program files\\windowsapps\\openai\.codex_[^\\]+__2p2nqsd0c76g0\\app\\chatgpt\.exe$/u
    .test(executable);
}

function normalizeProcessProbe(value) {
  if (Array.isArray(value)) return { ok: true, processes: value };
  if (value && typeof value === 'object') {
    return {
      ok: value.ok !== false,
      reason: value.reason || null,
      error: value.error || null,
      processes: parseProcessRows(value.processes),
    };
  }
  return { ok: false, reason: 'desktop_owner_probe_invalid', processes: [] };
}

function observedExactDesktopOwner(bridge) {
  return bridge?.desktopOwner?.probeOk === true
    && bridge.desktopOwner.running === true;
}

async function probeCodexComputerUseNativeBridge(options = {}) {
  const platform = toOptionalString(options.platform, process.platform);
  const env = options.env || process.env;
  const projectRoot = normalizePath(
    options.projectRoot || env.SQUIDRUN_PROJECT_ROOT || process.cwd()
  );
  const paneId = toOptionalString(options.paneId || env.SQUIDRUN_PANE_ID, null);
  const profile = toOptionalString(options.profile || env.SQUIDRUN_PROFILE, 'main').toLowerCase();
  const generatedAt = asIso(options.now);
  const config = readCodexComputerUseConfig({ ...options, env });

  if (platform !== 'win32') {
    return {
      ok: false,
      schema: BRIDGE_SCHEMA,
      version: 1,
      generatedAt,
      status: 'unsupported',
      reason: 'computer_use_native_bridge_is_windows_only',
      owner: 'codex_desktop',
      projectRoot,
      paneId,
      profile,
      config,
      pipeReady: false,
      newCodexPaneCanAttach: false,
    };
  }

  const listDesktopProcesses = options.listDesktopProcesses || defaultListDesktopProcesses;
  let processProbe;
  try {
    processProbe = normalizeProcessProbe(await listDesktopProcesses({ ...options, platform }));
  } catch (error) {
    processProbe = {
      ok: false,
      reason: 'desktop_owner_probe_failed',
      error: error?.message || String(error),
      processes: [],
    };
  }
  const ownerProcesses = processProbe.processes.filter(isOfficialCodexDesktopOwnerProcess);
  const pipeExists = options.pipeExists || fs.existsSync;
  let pipePresent = false;
  let pipeProbeError = null;
  if (config.pipePathSupported) {
    try {
      pipePresent = pipeExists(config.pipePath) === true;
    } catch (error) {
      pipeProbeError = error?.message || String(error);
    }
  }
  const listComputerUsePipes = options.listComputerUsePipes || defaultListComputerUsePipes;
  let computerUsePipeProbe;
  try {
    computerUsePipeProbe = await listComputerUsePipes({ ...options, platform }) || {};
  } catch (error) {
    computerUsePipeProbe = {
      ok: false,
      reason: 'computer_use_pipe_enumeration_failed',
      error: error?.message || String(error),
      pipes: [],
    };
  }
  const observedComputerUsePipes = Array.isArray(computerUsePipeProbe.pipes)
    ? computerUsePipeProbe.pipes.map(normalizePipePath).sort()
    : [];
  const exactPipeIsUnique = computerUsePipeProbe.ok === true
    && observedComputerUsePipes.length === 1
    && observedComputerUsePipes[0] === config.pipePath;

  let status = 'blocked';
  let reason = 'computer_use_native_bridge_not_ready';
  if (!config.ok) {
    reason = config.reason;
  } else if (!config.pluginEnabled) {
    reason = 'computer_use_plugin_disabled';
  } else if (!config.nativePipeEnabled) {
    reason = 'computer_use_native_pipe_disabled';
  } else if (!config.pipePathSupported) {
    reason = config.pipePath
      ? 'computer_use_pipe_path_unrecognized'
      : 'computer_use_pipe_path_missing';
  } else if (!processProbe.ok) {
    reason = processProbe.reason || 'desktop_owner_probe_unavailable';
  } else if (pipeProbeError) {
    reason = 'computer_use_pipe_probe_failed';
  } else if (pipePresent && ownerProcesses.length === 0) {
    reason = 'computer_use_pipe_has_no_exact_desktop_owner';
  } else if (pipePresent && computerUsePipeProbe.ok !== true) {
    reason = computerUsePipeProbe.reason || 'computer_use_pipe_enumeration_failed';
  } else if (pipePresent && !exactPipeIsUnique) {
    reason = 'computer_use_pipe_identity_ambiguous';
  } else if (!pipePresent && ownerProcesses.length === 0) {
    reason = 'codex_desktop_owner_not_running';
  } else if (!pipePresent) {
    status = 'waiting';
    reason = 'codex_desktop_pipe_not_ready';
  } else {
    status = 'ready';
    reason = 'exact_codex_desktop_pipe_ready';
  }

  const pipeReady = status === 'ready';
  const mainProfile = profile === '' || profile === 'main';
  return {
    ok: pipeReady,
    schema: BRIDGE_SCHEMA,
    version: 1,
    generatedAt,
    status,
    reason,
    owner: 'codex_desktop',
    projectRoot,
    paneId,
    profile,
    mainProfile,
    config,
    desktopOwner: {
      probeOk: processProbe.ok,
      reason: processProbe.reason || null,
      error: processProbe.error || null,
      running: ownerProcesses.length > 0,
      processes: ownerProcesses.map((processInfo) => ({
        pid: Number(processInfo.processId || processInfo.ProcessId) || null,
        parentPid: Number(processInfo.parentProcessId || processInfo.ParentProcessId) || null,
        executablePath: processExecutableCandidate(processInfo) || null,
      })),
    },
    pipe: {
      path: config.pipePath || null,
      pathSupported: config.pipePathSupported === true,
      present: pipePresent,
      probeError: pipeProbeError,
      enumerationOk: computerUsePipeProbe.ok === true,
      enumerationReason: computerUsePipeProbe.reason || null,
      enumerationError: computerUsePipeProbe.error || null,
      observedComputerUsePipes,
      exactPipeIsUnique,
    },
    pipeReady,
    newCodexPaneCanAttach: pipeReady,
    existingCodexPaneAttachmentProven: false,
    supportedContract: {
      squidrunStartsHelper: false,
      squidrunImplementsNativeProtocol: false,
      squidrunMutatesCodexConfig: false,
      exactDesktopAumidLaunchAllowed: true,
      codexDesktopAumid: CODEX_DESKTOP_AUMID,
      squidrunPaneOptInSetting: 'codexComputerUsePaneIds',
      squidrunPaneOptInDefault: [],
      desktopOwnsPipeServer: true,
      desktopOwnsHelperLifecycle: true,
      existingNodeReplPipeOverrideSupported: false,
      existingPaneRetargetFromModelCodeSupported: false,
      existingPaneRebindMethod: 'unresolved',
      verificationUsesOfficialPluginWrapper: true,
      verificationOperation: 'list_windows',
    },
    nextAction: pipeReady
      ? 'hold_for_supported_current_pane_rebind_or_new_pane_preflight_decision'
      : (mainProfile
        ? 'exact_codex_desktop_aumid_launch_available_but_not_run'
        : 'do_not_launch_from_non_main_profile'),
  };
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

async function readStableCodexComputerUsePipeGeneration(
  candidateBridge,
  probe,
  probeOptions,
  options = {}
) {
  const firstGeneration = captureCodexComputerUsePipeGeneration(candidateBridge);
  if (!firstGeneration) {
    return {
      ok: false,
      reason: 'computer_use_pipe_generation_not_ready',
      bridge: candidateBridge,
      generation: null,
    };
  }
  const sleep = options.sleep || defaultSleep;
  const intervalMs = boundedPositiveInteger(
    options.intervalMs,
    DEFAULT_PREPARE_INTERVAL_MS,
    25,
    2000
  );
  await sleep(intervalMs);
  const confirmedBridge = await probe(probeOptions);
  const confirmedGeneration = captureCodexComputerUsePipeGeneration(confirmedBridge);
  if (!confirmedGeneration
    || !pipeGenerationsEqual(
      firstGeneration,
      confirmedGeneration,
      probeOptions.platform || process.platform
    )) {
    return {
      ok: false,
      reason: 'computer_use_pipe_generation_unstable',
      bridge: confirmedBridge,
      generation: confirmedGeneration,
      previousGeneration: firstGeneration,
    };
  }
  return {
    ok: true,
    reason: 'computer_use_pipe_generation_stable',
    bridge: confirmedBridge,
    generation: confirmedGeneration,
    previousGeneration: firstGeneration,
  };
}

async function confirmCodexComputerUsePipeGeneration(
  expectedGeneration,
  input = {},
  dependencies = {}
) {
  const probe = dependencies.probe || probeCodexComputerUseNativeBridge;
  const bridge = await probe(input);
  const actualGeneration = captureCodexComputerUsePipeGeneration(bridge);
  const generationMatches = Boolean(
    actualGeneration
    && pipeGenerationsEqual(
      expectedGeneration,
      actualGeneration,
      input.platform || process.platform
    )
  );
  return {
    ok: generationMatches,
    schema: PIPE_GENERATION_SCHEMA,
    status: generationMatches ? 'ready' : 'blocked',
    reason: generationMatches
      ? 'computer_use_pipe_generation_confirmed'
      : (actualGeneration
        ? 'computer_use_pipe_generation_changed'
        : 'computer_use_pipe_generation_not_ready'),
    expectedGeneration: expectedGeneration || null,
    actualGeneration,
    bridge,
  };
}

async function prepareCodexComputerUseNativeBridge(input = {}, dependencies = {}) {
  const env = input.env || process.env;
  const platform = toOptionalString(input.platform, process.platform);
  const projectRoot = normalizePath(
    input.projectRoot || env.SQUIDRUN_PROJECT_ROOT || process.cwd()
  );
  const workspace = normalizePath(input.workspace || projectRoot);
  const profile = toOptionalString(input.profile || env.SQUIDRUN_PROFILE, 'main').toLowerCase();
  const paneId = toOptionalString(input.paneId || env.SQUIDRUN_PANE_ID, null);
  const probe = dependencies.probe || probeCodexComputerUseNativeBridge;
  const launchOwner = dependencies.launchOwner || ((launchInput) => (
    defaultLaunchCodexDesktopOwner({
      ...launchInput,
      platform,
      aumid: CODEX_DESKTOP_AUMID,
      runner: dependencies.runner,
    })
  ));
  const listBrowserPipes = dependencies.listBrowserPipes || ((snapshotInput) => (
    defaultListBrowserPipes({
      ...snapshotInput,
      platform,
      runner: dependencies.runner,
    })
  ));
  const sleep = dependencies.sleep || defaultSleep;
  const nowMs = dependencies.nowMs || Date.now;
  const timeoutMs = boundedPositiveInteger(
    input.timeoutMs,
    DEFAULT_PREPARE_TIMEOUT_MS,
    250,
    60000
  );
  const intervalMs = boundedPositiveInteger(
    input.intervalMs,
    DEFAULT_PREPARE_INTERVAL_MS,
    25,
    2000
  );
  const probeOptions = {
    ...input,
    env,
    platform,
    projectRoot,
    workspace,
    profile,
    paneId,
  };
  const snapshotBrowserPipes = async () => {
    try {
      const snapshot = await listBrowserPipes({ platform });
      return {
        ok: snapshot?.ok === true,
        reason: snapshot?.reason || null,
        error: snapshot?.error || null,
        pipes: Array.isArray(snapshot?.pipes) ? [...snapshot.pipes].sort() : [],
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'browser_pipe_snapshot_failed',
        error: error?.message || String(error),
        pipes: [],
      };
    }
  };

  if (platform !== 'win32') {
    return {
      ok: false,
      schema: BRIDGE_SCHEMA,
      status: 'unsupported',
      reason: 'computer_use_native_bridge_is_windows_only',
      workspace,
    };
  }
  if (profile !== '' && profile !== 'main') {
    return {
      ok: false,
      schema: BRIDGE_SCHEMA,
      status: 'blocked',
      reason: 'non_main_profile_owner_launch_refused',
      profile,
      workspace,
      projectRoot,
    };
  }
  if (!pathsEqual(workspace, projectRoot, platform)) {
    return {
      ok: false,
      schema: BRIDGE_SCHEMA,
      status: 'blocked',
      reason: 'workspace_root_mismatch',
      workspace,
      projectRoot,
    };
  }

  const initial = await probe(probeOptions);
  if (initial.pipeReady === true) {
    const stable = await readStableCodexComputerUsePipeGeneration(
      initial,
      probe,
      probeOptions,
      { sleep, intervalMs }
    );
    if (!stable.ok) {
      return {
        ok: false,
        schema: BRIDGE_SCHEMA,
        status: 'blocked',
        reason: stable.reason,
        ownerLaunchDispatched: false,
        ownerLaunched: observedExactDesktopOwner(stable.bridge),
        newCodexPanePreflightReady: false,
        existingPaneAttachmentProven: false,
        existingPaneRebindMethod: 'unresolved',
        targetPaneRestartRequired: null,
        listWindowsProofRequired: true,
        generation: stable.generation,
        previousGeneration: stable.previousGeneration || null,
        bridge: stable.bridge,
      };
    }
    const browserPipesBefore = await snapshotBrowserPipes();
    const browserPipesAfter = await snapshotBrowserPipes();
    if (!browserPipeSnapshotTransitionAllowed(browserPipesBefore, browserPipesAfter)) {
      return {
        ok: false,
        schema: BRIDGE_SCHEMA,
        status: 'blocked',
        reason: 'browser_pipe_snapshot_changed_during_preflight',
        ownerLaunchDispatched: false,
        ownerLaunched: observedExactDesktopOwner(stable.bridge),
        newCodexPanePreflightReady: false,
        generation: stable.generation,
        browserPipeSnapshot: {
          before: browserPipesBefore,
          after: browserPipesAfter,
          reSnapshotted: true,
        },
        bridge: stable.bridge,
      };
    }
    return {
      ok: true,
      schema: BRIDGE_SCHEMA,
      status: 'ready',
      reason: 'exact_codex_desktop_pipe_already_ready',
      ownerLaunchDispatched: false,
      ownerLaunched: observedExactDesktopOwner(stable.bridge),
      newCodexPanePreflightReady: true,
      existingPaneAttachmentProven: false,
      existingPaneRebindMethod: 'unresolved',
      targetPaneRestartRequired: null,
      listWindowsProofRequired: true,
      generation: stable.generation,
      browserPipeSnapshot: {
        before: browserPipesBefore,
        after: browserPipesAfter,
        reSnapshotted: true,
      },
      bridge: stable.bridge,
    };
  }
  const launchAuthorized = input.launchOwner === true;
  if (!launchAuthorized) {
    return {
      ok: false,
      schema: BRIDGE_SCHEMA,
      status: 'blocked',
      reason: 'explicit_codex_desktop_owner_launch_required',
      ownerLaunchDispatched: false,
      ownerLaunched: observedExactDesktopOwner(initial),
      newCodexPanePreflightReady: false,
      existingPaneAttachmentProven: false,
      existingPaneRebindMethod: 'unresolved',
      targetPaneRestartRequired: null,
      listWindowsProofRequired: true,
      bridge: initial,
    };
  }
  const browserPipesBefore = await snapshotBrowserPipes();
  if (input.dryRun === true) {
    return {
      ok: true,
      schema: BRIDGE_SCHEMA,
      status: 'dry_run',
      reason: 'exact_codex_desktop_aumid_launch_would_run',
      ownerLaunchDispatched: false,
      ownerLaunched: observedExactDesktopOwner(initial),
      wouldLaunchOwner: true,
      aumid: CODEX_DESKTOP_AUMID,
      workspace,
      newCodexPanePreflightWouldBeRequiredAfterLaunch: true,
      existingPaneAttachmentProven: false,
      existingPaneRebindMethod: 'unresolved',
      targetPaneRestartRequired: null,
      listWindowsProofRequired: true,
      browserPipeSnapshot: {
        before: browserPipesBefore,
        after: null,
        reSnapshotted: false,
      },
      bridge: initial,
    };
  }
  const launchResult = await launchOwner({
    aumid: CODEX_DESKTOP_AUMID,
  });
  if (launchResult?.ok !== true) {
    const browserPipesAfter = await snapshotBrowserPipes();
    return {
      ok: false,
      schema: BRIDGE_SCHEMA,
      status: 'blocked',
      reason: 'codex_desktop_owner_launch_failed',
      ownerLaunchDispatched: launchResult?.dispatchInvoked === true,
      ownerLaunched: observedExactDesktopOwner(initial),
      launchResult,
      browserPipeSnapshot: {
        before: browserPipesBefore,
        after: browserPipesAfter,
        reSnapshotted: true,
      },
      bridge: initial,
    };
  }

  const startedAt = nowMs();
  let latest = initial;
  do {
    await sleep(intervalMs);
    latest = await probe(probeOptions);
    if (latest.pipeReady === true) {
      const stable = await readStableCodexComputerUsePipeGeneration(
        latest,
        probe,
        probeOptions,
        { sleep, intervalMs }
      );
      latest = stable.bridge;
      if (!stable.ok) {
        continue;
      }
      const browserPipesAfter = await snapshotBrowserPipes();
      if (!browserPipeSnapshotTransitionAllowed(browserPipesBefore, browserPipesAfter)) {
        return {
          ok: false,
          schema: BRIDGE_SCHEMA,
          status: 'blocked',
          reason: 'browser_pipe_snapshot_changed_during_preflight',
          ownerLaunchDispatched: true,
          ownerLaunched: observedExactDesktopOwner(stable.bridge),
          launchResult,
          newCodexPanePreflightReady: false,
          generation: stable.generation,
          browserPipeSnapshot: {
            before: browserPipesBefore,
            after: browserPipesAfter,
            reSnapshotted: true,
          },
          bridge: stable.bridge,
        };
      }
      return {
        ok: true,
        schema: BRIDGE_SCHEMA,
        status: 'ready',
        reason: 'codex_desktop_owner_launched_and_exact_pipe_ready',
        ownerLaunchDispatched: true,
        ownerLaunched: observedExactDesktopOwner(stable.bridge),
        launchResult,
        newCodexPanePreflightReady: true,
        existingPaneAttachmentProven: false,
        existingPaneRebindMethod: 'unresolved',
        targetPaneRestartRequired: null,
        listWindowsProofRequired: true,
        generation: stable.generation,
        browserPipeSnapshot: {
          before: browserPipesBefore,
          after: browserPipesAfter,
          reSnapshotted: true,
        },
        bridge: latest,
      };
    }
  } while ((nowMs() - startedAt) < timeoutMs);

  const browserPipesAfter = await snapshotBrowserPipes();
  return {
    ok: false,
    schema: BRIDGE_SCHEMA,
    status: 'blocked',
    reason: 'codex_desktop_pipe_ready_timeout',
    ownerLaunchDispatched: true,
    ownerLaunched: observedExactDesktopOwner(latest),
    launchResult,
    newCodexPanePreflightReady: false,
    existingPaneAttachmentProven: false,
    existingPaneRebindMethod: 'unresolved',
    targetPaneRestartRequired: null,
    listWindowsProofRequired: true,
    browserPipeSnapshot: {
      before: browserPipesBefore,
      after: browserPipesAfter,
      reSnapshotted: true,
    },
    bridge: latest,
    timeoutMs,
  };
}

function resolveOfficialComputerUseClientPath(options = {}) {
  const codexHome = resolveCodexHome(options);
  const pluginRoot = path.join(
    codexHome,
    'plugins',
    'cache',
    'openai-bundled',
    'computer-use'
  );
  const readdir = options.readdir || ((dirPath) => fs.readdirSync(dirPath, {
    withFileTypes: true,
  }));
  const pathExists = options.pathExists || fs.existsSync;
  let entries;
  try {
    entries = readdir(pluginRoot);
  } catch (_) {
    return null;
  }
  const versions = entries
    .filter((entry) => typeof entry === 'string' || entry?.isDirectory?.())
    .map((entry) => (typeof entry === 'string' ? entry : entry.name))
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left, undefined, {
      numeric: true,
      sensitivity: 'base',
    }));
  for (const version of versions) {
    const clientPath = path.join(
      pluginRoot,
      version,
      'scripts',
      'computer-use-client.mjs'
    );
    if (pathExists(clientPath)) return clientPath;
  }
  return null;
}

function validateTrustedListWindowsClaim(trustedClaim, bridge, options = {}) {
  const projectRoot = normalizePath(
    options.projectRoot || bridge?.projectRoot || process.cwd()
  );
  const paneId = toOptionalString(options.paneId || bridge?.paneId, null);
  const platform = options.platform || process.platform;
  const currentGeneration = captureCodexComputerUsePipeGeneration(bridge);
  const reasons = [];
  if (!trustedClaim || typeof trustedClaim !== 'object') {
    reasons.push('trusted_generation_claim_missing');
  } else {
    if (!toOptionalString(trustedClaim.claimId, null)) {
      reasons.push('trusted_generation_claim_id_missing');
    }
    if (!toOptionalString(trustedClaim.commandAuthorizedAt, null)) {
      reasons.push('trusted_generation_command_not_authorized');
    }
    if (!toOptionalString(trustedClaim.postSpawnConfirmedAt, null)) {
      reasons.push('trusted_generation_post_spawn_not_confirmed');
    }
    if (paneId && toOptionalString(trustedClaim.paneId, null) !== paneId) {
      reasons.push('trusted_generation_pane_mismatch');
    }
    if (!pathsEqual(trustedClaim.workspace, projectRoot, platform)
      || !pathsEqual(trustedClaim.projectRoot, projectRoot, platform)) {
      reasons.push('trusted_generation_workspace_mismatch');
    }
    if (!currentGeneration
      || !pipeGenerationsEqual(trustedClaim.generation, currentGeneration, platform)) {
      reasons.push('trusted_generation_claim_stale');
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
    projectRoot,
    paneId,
    currentGeneration,
  };
}

function buildOfficialListWindowsVerification(options = {}) {
  const bridge = options.bridge || {};
  const platform = options.platform || process.platform;
  const projectRoot = normalizePath(
    options.projectRoot || bridge.projectRoot || process.cwd()
  );
  const paneId = toOptionalString(options.paneId || bridge.paneId, null);
  const trustedClaim = options.trustedClaim || null;
  const claimValidation = validateTrustedListWindowsClaim(
    trustedClaim,
    bridge,
    { ...options, projectRoot, paneId }
  );
  if (!claimValidation.ok) {
    return {
      ok: false,
      schema: LIST_WINDOWS_PROOF_SCHEMA,
      reason: claimValidation.reasons[0],
      reasons: claimValidation.reasons,
    };
  }
  const proof = trustedClaim?.proof || null;
  const boundPlan = proof?.canonicalPlan || null;
  if (!proof || proof.state !== 'armed' || !boundPlan?.toolInputJson) {
    return {
      ok: false,
      schema: LIST_WINDOWS_PROOF_SCHEMA,
      reason: 'codex_computer_use_proof_attestation_not_armed',
    };
  }
  const clientPath = options.clientPath || proof.officialClientPath;
  if (!clientPath || !pathsEqual(clientPath, proof.officialClientPath, platform)) {
    return {
      ok: false,
      schema: LIST_WINDOWS_PROOF_SCHEMA,
      reason: 'official_computer_use_client_binding_mismatch',
    };
  }
  try {
    if (sha256File(clientPath) !== proof.officialClientSha256) {
      return {
        ok: false,
        schema: LIST_WINDOWS_PROOF_SCHEMA,
        reason: 'official_computer_use_client_drift',
      };
    }
  } catch (error) {
    return {
      ok: false,
      schema: LIST_WINDOWS_PROOF_SCHEMA,
      reason: 'official_computer_use_client_unreadable',
      error: error?.message || String(error),
    };
  }
  if (bridge.pipeReady !== true && options.allowNotReady !== true) {
    return {
      ok: false,
      schema: LIST_WINDOWS_PROOF_SCHEMA,
      reason: 'exact_codex_desktop_pipe_not_ready',
      bridge,
    };
  }

  return {
    ok: true,
    schema: boundPlan.schema,
    operation: 'list_windows',
    transport: 'official_computer_use_plugin_wrapper',
    clientPath,
    clientSha256: proof.officialClientSha256,
    expectedProjectRoot: projectRoot,
    expectedPaneId: paneId,
    expectedGeneration: trustedClaim.generation,
    trustedClaimId: trustedClaim.claimId,
    snippet: boundPlan.snippet,
    prompt: boundPlan.prompt,
    toolInputSha256: boundPlan.toolInputSha256,
    nonClaims: [
      'does_not_spawn_codex_computer_use_helper',
      'does_not_implement_native_pipe_protocol',
      'does_not_override_the_privileged_node_repl_pipe',
      'does_not_restart_or_kill_preexisting_squidrun_panes',
      'does_not_touch_browser_or_chrome_backends',
    ],
  };
}

function verifyOfficialListWindowsProof(proof = {}, options = {}) {
  return {
    ok: false,
    schema: LIST_WINDOWS_PROOF_SCHEMA,
    status: 'blocked',
    reason: 'renderer_supplied_computer_use_proof_refused',
    reasons: ['renderer_supplied_computer_use_proof_refused'],
    projectRoot: normalizePath(options.projectRoot || process.cwd()),
    paneId: toOptionalString(options.paneId, null),
    trustedClaimId: options.trustedClaim?.claimId || null,
    operation: 'list_windows',
    windowCount: null,
    untrustedFields: Object.keys(proof || {}).sort(),
  };
}

module.exports = {
  BRIDGE_SCHEMA,
  browserPipeSnapshotTransitionAllowed,
  CODEX_DESKTOP_AUMID,
  COMPUTER_USE_PIPE_PREFIX,
  DEFAULT_PREPARE_INTERVAL_MS,
  DEFAULT_PREPARE_TIMEOUT_MS,
  LIST_WINDOWS_PROOF_SCHEMA,
  PIPE_GENERATION_SCHEMA,
  buildOfficialListWindowsVerification,
  captureCodexComputerUsePipeGeneration,
  confirmCodexComputerUsePipeGeneration,
  defaultLaunchCodexDesktopOwner,
  defaultListBrowserPipes,
  defaultListComputerUsePipes,
  defaultListDesktopProcesses,
  isOfficialCodexBrowserPipeName,
  isOfficialCodexDesktopOwnerProcess,
  isSupportedComputerUsePipePath,
  pathsEqual,
  pipeGenerationsEqual,
  prepareCodexComputerUseNativeBridge,
  probeCodexComputerUseNativeBridge,
  readStableCodexComputerUsePipeGeneration,
  readCodexComputerUseConfig,
  readTomlSectionAssignment,
  resolveCodexHome,
  resolveOfficialComputerUseClientPath,
  verifyOfficialListWindowsProof,
};
