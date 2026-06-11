#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const { getProjectRoot } = require('../config');

const DEFAULT_INSTANCE_ID = 'james-main';
const PREFLIGHT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_RELAUNCH_VERIFY_TIMEOUT_MS = 60_000;
const DEFAULT_RELAUNCH_VERIFY_POLL_MS = 500;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    instance: DEFAULT_INSTANCE_ID,
    reason: '',
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--instance' && argv[index + 1]) {
      args.instance = String(argv[index + 1]).trim() || DEFAULT_INSTANCE_ID;
      index += 1;
      continue;
    }
    if (token === '--reason' && argv[index + 1]) {
      args.reason = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (token === '--json') {
      args.json = true;
    }
    if (token === '--sweep-orphans') {
      args.sweepOrphans = true;
    }
    if (token === '--verify-timeout-ms' && argv[index + 1]) {
      args.relaunchVerifyTimeoutMs = Number(argv[index + 1]);
      index += 1;
    }
  }
  if (!args.reason) {
    throw new Error('Missing required --reason <text>');
  }
  return args;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendJsonLine(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findInstance(registry = {}, instanceId = DEFAULT_INSTANCE_ID) {
  const entries = Array.isArray(registry?.instances) ? registry.instances : [];
  return entries.find((entry) => String(entry?.id || '') === instanceId) || null;
}

function resolveProjectPath(projectRoot, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function hasOperatorRegistry(projectRoot) {
  if (!projectRoot) return false;
  return fs.existsSync(path.join(projectRoot, '.squidrun', 'operator-registry.json'))
    || fs.existsSync(path.join(projectRoot, '.squidrun', 'operator-registry.template.json'));
}

function pushUniquePath(paths, value) {
  const raw = String(value || '').trim();
  if (!raw) return;
  const resolved = path.resolve(raw);
  const key = normalizeForProcessMatch(resolved);
  if (paths.some((entry) => normalizeForProcessMatch(entry) === key)) return;
  paths.push(resolved);
}

function collectAncestorPaths(startPath) {
  const paths = [];
  let current = path.resolve(startPath || process.cwd());
  while (current && !paths.includes(current)) {
    paths.push(current);
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return paths;
}

function resolveRegistryProjectRoot(projectRoot) {
  const callerProjectRoot = path.resolve(projectRoot || getProjectRoot());
  const candidates = [];
  pushUniquePath(candidates, callerProjectRoot);
  const link = readJson(path.join(callerProjectRoot, '.squidrun', 'link.json'), {});
  pushUniquePath(candidates, link?.squidrun_root);
  pushUniquePath(candidates, path.resolve(__dirname, '..', '..'));
  for (const candidate of collectAncestorPaths(callerProjectRoot)) pushUniquePath(candidates, candidate);
  for (const candidate of collectAncestorPaths(__dirname)) pushUniquePath(candidates, candidate);
  return candidates.find((candidate) => hasOperatorRegistry(candidate)) || callerProjectRoot;
}

function inferProfileFromInstance(instance = {}, instanceId = '') {
  const explicit = String(instance.profile || instance.profileName || '').trim();
  if (explicit) return explicit;
  const id = String(instance.id || instanceId || '').trim();
  if (!id || id === DEFAULT_INSTANCE_ID || id.includes('main')) return 'main';
  return id.replace(/^client[-_]/i, '').replace(/^profile[-_]/i, '') || id;
}

function isMainProfileName(profile = '') {
  const normalized = String(profile || '').trim().toLowerCase();
  return !normalized || normalized === 'main' || normalized === 'james-main';
}

function inferProfileWorkspaceRoot(callerProjectRoot, registryRoot, instance = {}, profile = '') {
  const candidates = [];
  const normalizedProfile = String(profile || '').trim();
  const caller = path.resolve(callerProjectRoot || registryRoot);
  const callerNormalized = normalizeForProcessMatch(caller);
  if (
    normalizedProfile
    && callerNormalized.includes(`/.squidrun/profiles/${normalizeForProcessMatch(normalizedProfile)}/workspace`)
  ) {
    pushUniquePath(candidates, caller);
  }
  const link = readJson(path.join(caller, '.squidrun', 'link.json'), {});
  pushUniquePath(candidates, link?.workspace);
  if (normalizedProfile && !isMainProfileName(normalizedProfile)) {
    pushUniquePath(candidates, path.join(registryRoot, '.squidrun', 'profiles', normalizedProfile, 'workspace'));
  }
  pushUniquePath(candidates, instance.rootPath);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || null;
}

function pathFreshnessMs(filePath) {
  const status = readJson(filePath, null);
  const timestampMs = statusTimestampMs(status || {});
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  return {
    path: filePath,
    exists: Boolean(status && typeof status === 'object'),
    timestampMs,
    mtimeMs,
    freshnessMs: Math.max(
      Number.isFinite(timestampMs) ? timestampMs : 0,
      Number.isFinite(mtimeMs) ? mtimeMs : 0
    ),
  };
}

function resolveInstanceAppStatusPath(registryRoot, profileWorkspaceRoot, instance = {}, profile = '') {
  const relPath = instance.appStatusPath || '.squidrun/app-status.json';
  const candidates = [];
  pushUniquePath(candidates, resolveProjectPath(registryRoot, relPath));
  if (profileWorkspaceRoot && !isMainProfileName(profile)) {
    pushUniquePath(candidates, resolveProjectPath(profileWorkspaceRoot, relPath));
    pushUniquePath(candidates, path.join(profileWorkspaceRoot, '.squidrun', `app-status-${profile}.json`));
  }
  const snapshots = candidates.map(pathFreshnessMs);
  const existing = snapshots.filter((candidate) => candidate.exists);
  const selected = (existing.length > 0 ? existing : snapshots)
    .sort((left, right) => right.freshnessMs - left.freshnessMs)[0];
  return {
    appStatusPath: selected?.path || resolveProjectPath(registryRoot, relPath),
    appStatusCandidates: snapshots,
  };
}

function loadInstanceConfig(projectRoot, instanceId = DEFAULT_INSTANCE_ID) {
  const callerProjectRoot = path.resolve(projectRoot || getProjectRoot());
  const registryRoot = resolveRegistryProjectRoot(callerProjectRoot);
  const livePath = path.join(registryRoot, '.squidrun', 'operator-registry.json');
  const templatePath = path.join(registryRoot, '.squidrun', 'operator-registry.template.json');
  const live = readJson(livePath, {});
  const template = readJson(templatePath, {});
  const templateInstance = findInstance(template, instanceId) || {};
  const liveInstance = findInstance(live, instanceId) || {};
  const merged = {
    ...templateInstance,
    ...liveInstance,
    notifyPolicy: {
      ...(templateInstance.notifyPolicy || {}),
      ...(liveInstance.notifyPolicy || {}),
    },
    launchCommand: {
      ...(templateInstance.launchCommand || {}),
      ...(liveInstance.launchCommand || {}),
    },
  };
  if (!merged.id) throw new Error(`Operator registry instance not found: ${instanceId}`);
  const profile = inferProfileFromInstance(merged, instanceId);
  const profileWorkspaceRoot = inferProfileWorkspaceRoot(callerProjectRoot, registryRoot, merged, profile);
  const statusPathResolution = resolveInstanceAppStatusPath(registryRoot, profileWorkspaceRoot, merged, profile);
  return {
    id: merged.id,
    profile,
    instance: merged,
    callerProjectRoot,
    registryRoot,
    profileWorkspaceRoot,
    coordPath: resolveProjectPath(registryRoot, merged.coordPath || '.squidrun/coord'),
    architectInboxPath: resolveProjectPath(registryRoot, merged.architectInbox || '.squidrun/coord/architect-inbox.jsonl'),
    appStatusPath: statusPathResolution.appStatusPath,
    appStatusCandidates: statusPathResolution.appStatusCandidates,
    launchCommand: merged.launchCommand,
  };
}

function resolveMessageTimeMs(message = {}) {
  const value = message.timestampUtc || message.createdAt || message.checkedAt || message.ts || null;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isGreenPreflightMessage(message = {}, instanceId = DEFAULT_INSTANCE_ID) {
  if (message.instance && String(message.instance) !== instanceId) return false;
  if (message.type === 'preflight_result') {
    const status = String(message.status || '').trim().toLowerCase();
    return status === 'approved' || status === 'green';
  }
  if (message.type === 'audit_grade') {
    const grade = String(message.grade || '').trim().toLowerCase();
    const status = String(message.status || '').trim().toLowerCase();
    return grade === 'green' || status.startsWith('cleared');
  }
  if (message.type === 'restart_preflight') {
    const grade = String(message.grade || message.status || '').trim().toLowerCase();
    return grade === 'green' || grade === 'approved';
  }
  return false;
}

function findLatestGreenPreflight(instanceConfig, instanceId = DEFAULT_INSTANCE_ID, nowMs = Date.now()) {
  const messages = readJsonLines(instanceConfig.architectInboxPath)
    .filter((message) => isGreenPreflightMessage(message, instanceId))
    .map((message) => ({ message, atMs: resolveMessageTimeMs(message) }))
    .filter((entry) => Number.isFinite(entry.atMs))
    .sort((left, right) => right.atMs - left.atMs);
  const latest = messages[0] || null;
  if (!latest) {
    return { ok: false, reason: 'missing_green_preflight', latest: null };
  }
  const ageMs = nowMs - latest.atMs;
  if (ageMs > PREFLIGHT_MAX_AGE_MS) {
    return {
      ok: false,
      reason: 'stale_green_preflight',
      latest: latest.message,
      ageMs,
      maxAgeMs: PREFLIGHT_MAX_AGE_MS,
    };
  }
  if (ageMs < -60_000) {
    return {
      ok: false,
      reason: 'future_green_preflight',
      latest: latest.message,
      ageMs,
    };
  }
  return {
    ok: true,
    latest: latest.message,
    ageMs,
    maxAgeMs: PREFLIGHT_MAX_AGE_MS,
  };
}

function parseCommandLine(commandLine = '') {
  const text = String(commandLine || '').trim();
  if (!text) return null;
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) return null;
  return {
    command: tokens[0],
    args: tokens.slice(1),
  };
}

function hasLaunchCommand(launchCommand = {}) {
  return Boolean(String(launchCommand?.command || '').trim());
}

function getInstanceId(instanceConfig = {}) {
  return String(instanceConfig.id || instanceConfig.instance?.id || DEFAULT_INSTANCE_ID).trim() || DEFAULT_INSTANCE_ID;
}

function getInstanceProfile(instanceConfig = {}) {
  return inferProfileFromInstance(instanceConfig.instance || instanceConfig, getInstanceId(instanceConfig));
}

function buildRequiredInstanceEnv(projectRoot, instanceConfig = {}) {
  const profile = getInstanceProfile(instanceConfig);
  const effectiveProjectRoot = !isMainProfileName(profile) && instanceConfig.profileWorkspaceRoot
    ? instanceConfig.profileWorkspaceRoot
    : (instanceConfig.callerProjectRoot || instanceConfig.registryRoot || projectRoot);
  return {
    SQUIDRUN_INSTANCE_ID: getInstanceId(instanceConfig),
    SQUIDRUN_PROFILE: profile,
    SQUIDRUN_WINDOW_KEY: profile,
    SQUIDRUN_PROJECT_ROOT: effectiveProjectRoot,
    SQUIDRUN_APP_STATUS_PATH: instanceConfig.appStatusPath || '',
  };
}

function envToText(env = {}) {
  if (!env || typeof env !== 'object') return '';
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function sourceHasInstanceMarker(source = {}, instanceConfig = {}) {
  if (source.instanceAttributed) return true;
  const profile = getInstanceProfile(instanceConfig);
  const text = normalizeForProcessMatch([
    source.commandLine,
    source.cwd,
    envToText(source.env),
  ].filter(Boolean).join(' '));
  if (!text) return false;
  if (isMainProfileName(profile)) {
    return !/\s--profile=(?!main\b)[^\s"]+/i.test(` ${text}`)
      && !text.includes('/squidrun-ui/');
  }
  const normalizedProfile = normalizeForProcessMatch(profile);
  return text.includes(`--profile=${normalizedProfile}`)
    || text.includes(`--profile ${normalizedProfile}`)
    || text.includes(`--window=${normalizedProfile}`)
    || text.includes(`--window ${normalizedProfile}`)
    || text.includes(`/squidrun-ui/${normalizedProfile}`)
    || text.includes(`runtime-${normalizedProfile}`)
    || text.includes(`settings-${normalizedProfile}`)
    || text.includes(getInstanceId(instanceConfig).toLowerCase());
}

function defaultLaunchCommand(projectRoot, instanceConfig, relaunchSource = null) {
  const appStatus = readJson(instanceConfig.appStatusPath, {});
  if (hasLaunchCommand(instanceConfig.launchCommand)) {
    const cwd = instanceConfig.launchCommand?.cwd
      || appStatus?.settingsPersistence?.cwd
      || path.join(projectRoot, 'ui');
    const args = Array.isArray(instanceConfig.launchCommand?.args)
      ? instanceConfig.launchCommand.args
      : [];
    return {
      command: instanceConfig.launchCommand.command,
      args,
      cwd: resolveProjectPath(projectRoot, cwd),
      env: {
        ...(instanceConfig.launchCommand?.env || {}),
        ...buildRequiredInstanceEnv(projectRoot, instanceConfig),
      },
    };
  }

  if (relaunchSource?.commandLine && sourceHasInstanceMarker(relaunchSource, instanceConfig)) {
    const parsed = parseCommandLine(relaunchSource.commandLine);
    if (parsed?.command) {
      return {
        command: parsed.command,
        args: parsed.args,
        cwd: relaunchSource.cwd
          || appStatus?.settingsPersistence?.cwd
          || path.join(projectRoot, 'ui'),
        env: {
          ...(relaunchSource.env || {}),
          ...buildRequiredInstanceEnv(projectRoot, instanceConfig),
        },
      };
    }
  }

  if (!isMainProfileName(getInstanceProfile(instanceConfig))) {
    const error = new Error('Missing instance-attributed launch command for side-profile relaunch');
    error.code = 'MISSING_INSTANCE_LAUNCH_CONTEXT';
    throw error;
  }

  const cwd = appStatus?.settingsPersistence?.cwd || path.join(projectRoot, 'ui');
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['start'],
    cwd: resolveProjectPath(projectRoot, cwd),
    env: buildRequiredInstanceEnv(projectRoot, instanceConfig),
  };
}

function normalizeForProcessMatch(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function asProcessRow(raw = {}) {
  const pid = Number(raw.ProcessId ?? raw.PID ?? raw.pid);
  const parentPid = Number(raw.ParentProcessId ?? raw.ParentPID ?? raw.parentPid);
  const env = raw.Environment || raw.Env || raw.env || null;
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
    name: raw.Name || raw['Image Name'] || raw.ImageName || raw.name || null,
    executablePath: raw.ExecutablePath || raw.Path || raw.executablePath || null,
    commandLine: raw.CommandLine || raw.commandLine || null,
    windowTitle: raw.WindowTitle || raw['Window Title'] || raw.windowTitle || null,
    cwd: raw.Cwd || raw.cwd || raw.CurrentDirectory || raw.currentDirectory || null,
    env: env && typeof env === 'object' && !Array.isArray(env) ? { ...env } : null,
  };
}

function parseCsvLine(line = '') {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
}

function parseTasklistCsv(output = '') {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] || '';
      return row;
    }, {});
  });
}

function queryWindowsProcessRows(projectRoot, options = {}) {
  if (Array.isArray(options.processRows)) return options.processRows;
  if (typeof options.tasklistOutput === 'string') return parseTasklistCsv(options.tasklistOutput);
  const script = [
    '$items = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine',
    '$items | ConvertTo-Json -Depth 3',
  ].join('; ');
  try {
    const stdout = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function processText(row = {}) {
  return [
    row.name,
    row.executablePath,
    row.commandLine,
    row.windowTitle,
  ].map((value) => normalizeForProcessMatch(value)).join(' ');
}

function isElectronProcess(row = {}) {
  const name = normalizeForProcessMatch(row.name);
  const executablePath = normalizeForProcessMatch(row.executablePath);
  return (
    name.includes('electron')
    || name.includes('squidrun')
    || executablePath.includes('electron')
    || executablePath.includes('squidrun')
  );
}

function isPrimaryElectronProcess(row = {}, options = {}) {
  if (!isElectronProcess(row)) return false;
  const commandLine = normalizeForProcessMatch(row.commandLine);
  const windowTitle = normalizeForProcessMatch(row.windowTitle);
  if (!commandLine) {
    return !windowTitle || (windowTitle !== 'n/a' && windowTitle.includes('squidrun'));
  }
  if (commandLine.includes(' --type=')) return false;
  if (commandLine.includes('/modules/')) return false;
  if (commandLine.includes('--standalone-window') && !options.allowStandalone) return false;
  return true;
}

function isProjectRelatedProcess(row = {}, projectRoot = '') {
  const text = processText(row);
  const root = normalizeForProcessMatch(projectRoot);
  return Boolean(
    (root && text.includes(root))
    || text.includes('/squidrun/')
    || text.includes('squidrun-ui')
    || text.includes('squidrun')
  );
}

function processSummary(row = {}, matchReason = null, extra = {}) {
  return {
    pid: row.pid,
    parentPid: row.parentPid,
    name: row.name,
    executablePath: row.executablePath,
    commandLine: row.commandLine,
    windowTitle: row.windowTitle,
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.env ? { env: row.env } : {}),
    ...(matchReason ? { matchReason } : {}),
    ...extra,
  };
}

function selectLegacySquidRunElectronProcesses(projectRoot, rawRows = []) {
  const rows = rawRows.map(asProcessRow).filter((row) => row.pid);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const selected = new Map();
  const select = (row, matchReason) => {
    if (!row || !row.pid || !isPrimaryElectronProcess(row)) return;
    if (selected.has(row.pid)) return;
    selected.set(row.pid, processSummary(row, matchReason));
  };

  for (const row of rows) {
    if (isPrimaryElectronProcess(row) && isProjectRelatedProcess(row, projectRoot)) {
      select(row, 'direct_project_match');
    }
  }

  for (const row of rows) {
    if (!isProjectRelatedProcess(row, projectRoot)) continue;
    let parent = byPid.get(row.parentPid);
    const seen = new Set([row.pid]);
    while (parent && !seen.has(parent.pid)) {
      if (isElectronProcess(parent)) {
        select(parent, 'project_descendant_parent');
        break;
      }
      seen.add(parent.pid);
      parent = byPid.get(parent.parentPid);
    }
  }

  return Array.from(selected.values()).sort((left, right) => left.pid - right.pid);
}

function includesExactPathMarker(text, marker) {
  const normalizedText = normalizeForProcessMatch(text);
  const normalizedMarker = normalizeForProcessMatch(marker).replace(/\/+$/, '');
  if (!normalizedText || !normalizedMarker) return false;
  let index = normalizedText.indexOf(normalizedMarker);
  while (index !== -1) {
    const after = normalizedText[index + normalizedMarker.length] || '';
    if (!after || /[\s"';&|)]/.test(after)) return true;
    index = normalizedText.indexOf(normalizedMarker, index + 1);
  }
  return false;
}

function collectInstanceMarkerSources(instanceConfig = {}) {
  const profile = getInstanceProfile(instanceConfig);
  const status = instanceConfig.appStatus || readJson(instanceConfig.appStatusPath, {}) || {};
  const settings = status?.settingsPersistence || {};
  const markers = [];
  const add = (source, value, exactPath = false) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    markers.push({ source, value: raw, exactPath });
  };

  if (isMainProfileName(profile)) {
    add('profile_arg', '--profile=main');
    add('window_arg', '--window=main');
    add('main_runtime_path', '/.squidrun/runtime/');
  } else {
    add('profile_arg', `--profile=${profile}`);
    add('profile_arg', `--profile ${profile}`);
    add('window_arg', `--window=${profile}`);
    add('window_arg', `--window ${profile}`);
    add('profile_runtime_path', `runtime-${profile}`);
    add('profile_settings_path', `settings-${profile}`);
    add('profile_app_status_path', `app-status-${profile}.json`);
  }

  add('user_data_path', settings.userDataPath, true);
  add('app_status_user_data', instanceConfig.userDataPath, true);
  add('app_status_path', instanceConfig.appStatusPath, true);
  add('settings_path', settings.settingsPath, true);

  const instance = instanceConfig.instance || {};
  for (const relPath of instance.allowedRuntimePaths || []) {
    add('allowed_runtime_path', relPath, false);
    if (instanceConfig.registryRoot) add('allowed_runtime_path', resolveProjectPath(instanceConfig.registryRoot, relPath), true);
    if (instanceConfig.profileWorkspaceRoot) add('allowed_runtime_path', resolveProjectPath(instanceConfig.profileWorkspaceRoot, relPath), true);
  }
  add('instance_id', getInstanceId(instanceConfig));
  return markers;
}

function processTreeText(row = {}, descendants = []) {
  return [row, ...descendants]
    .map((item) => processText(item))
    .join(' ');
}

function classifyInstanceProcess(row, descendants, projectRoot, instanceConfig) {
  const profile = getInstanceProfile(instanceConfig);
  const treeText = processTreeText(row, descendants);
  const normalizedTreeText = normalizeForProcessMatch(treeText);
  const status = instanceConfig.appStatus || readJson(instanceConfig.appStatusPath, {}) || {};
  const statusPid = statusPidValue(status);
  if (statusPid && statusPid === row.pid) {
    return { matched: true, reason: 'instance_app_status_pid' };
  }

  const markers = collectInstanceMarkerSources(instanceConfig);
  for (const marker of markers) {
    const matched = marker.exactPath
      ? includesExactPathMarker(treeText, marker.value)
      : normalizedTreeText.includes(normalizeForProcessMatch(marker.value));
    if (matched) {
      return { matched: true, reason: `instance_${marker.source}` };
    }
  }

  if (isMainProfileName(profile)) {
    const settings = status?.settingsPersistence || {};
    if (settings.userDataPath && includesExactPathMarker(treeText, settings.userDataPath)) {
      return { matched: true, reason: 'instance_user_data_path' };
    }
    if (!normalizedTreeText.includes('--profile=') && !normalizedTreeText.includes('/squidrun-ui/')) {
      return { matched: true, reason: 'instance_main_default' };
    }
  }

  if (isProjectRelatedProcess(row, projectRoot)) {
    return { matched: false, ambiguous: true, reason: 'project_match_without_instance' };
  }
  return { matched: false, ambiguous: false, reason: 'not_project_related' };
}

function selectInstanceSquidRunElectronProcesses(projectRoot, rawRows = [], instanceConfig = {}) {
  const rows = rawRows.map(asProcessRow).filter((row) => row.pid);
  const selected = new Map();
  const ambiguous = [];

  for (const row of rows) {
    const descendants = collectProcessDescendants(row.pid, rows);
    const allowStandalone = !isMainProfileName(getInstanceProfile(instanceConfig));
    if (!isPrimaryElectronProcess(row, { allowStandalone })) continue;
    if (!isProjectRelatedProcess(row, projectRoot) && descendants.every((child) => !isProjectRelatedProcess(child, projectRoot))) {
      continue;
    }
    const classification = classifyInstanceProcess(row, descendants, projectRoot, instanceConfig);
    if (classification.matched) {
      selected.set(row.pid, processSummary(row, classification.reason, {
        instanceAttributed: true,
        instanceId: getInstanceId(instanceConfig),
        profile: getInstanceProfile(instanceConfig),
      }));
    } else if (classification.ambiguous) {
      ambiguous.push(processSummary(row, classification.reason));
    }
  }

  const result = Array.from(selected.values()).sort((left, right) => left.pid - right.pid);
  Object.defineProperty(result, 'ambiguousCandidates', {
    enumerable: false,
    value: ambiguous,
  });
  return result;
}

function selectSquidRunElectronProcesses(projectRoot, rawRows = [], options = {}) {
  const instanceConfig = options?.instanceConfig || (options?.id || options?.instance ? options : null);
  if (instanceConfig) {
    return selectInstanceSquidRunElectronProcesses(projectRoot, rawRows, instanceConfig);
  }
  return selectLegacySquidRunElectronProcesses(projectRoot, rawRows);
}

function listElectronProcesses(projectRoot, options = {}) {
  if (process.platform !== 'win32' && !options.processRows && !options.tasklistOutput) return [];
  return selectSquidRunElectronProcesses(projectRoot, queryWindowsProcessRows(projectRoot, options), options);
}

function collectProcessDescendants(rootPid, rawRows = []) {
  const rows = rawRows.map(asProcessRow).filter((row) => row.pid);
  const childrenByParent = new Map();
  for (const row of rows) {
    if (!row.parentPid) continue;
    if (!childrenByParent.has(row.parentPid)) childrenByParent.set(row.parentPid, []);
    childrenByParent.get(row.parentPid).push(row);
  }
  const descendants = [];
  const stack = (childrenByParent.get(Number(rootPid)) || [])
    .map((row) => ({ row, depth: 1 }));
  const seen = new Set([Number(rootPid)]);
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item?.row?.pid || seen.has(item.row.pid)) continue;
    seen.add(item.row.pid);
    descendants.push({
      ...item.row,
      depth: item.depth,
    });
    for (const child of childrenByParent.get(item.row.pid) || []) {
      stack.push({ row: child, depth: item.depth + 1 });
    }
  }
  return descendants.sort((left, right) => right.depth - left.depth || right.pid - left.pid);
}

function buildShutdownKillOrder(targets = [], rawRows = []) {
  const killOrder = [];
  const seen = new Set();
  const add = (proc, role) => {
    if (!proc?.pid || seen.has(proc.pid)) return;
    seen.add(proc.pid);
    killOrder.push({
      ...proc,
      role,
    });
  };
  for (const target of targets) {
    for (const descendant of collectProcessDescendants(target.pid, rawRows)) {
      add(descendant, 'descendant');
    }
  }
  for (const target of targets) {
    add(target, 'target');
  }
  return killOrder;
}

function processRowMap(rawRows = []) {
  return new Map(rawRows.map(asProcessRow).filter((row) => row.pid).map((row) => [row.pid, row]));
}

function ancestorRows(row = {}, rowsByPid = new Map()) {
  const ancestors = [];
  const seen = new Set([row.pid]);
  let parent = rowsByPid.get(row.parentPid);
  while (parent && parent.pid && !seen.has(parent.pid)) {
    ancestors.push(parent);
    seen.add(parent.pid);
    parent = rowsByPid.get(parent.parentPid);
  }
  return ancestors;
}

function directOrphanCandidate(row = {}) {
  const name = normalizeForProcessMatch(row.name);
  const commandLine = normalizeForProcessMatch(row.commandLine);
  const executablePath = normalizeForProcessMatch(row.executablePath);
  return Boolean(
    name.includes('claude')
    || executablePath.includes('claude')
    || commandLine.includes('claude')
    || commandLine.includes('terminal-daemon.js')
    || commandLine.includes('node-pty')
  );
}

function processTreeDepth(row = {}, rowsByPid = new Map()) {
  return ancestorRows(row, rowsByPid).length;
}

function staleOrphanCandidates(projectRoot, rawRows = [], excludePids = new Set()) {
  const rows = rawRows.map(asProcessRow).filter((row) => row.pid);
  const rowsByPid = processRowMap(rows);
  return rows
    .filter((row) => !excludePids.has(row.pid))
    .filter((row) => {
      const ancestors = ancestorRows(row, rowsByPid);
      const related = isProjectRelatedProcess(row, projectRoot)
        || ancestors.some((ancestor) => isProjectRelatedProcess(ancestor, projectRoot));
      if (!related) return false;
      return directOrphanCandidate(row);
    })
    .map((row) => ({
      ...row,
      role: 'orphan',
      depth: processTreeDepth(row, rowsByPid),
    }))
    .sort((left, right) => right.depth - left.depth || right.pid - left.pid);
}

function shouldSweepOrphans(options = {}) {
  if (options.sweepOrphans === true) return true;
  const raw = process.env.SQUIDRUN_RESTART_SWEEP_ORPHANS;
  return ['1', 'true', 'yes', 'on'].includes(String(raw || '').trim().toLowerCase());
}

async function sweepOrphanProcesses(projectRoot, options = {}) {
  const rows = Array.isArray(options.orphanSweepProcessRows)
    ? options.orphanSweepProcessRows
    : queryWindowsProcessRows(projectRoot, {
        tasklistOutput: options.orphanSweepTasklistOutput,
      });
  const targets = selectSquidRunElectronProcesses(projectRoot, rows);
  const excludePids = new Set();
  for (const target of targets) {
    excludePids.add(target.pid);
    for (const descendant of collectProcessDescendants(target.pid, rows)) {
      excludePids.add(descendant.pid);
    }
  }
  const candidates = staleOrphanCandidates(projectRoot, rows, excludePids);
  const killProcess = options.killProcess || ((pid) => process.kill(pid, 'SIGTERM'));
  const exists = options.processExists || processExists;
  const sleepFn = options.sleep || sleep;
  const nowFn = options.now || Date.now;
  const timeoutMs = Math.max(1000, Number(options.orphanSweepTimeoutMs || 5000));
  const killed = [];
  const alreadyStopped = [];
  for (const proc of candidates) {
    try {
      killProcess(proc.pid, proc);
      killed.push(proc);
    } catch (error) {
      if (isNoSuchProcessError(error)) {
        alreadyStopped.push({ pid: proc.pid, name: proc.name || null, role: proc.role || null });
        continue;
      }
      return {
        ok: false,
        reason: 'orphan_sweep_kill_failed',
        error: error?.message || String(error),
        targets,
        candidates,
        killed,
        alreadyStopped,
      };
    }
  }
  const deadline = nowFn() + timeoutMs;
  while (nowFn() <= deadline) {
    const stillAlive = killed.filter((proc) => exists(proc.pid));
    if (stillAlive.length === 0) {
      return { ok: true, targets, candidates, killed, alreadyStopped };
    }
    await sleepFn(Math.min(250, Math.max(0, deadline - nowFn())));
  }
  return {
    ok: false,
    reason: 'orphan_sweep_survivors',
    targets,
    candidates,
    killed,
    alreadyStopped,
    stillAlive: killed.filter((proc) => exists(proc.pid)),
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A kill against a PID that's already gone (race between enumeration and
// SIGTERM) is not a restart failure — it's the win condition. Treat ESRCH
// or "no such process" as already_stopped and keep going. Anything else is
// still a real failure that should abort.
function isNoSuchProcessError(error) {
  if (!error) return false;
  if (error.code === 'ESRCH') return true;
  if (error.errno === 'ESRCH' || error.errno === -3) return true;
  const message = String(error.message || '');
  return /\bESRCH\b/i.test(message) || /no such process/i.test(message);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function buildRelaunchSource(processes = []) {
  const target = processes.find((proc) => proc?.instanceAttributed) || processes[0] || null;
  if (!target) return null;
  return {
    pid: target.pid,
    commandLine: target.commandLine || null,
    cwd: target.cwd || null,
    env: target.env || null,
    matchReason: target.matchReason || null,
    instanceAttributed: Boolean(target.instanceAttributed),
  };
}

async function shutdownElectronProcesses(projectRoot, options = {}) {
  const listProcesses = options.listElectronProcesses || ((root) => listElectronProcesses(root, options));
  const shouldQueryRows = !options.listElectronProcesses
    || Array.isArray(options.processRows)
    || typeof options.tasklistOutput === 'string';
  const processRows = shouldQueryRows ? queryWindowsProcessRows(projectRoot, options) : [];
  const exists = options.processExists || processExists;
  const killProcess = options.killProcess || ((pid) => process.kill(pid, 'SIGTERM'));
  const sleepFn = options.sleep || sleep;
  const nowFn = options.now || Date.now;
  const timeoutMs = Math.max(1000, Number(options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS));
  const processes = listProcesses(projectRoot);
  const killed = [];
  if (processes.length === 0) {
    const legacyCandidates = options.instanceConfig && processRows.length > 0
      ? selectLegacySquidRunElectronProcesses(projectRoot, processRows)
      : [];
    if (legacyCandidates.length > 0) {
      return {
        ok: false,
        reason: 'no_instance_attributed_process',
        processes,
        candidates: legacyCandidates,
        killed,
      };
    }
    return {
      ok: false,
      reason: 'no_target_found',
      processes,
      killed,
    };
  }
  const killOrder = buildShutdownKillOrder(processes, processRows);
  for (const proc of killOrder) {
    try {
      killProcess(proc.pid, proc);
      killed.push(proc);
    } catch (error) {
      if (error?.code === 'ESRCH' || String(error).includes('ESRCH')) {
        killed.push(proc);
        continue;
      }
      return {
        ok: false,
        reason: 'kill_failed',
        error: error?.message || String(error),
        processes,
        killOrder,
        killed,
      };
    }
  }
  const deadline = nowFn() + timeoutMs;
  while (nowFn() <= deadline) {
    const stillAlive = killed.filter((proc) => exists(proc.pid));
    if (stillAlive.length === 0) {
      return { ok: true, processes, killOrder, killed, relaunchSource: buildRelaunchSource(processes) };
    }
    await sleepFn(Math.min(250, Math.max(0, deadline - nowFn())));
  }
  const stillAlive = killed.filter((proc) => exists(proc.pid));
  const orphanDescendants = stillAlive.filter((proc) => proc.role === 'descendant');
  if (orphanDescendants.length > 0) {
    return {
      ok: false,
      reason: 'orphan_descendants',
      processes,
      killOrder,
      killed,
      orphanDescendants,
      stillAlive,
    };
  }
  return {
    ok: false,
    reason: 'shutdown_timeout',
    processes,
    killOrder,
    killed,
    stillAlive,
  };
}

function statusTimestampMs(status = {}) {
  const candidates = [
    status.lastUpdated,
    status.started,
    status.timestampUtc,
    status.ts,
  ];
  for (const value of candidates) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function statusSessionValue(status = {}) {
  const value = status.session_id ?? status.sessionId ?? status.session ?? status.sessionNumber;
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function statusPidValue(status = {}) {
  const value = status.pid ?? status.processId ?? status.mainPid ?? status.electronPid;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function captureAppStatus(instanceConfig) {
  const statusPath = instanceConfig.appStatusPath;
  const status = readJson(statusPath, null);
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(statusPath).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  return {
    exists: Boolean(status && typeof status === 'object'),
    path: statusPath,
    status,
    mtimeMs,
    timestampMs: statusTimestampMs(status || {}),
    session: statusSessionValue(status || {}),
    pid: statusPidValue(status || {}),
  };
}

function isFreshAppStatus(previous = {}, current = {}, launchStartedMs = Date.now()) {
  if (!current.exists) return false;
  const floorMs = launchStartedMs - 1000;
  if (!previous.exists && current.timestampMs && current.timestampMs >= floorMs) return true;
  if (
    current.session
    && previous.session
    && current.session !== previous.session
    && (!current.timestampMs || current.timestampMs >= floorMs)
  ) {
    return true;
  }
  if (
    current.pid
    && previous.pid
    && current.pid !== previous.pid
    && (!current.timestampMs || current.timestampMs >= floorMs)
  ) {
    return true;
  }
  if (
    Number.isFinite(current.timestampMs)
    && Number.isFinite(previous.timestampMs)
    && current.timestampMs !== previous.timestampMs
    && current.timestampMs >= floorMs
  ) {
    return true;
  }
  return Boolean(
    Number.isFinite(current.mtimeMs)
    && Number.isFinite(previous.mtimeMs)
    && current.mtimeMs > previous.mtimeMs
    && current.timestampMs
    && current.timestampMs >= floorMs
  );
}

async function waitForFreshAppStatus(instanceConfig, previousSnapshot, options = {}) {
  const capture = options.captureAppStatus || captureAppStatus;
  const sleepFn = options.sleep || sleep;
  const nowFn = options.now || Date.now;
  const timeoutMs = Math.max(1000, Number(options.relaunchVerifyTimeoutMs || DEFAULT_RELAUNCH_VERIFY_TIMEOUT_MS));
  const pollMs = Math.max(25, Number(options.relaunchVerifyPollMs || DEFAULT_RELAUNCH_VERIFY_POLL_MS));
  const launchStartedMs = Number(options.launchStartedMs || nowFn());
  const deadline = launchStartedMs + timeoutMs;
  let latest = null;
  while (nowFn() <= deadline) {
    latest = capture(instanceConfig);
    if (isFreshAppStatus(previousSnapshot, latest, launchStartedMs)) {
      return {
        ok: true,
        appStatus: latest,
        previous: previousSnapshot,
        launchStartedMs,
      };
    }
    await sleepFn(Math.min(pollMs, Math.max(0, deadline - nowFn())));
  }
  return {
    ok: false,
    reason: 'relaunch_unverified',
    appStatus: latest,
    previous: previousSnapshot,
    launchStartedMs,
    timeoutMs,
  };
}

function relaunchSquidRun(projectRoot, instanceConfig, options = {}) {
  const launch = options.launchCommand || defaultLaunchCommand(projectRoot, instanceConfig, options.relaunchSource);
  const spawnFn = options.spawn || spawn;
  const child = spawnFn(launch.command, launch.args || [], {
    cwd: launch.cwd || path.join(projectRoot, 'ui'),
    env: {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: projectRoot,
      ...(launch.env || {}),
    },
    detached: true,
    shell: launch.shell ?? (process.platform === 'win32'),
    windowsHide: true,
    stdio: 'ignore',
  });
  if (child && typeof child.unref === 'function') child.unref();
  return {
    ok: true,
    pid: Number(child?.pid) || null,
    launch,
  };
}

function logStep(instanceConfig, step, details = {}) {
  const logPath = path.join(instanceConfig.coordPath, 'restart-execute-log.jsonl');
  const payload = {
    ts: new Date().toISOString(),
    step,
    ...details,
  };
  appendJsonLine(logPath, payload);
  return payload;
}

function recordFailureAnomaly(projectRoot, details = {}, options = {}, type = 'restart_execute_failure') {
  const scriptPath = path.join(projectRoot, 'ui', 'scripts', 'hm-anomaly.js');
  const run = options.runNodeScript || ((script, args) => spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  }));
  return run(scriptPath, [
    `type=${type}`,
    'src=hm-restart-execute',
    'sev=high',
    `details=${JSON.stringify(details)}`,
    '--json',
  ]);
}

function shutdownAnomalyType(reason = '') {
  if (reason === 'no_target_found') return 'restart_execute_no_target_found';
  if (reason === 'orphan_descendants') return 'restart_execute_orphan_descendants';
  return 'restart_execute_failure';
}

async function executeRestart(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || getProjectRoot());
  const instanceId = options.instance || DEFAULT_INSTANCE_ID;
  const reason = String(options.reason || '').trim();
  if (!reason) throw new Error('Missing restart reason');
  const nowMs = Number(options.nowMs || Date.now());
  const instanceConfig = loadInstanceConfig(projectRoot, instanceId);
  const runtimeProjectRoot = instanceConfig.registryRoot || projectRoot;
  const capture = options.captureAppStatus || captureAppStatus;
  const previousAppStatus = capture(instanceConfig);
  const preflight = findLatestGreenPreflight(instanceConfig, instanceId, nowMs);
  logStep(instanceConfig, 'preflight_check', { ok: preflight.ok, reason: preflight.reason || null, preflight });
  if (!preflight.ok) {
    const failure = {
      ok: false,
      stage: 'preflight',
      reason: preflight.reason,
      preflight,
    };
    recordFailureAnomaly(runtimeProjectRoot, failure, options);
    return failure;
  }

  logStep(instanceConfig, 'shutdown_start', { reason, instance: instanceId });
  const shutdown = await shutdownElectronProcesses(runtimeProjectRoot, {
    ...options,
    instanceConfig,
  });
  logStep(instanceConfig, 'shutdown_complete', shutdown);
  if (!shutdown.ok) {
    const failure = { ok: false, stage: 'shutdown', reason: shutdown.reason || 'shutdown_failed', shutdown };
    recordFailureAnomaly(runtimeProjectRoot, failure, options, shutdownAnomalyType(shutdown.reason));
    return failure;
  }

  try {
    const launchStartedMs = Number(options.launchStartedMs || Date.now());
    const relaunch = relaunchSquidRun(runtimeProjectRoot, instanceConfig, {
      ...options,
      relaunchSource: options.relaunchSource || shutdown.relaunchSource,
    });
    logStep(instanceConfig, 'relaunch_started', relaunch);
    const verification = await waitForFreshAppStatus(instanceConfig, previousAppStatus, {
      ...options,
      launchStartedMs,
    });
    logStep(instanceConfig, 'relaunch_verification_complete', verification);
    if (!verification.ok) {
      const failure = {
        ok: false,
        stage: 'relaunch_verification',
        reason: verification.reason || 'relaunch_unverified',
        relaunch,
        verification,
      };
      recordFailureAnomaly(runtimeProjectRoot, failure, options, 'restart_execute_relaunch_unverified');
      return failure;
    }
    let orphanSweep = null;
    if (shouldSweepOrphans(options)) {
      orphanSweep = await sweepOrphanProcesses(projectRoot, options);
      logStep(instanceConfig, 'orphan_sweep_complete', orphanSweep);
      if (!orphanSweep.ok) {
        recordFailureAnomaly(runtimeProjectRoot, {
          ok: false,
          stage: 'orphan_sweep',
          reason: orphanSweep.reason || 'orphan_sweep_failed',
          orphanSweep,
        }, options, 'restart_execute_orphan_sweep_failed');
      }
    }
    return {
      ok: true,
      instance: instanceId,
      reason,
      preflight,
      shutdown,
      relaunch,
      verification,
      orphanSweep,
    };
  } catch (error) {
    const failure = {
      ok: false,
      stage: 'relaunch',
      reason: 'relaunch_failed',
      error: error?.message || String(error),
    };
    logStep(instanceConfig, 'relaunch_failed', failure);
    recordFailureAnomaly(runtimeProjectRoot, failure, options);
    return failure;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await executeRestart(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_INSTANCE_ID,
  PREFLIGHT_MAX_AGE_MS,
  DEFAULT_RELAUNCH_VERIFY_TIMEOUT_MS,
  parseArgs,
  readJson,
  readJsonLines,
  loadInstanceConfig,
  isGreenPreflightMessage,
  findLatestGreenPreflight,
  defaultLaunchCommand,
  parseTasklistCsv,
  selectSquidRunElectronProcesses,
  collectProcessDescendants,
  buildShutdownKillOrder,
  staleOrphanCandidates,
  shouldSweepOrphans,
  sweepOrphanProcesses,
  listElectronProcesses,
  shutdownElectronProcesses,
  captureAppStatus,
  isFreshAppStatus,
  waitForFreshAppStatus,
  relaunchSquidRun,
  shutdownAnomalyType,
  executeRestart,
  main,
};
