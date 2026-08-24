const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SOURCE_PROJECT_ROOT,
  pathsEqual,
} = require('./codex-seat-model-policy');

const GUARD_SCRIPT_BASENAME = 'hm-codex-model-guard.js';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readConfig(filePath, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { hooks: {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { hooks: {} };
    throw error;
  }
}

function writeConfig(filePath, config, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fsImpl.renameSync(tempPath, filePath);
}

function tokenizeCommand(command = '') {
  return String(command || '').match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) || [];
}

function unquote(value = '') {
  const text = normalizeText(value);
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function guardCommandIdentity(command = '', expectedScriptPath = '') {
  const tokens = tokenizeCommand(command);
  const executable = path.basename(unquote(tokens[0] || '')).toLowerCase().replace(/\.exe$/, '');
  if (executable !== 'node') return null;
  const scriptToken = unquote(tokens[1] || '');
  if (!scriptToken || path.basename(scriptToken).toLowerCase() !== GUARD_SCRIPT_BASENAME) {
    return null;
  }
  const resolvedScriptPath = path.resolve(scriptToken);
  if (expectedScriptPath && !pathsEqual(resolvedScriptPath, expectedScriptPath)) return null;
  return resolvedScriptPath;
}

function ensureGuardCommand(config, spec) {
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks
    : {};
  config.hooks = hooks;
  const entries = Array.isArray(hooks[spec.eventName]) ? hooks[spec.eventName] : [];
  hooks[spec.eventName] = entries;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
    const filtered = entry.hooks.filter((hook) => (
      guardCommandIdentity(hook?.command, spec.guardScriptPath) === null
    ));
    if (filtered.length !== entry.hooks.length) {
      entry.hooks = filtered;
    }
  }

  const matcher = Object.prototype.hasOwnProperty.call(spec, 'matcher') ? spec.matcher : null;
  let target = entries.find((entry) => (
    entry
    && typeof entry === 'object'
    && Array.isArray(entry.hooks)
    && (matcher === null
      ? !Object.prototype.hasOwnProperty.call(entry, 'matcher')
      : entry.matcher === matcher)
  ));
  if (!target) {
    target = {
      ...(matcher === null ? {} : { matcher }),
      hooks: [],
    };
    entries.push(target);
  }
  target.hooks.unshift({
    name: 'oracle-sol-xhigh-guard',
    type: 'command',
    command: spec.command,
    description: 'Fail closed before MAIN Oracle can continue on a drifted Codex model or effort',
  });
  return true;
}

function quoteCommandPath(value) {
  const text = path.resolve(normalizeText(value));
  if (!text || /["\r\n]/.test(text)) throw new Error('oracle_model_guard_path_invalid');
  return `"${text}"`;
}

function buildGuardCommand(installRoot) {
  const resolvedInstallRoot = path.resolve(normalizeText(installRoot) || SOURCE_PROJECT_ROOT);
  const scriptPath = path.join(resolvedInstallRoot, 'ui', 'scripts', GUARD_SCRIPT_BASENAME);
  return `node ${quoteCommandPath(scriptPath)} check --expected-install-root ${quoteCommandPath(resolvedInstallRoot)}`;
}

function installOracleModelGuardHooks(options = {}) {
  const installRoot = path.resolve(normalizeText(options.installRoot) || SOURCE_PROJECT_ROOT);
  const codexHome = path.resolve(
    normalizeText(options.codexHome)
    || normalizeText(process.env.CODEX_HOME)
    || path.join(os.homedir(), '.codex')
  );
  const configPath = path.join(codexHome, 'hooks.json');
  const fsImpl = options.fsImpl || fs;
  const config = readConfig(configPath, fsImpl);
  const before = JSON.stringify(config);
  const guardScriptPath = path.join(installRoot, 'ui', 'scripts', GUARD_SCRIPT_BASENAME);
  const command = buildGuardCommand(installRoot);
  const specs = [
    { eventName: 'SessionStart', matcher: 'startup|resume|clear|compact' },
    { eventName: 'PreCompact', matcher: 'manual|auto' },
    { eventName: 'PostCompact', matcher: 'manual|auto' },
    { eventName: 'UserPromptSubmit' },
    { eventName: 'PreToolUse', matcher: '*' },
    { eventName: 'Stop' },
  ];
  for (const spec of specs) ensureGuardCommand(config, {
    ...spec,
    command,
    guardScriptPath,
  });
  const changed = JSON.stringify(config) !== before;
  if (changed) writeConfig(configPath, config, fsImpl);
  return {
    ok: true,
    changed,
    installRoot,
    codexHome,
    configPath,
    command,
    events: specs.map((spec) => spec.eventName),
  };
}

module.exports = {
  GUARD_SCRIPT_BASENAME,
  buildGuardCommand,
  ensureGuardCommand,
  guardCommandIdentity,
  installOracleModelGuardHooks,
  _internals: {
    readConfig,
    writeConfig,
  },
};
