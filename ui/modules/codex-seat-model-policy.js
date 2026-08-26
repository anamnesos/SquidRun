const path = require('node:path');
const { canonicalPathsEqual } = require('./canonical-path');

const SOURCE_PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ORACLE_CODEX_POLICY = Object.freeze({
  schema: 'squidrun.codex_seat_model_policy.v1',
  paneId: '3',
  role: 'oracle',
  profile: 'main',
  model: 'gpt-5.6-sol',
  effort: 'xhigh',
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentity(value) {
  return normalizeText(value).toLowerCase();
}

function normalizePolicyToken(value) {
  const normalized = normalizeIdentity(value).replace(/^['"]|['"]$/g, '');
  return /^[a-z0-9][a-z0-9._:-]*$/i.test(normalized) ? normalized : '';
}

function pathsEqual(left, right, platform = process.platform) {
  return canonicalPathsEqual(left, right, { platform, allowMissing: true });
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

function configAssignment(value = '') {
  const text = unquote(value);
  const separator = text.indexOf('=');
  if (separator <= 0) return null;
  const key = normalizeIdentity(text.slice(0, separator));
  const setting = normalizePolicyToken(text.slice(separator + 1));
  return key && setting ? { key, value: setting } : null;
}

function inspectCodexPolicyFlags(command = '') {
  const tokens = tokenizeCommand(command);
  const models = [];
  const efforts = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    let modelValue = null;
    let configValue = null;

    if (lower === '--model' || lower === '-m') {
      modelValue = tokens[index + 1] || '';
      index += 1;
    } else if (lower.startsWith('--model=') || lower.startsWith('-m=')) {
      modelValue = token.slice(token.indexOf('=') + 1);
    } else if (lower === '--config' || lower === '-c') {
      configValue = tokens[index + 1] || '';
      index += 1;
    } else if (lower.startsWith('--config=') || lower.startsWith('-c=')) {
      configValue = token.slice(token.indexOf('=') + 1);
    }

    if (modelValue !== null) {
      models.push(normalizePolicyToken(modelValue));
    }
    if (configValue !== null) {
      const assignment = configAssignment(configValue);
      if (assignment?.key === 'model') models.push(assignment.value);
      if (assignment?.key === 'model_reasoning_effort') efforts.push(assignment.value);
    }
  }

  return {
    tokens,
    models: models.filter(Boolean),
    efforts: efforts.filter(Boolean),
  };
}

function insertBeforeResume(command, additions) {
  const text = normalizeText(command);
  const tokens = tokenizeCommand(text);
  const resumeIndex = tokens.findIndex((token, index) => (
    index > 0 && normalizeIdentity(unquote(token)) === 'resume'
  ));
  if (resumeIndex < 0) return `${text} ${additions.join(' ')}`.trim();
  const before = tokens.slice(0, resumeIndex).join(' ');
  const after = tokens.slice(resumeIndex).join(' ');
  return `${before} ${additions.join(' ')} ${after}`.replace(/\s+/g, ' ').trim();
}

function applyCodexModelPolicy(command = '', policy = null) {
  const text = normalizeText(command);
  if (!policy || !text) {
    return { ok: true, command: text, changed: false, reason: 'policy_not_applicable' };
  }
  const executable = normalizeIdentity(unquote(tokenizeCommand(text)[0] || ''))
    .split(/[\\/]/).pop()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (executable !== 'codex') {
    return { ok: true, command: text, changed: false, reason: 'runtime_not_codex' };
  }

  const expectedModel = normalizePolicyToken(policy.model);
  const expectedEffort = normalizePolicyToken(policy.effort);
  if (!expectedModel || !expectedEffort) {
    return {
      ok: false,
      command: text,
      changed: false,
      reason: 'codex_model_policy_invalid',
    };
  }

  const inspected = inspectCodexPolicyFlags(text);
  const conflictingModel = inspected.models.find((value) => value !== expectedModel);
  const conflictingEffort = inspected.efforts.find((value) => value !== expectedEffort);
  if (conflictingModel || conflictingEffort) {
    return {
      ok: false,
      command: text,
      changed: false,
      reason: 'codex_model_policy_conflict',
      expectedModel,
      expectedEffort,
      actualModel: conflictingModel || null,
      actualEffort: conflictingEffort || null,
    };
  }

  const additions = [];
  if (!inspected.models.includes(expectedModel)) {
    additions.push('--model', expectedModel);
  }
  if (!inspected.efforts.includes(expectedEffort)) {
    additions.push('--config', `model_reasoning_effort=${expectedEffort}`);
  }
  if (additions.length === 0) {
    return {
      ok: true,
      command: text,
      changed: false,
      reason: 'codex_model_policy_already_pinned',
      expectedModel,
      expectedEffort,
    };
  }

  return {
    ok: true,
    command: insertBeforeResume(text, additions),
    changed: true,
    reason: 'codex_model_policy_pinned',
    expectedModel,
    expectedEffort,
  };
}

function resolveMainOracleCodexPolicy(input = {}) {
  const env = input.env && typeof input.env === 'object' ? input.env : process.env;
  const paneId = normalizeText(input.paneId || env.SQUIDRUN_PANE_ID);
  const role = normalizeIdentity(input.role || env.SQUIDRUN_ROLE);
  const profile = normalizeIdentity(input.profile || env.SQUIDRUN_PROFILE || 'main');
  const installRoot = normalizeText(input.installRoot);
  const expectedInstallRoot = path.resolve(input.expectedInstallRoot || SOURCE_PROJECT_ROOT);

  if (paneId !== MAIN_ORACLE_CODEX_POLICY.paneId
      || role !== MAIN_ORACLE_CODEX_POLICY.role
      || profile !== MAIN_ORACLE_CODEX_POLICY.profile
      || !pathsEqual(installRoot, expectedInstallRoot, input.platform)) {
    return null;
  }

  return {
    ...MAIN_ORACLE_CODEX_POLICY,
    installRoot: expectedInstallRoot,
  };
}

module.exports = {
  SOURCE_PROJECT_ROOT,
  MAIN_ORACLE_CODEX_POLICY,
  applyCodexModelPolicy,
  inspectCodexPolicyFlags,
  pathsEqual,
  resolveMainOracleCodexPolicy,
  _internals: {
    configAssignment,
    insertBeforeResume,
    normalizePolicyToken,
    tokenizeCommand,
  },
};
