#!/usr/bin/env node
'use strict';

/**
 * hm-initiative: register and surface agent-originated initiatives.
 *
 * Usage:
 *   node ui/scripts/hm-initiative.js list [--json] [--mine] [--status <status>]
 *   node ui/scripts/hm-initiative.js show <initiative-id>
 *   node ui/scripts/hm-initiative.js propose --title "<title>" --reason "<reason>" [--priority <low|normal|high|critical>] [--scope <global|cross-agent|role|local>] [--tag <tag>] [--no-surface]
 *   node ui/scripts/hm-initiative.js endorse <initiative-id> [--reason "<reason>"]
 *   node ui/scripts/hm-initiative.js challenge <initiative-id> [--reason "<reason>"]
 *   node ui/scripts/hm-initiative.js accept <initiative-id> [--reason "<reason>"]
 *   node ui/scripts/hm-initiative.js park <initiative-id> [--reason "<reason>"]
 *   node ui/scripts/hm-initiative.js reject <initiative-id> [--reason "<reason>"]
 *   node ui/scripts/hm-initiative.js surface <initiative-id>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { LEGACY_ROLE_ALIASES, ROLE_ID_MAP, resolveCoordPath } = require('../config');
const pipeline = require('../modules/pipeline');

const DEFAULT_ROLE_BY_PANE = Object.freeze({
  '1': 'architect',
  '2': 'builder',
  '3': 'oracle',
});

const PRIORITY_WEIGHT = Object.freeze({
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
});

const VALID_PRIORITIES = new Set(Object.keys(PRIORITY_WEIGHT));
const VALID_SCOPES = new Set(['global', 'cross-agent', 'role', 'local']);
const VALID_STATUSES = new Set(['proposed', 'active', 'accepted', 'rejected', 'parked']);
const REGISTER_PATH = resolveCoordPath(path.join('runtime', 'initiative-register.json'), { forWrite: true });

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const positional = [];
  const options = new Map();

  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2).trim();
    const next = args[index + 1];
    const value = (!next || String(next).startsWith('--')) ? true : next;
    if (value !== true) index += 1;

    if (options.has(key)) {
      const current = options.get(key);
      if (Array.isArray(current)) {
        current.push(value);
        options.set(key, current);
      } else {
        options.set(key, [current, value]);
      }
      continue;
    }

    options.set(key, value);
  }

  return { positional, options };
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  node ui/scripts/hm-initiative.js list [--json] [--mine] [--status <status>]',
    '  node ui/scripts/hm-initiative.js show <initiative-id>',
    '  node ui/scripts/hm-initiative.js propose --title "<title>" --reason "<reason>" [--priority <low|normal|high|critical>] [--scope <global|cross-agent|role|local>] [--tag <tag>] [--no-surface]',
    '  node ui/scripts/hm-initiative.js endorse <initiative-id> [--reason "<reason>"]',
    '  node ui/scripts/hm-initiative.js challenge <initiative-id> [--reason "<reason>"]',
    '  node ui/scripts/hm-initiative.js accept <initiative-id> [--reason "<reason>"]',
    '  node ui/scripts/hm-initiative.js park <initiative-id> [--reason "<reason>"]',
    '  node ui/scripts/hm-initiative.js reject <initiative-id> [--reason "<reason>"]',
    '  node ui/scripts/hm-initiative.js surface <initiative-id>',
    '',
  ].join('\n'));
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function getOption(options, key, fallback = null) {
  if (!options || !options.has(key)) return fallback;
  return options.get(key);
}

function optionValues(options, key) {
  const raw = getOption(options, key, null);
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}

function normalizeRole(value, fallback = '') {
  const raw = asString(String(value || ''), '').toLowerCase();
  if (!raw) return fallback;
  if (ROLE_ID_MAP[raw]) return raw;
  if (LEGACY_ROLE_ALIASES[raw]) return LEGACY_ROLE_ALIASES[raw];
  if (DEFAULT_ROLE_BY_PANE[raw]) return DEFAULT_ROLE_BY_PANE[raw];
  return fallback;
}

function resolveActorRole(options) {
  const cliRole = normalizeRole(getOption(options, 'role', ''), '');
  if (cliRole) return cliRole;
  const envRole = normalizeRole(process.env.SQUIDRUN_ROLE || '', '');
  if (envRole) return envRole;
  const paneRole = normalizeRole(process.env.SQUIDRUN_PANE_ID || '', '');
  if (paneRole) return paneRole;
  return 'cli';
}

function nowIso() {
  return new Date().toISOString();
}

function createEmptyRegister() {
  return {
    version: 1,
    updatedAt: null,
    initiatives: [],
  };
}

function loadRegister(registerPath = REGISTER_PATH) {
  if (!fs.existsSync(registerPath)) {
    return createEmptyRegister();
  }

  const raw = fs.readFileSync(registerPath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    version: 1,
    updatedAt: asString(parsed?.updatedAt, null),
    initiatives: Array.isArray(parsed?.initiatives) ? parsed.initiatives : [],
  };
}

function writeRegister(register, registerPath = REGISTER_PATH) {
  const dirPath = path.dirname(registerPath);
  fs.mkdirSync(dirPath, { recursive: true });
  const tempPath = path.join(
    dirPath,
    `.${path.basename(registerPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(register, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, registerPath);
}

function generateInitiativeId() {
  return `initiative-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(3).toString('hex')}`;
}

function normalizePriority(value) {
  const priority = asString(String(value || ''), 'normal').toLowerCase();
  return VALID_PRIORITIES.has(priority) ? priority : 'normal';
}

function normalizeScope(value) {
  const scope = asString(String(value || ''), 'global').toLowerCase();
  return VALID_SCOPES.has(scope) ? scope : 'global';
}

function normalizeStatus(value) {
  const status = asString(String(value || ''), 'proposed').toLowerCase();
  return VALID_STATUSES.has(status) ? status : 'proposed';
}

function parseTags(options) {
  const rawValues = optionValues(options, 'tag');
  return Array.from(new Set(
    rawValues
      .flatMap((value) => String(value || '').split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  ));
}

function makeReaction(type, actorRole, reason, createdAt) {
  return {
    role: actorRole,
    reason: asString(reason, ''),
    createdAt,
    updatedAt: createdAt,
    type,
  };
}

function createInitiative(input, actorRole, createdAt = nowIso()) {
  const title = asString(input.title, '');
  if (!title) {
    throw new Error('propose requires --title');
  }

  const reason = asString(input.reason, '');
  if (!reason) {
    throw new Error('propose requires --reason');
  }

  return {
    id: generateInitiativeId(),
    title,
    reason,
    proposedBy: actorRole,
    scope: normalizeScope(input.scope),
    priority: normalizePriority(input.priority),
    status: 'proposed',
    tags: Array.isArray(input.tags) ? input.tags : [],
    createdAt,
    updatedAt: createdAt,
    surfacedAt: null,
    pipelineId: null,
    endorsements: [makeReaction('endorse', actorRole, 'Author endorsement.', createdAt)],
    challenges: [],
    history: [{
      type: 'proposed',
      role: actorRole,
      reason,
      createdAt,
    }],
  };
}

function findInitiative(register, initiativeId) {
  return (register.initiatives || []).find((initiative) => initiative.id === initiativeId) || null;
}

function upsertReaction(list, reaction) {
  const next = Array.isArray(list) ? list.slice() : [];
  const index = next.findIndex((entry) => entry.role === reaction.role);
  if (index === -1) {
    next.push(reaction);
    return next;
  }

  next[index] = {
    ...next[index],
    reason: reaction.reason,
    updatedAt: reaction.updatedAt,
    type: reaction.type,
  };
  return next;
}

function removeReactionByRole(list, role) {
  return (Array.isArray(list) ? list : []).filter((entry) => entry.role !== role);
}

function recordHistory(initiative, type, actorRole, reason, createdAt) {
  initiative.history = Array.isArray(initiative.history) ? initiative.history : [];
  initiative.history.push({
    type,
    role: actorRole,
    reason: asString(reason, ''),
    createdAt,
  });
}

function applyReaction(register, initiativeId, actorRole, type, reason, createdAt = nowIso()) {
  const initiative = findInitiative(register, initiativeId);
  if (!initiative) {
    throw new Error(`Unknown initiative: ${initiativeId}`);
  }

  if (type === 'endorse') {
    initiative.challenges = removeReactionByRole(initiative.challenges, actorRole);
    initiative.endorsements = upsertReaction(
      initiative.endorsements,
      makeReaction(type, actorRole, reason, createdAt)
    );
  } else {
    initiative.endorsements = removeReactionByRole(initiative.endorsements, actorRole);
    initiative.challenges = upsertReaction(
      initiative.challenges,
      makeReaction(type, actorRole, reason, createdAt)
    );
  }

  initiative.updatedAt = createdAt;
  recordHistory(initiative, type, actorRole, reason, createdAt);
  return initiative;
}

function updateInitiativeStatus(register, initiativeId, actorRole, status, reason, createdAt = nowIso()) {
  const initiative = findInitiative(register, initiativeId);
  if (!initiative) {
    throw new Error(`Unknown initiative: ${initiativeId}`);
  }

  const nextStatus = normalizeStatus(status);
  if (!['accepted', 'parked', 'rejected'].includes(nextStatus)) {
    throw new Error(`Unsupported initiative status: ${status}`);
  }

  initiative.status = nextStatus;
  initiative.updatedAt = createdAt;
  initiative.decidedBy = actorRole;
  initiative.decidedAt = createdAt;
  initiative.lastDecisionReason = asString(reason, '');
  recordHistory(initiative, nextStatus, actorRole, reason, createdAt);
  return initiative;
}

function computeSupport(initiative) {
  const endorsements = Array.isArray(initiative.endorsements) ? initiative.endorsements.length : 0;
  const challenges = Array.isArray(initiative.challenges) ? initiative.challenges.length : 0;
  return {
    endorsements,
    challenges,
    net: endorsements - challenges,
  };
}

function computeAttentionScore(initiative) {
  const support = computeSupport(initiative);
  const priorityWeight = PRIORITY_WEIGHT[normalizePriority(initiative.priority)] || 0;
  return (priorityWeight * 10) + (support.endorsements * 3) - (support.challenges * 4);
}

function sortInitiatives(initiatives) {
  return initiatives.slice().sort((left, right) => {
    const scoreDelta = computeAttentionScore(right) - computeAttentionScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
  });
}

function createProposalMessage(initiative) {
  return `[PROPOSAL] ${initiative.title} - ${initiative.reason}`;
}

function surfaceInitiative(initiative, actorRole, pipelineModule = pipeline) {
  if (!pipelineModule || typeof pipelineModule.init !== 'function' || typeof pipelineModule.onMessage !== 'function') {
    return null;
  }

  pipelineModule.init({});
  const beforeIds = new Set((pipelineModule.getItems ? pipelineModule.getItems() : []).map((item) => item.id));
  pipelineModule.onMessage({
    ts: Math.floor(Date.now() / 1000),
    from: String(actorRole || 'unknown').toUpperCase(),
    to: 'ALL',
    msg: createProposalMessage(initiative),
    type: 'initiative',
  });
  const afterItems = pipelineModule.getItems ? pipelineModule.getItems() : [];
  const created = afterItems.find((item) => !beforeIds.has(item.id));
  return created ? created.id : null;
}

function registerProposal(register, initiative, actorRole, options = {}) {
  const next = {
    ...register,
    initiatives: Array.isArray(register.initiatives) ? register.initiatives.slice() : [],
  };

  next.initiatives.push(initiative);

  if (options.surface !== false) {
    const surfacedAt = options.createdAt || nowIso();
    const pipelineId = surfaceInitiative(initiative, actorRole, options.pipelineModule || pipeline);
    initiative.surfacedAt = surfacedAt;
    initiative.pipelineId = pipelineId;
    recordHistory(initiative, 'surfaced', actorRole, pipelineId ? `Pipeline ${pipelineId}` : 'Pipeline surface attempted', surfacedAt);
    initiative.updatedAt = surfacedAt;
  }

  next.updatedAt = initiative.updatedAt;
  return next;
}

function filterInitiatives(register, options = {}) {
  let items = Array.isArray(register.initiatives) ? register.initiatives.slice() : [];
  const status = asString(options.status, '').toLowerCase();
  const mine = options.mine === true;
  const actorRole = asString(options.actorRole, '');

  if (status && status !== 'all') {
    items = items.filter((initiative) => normalizeStatus(initiative.status) === status);
  }

  if (mine && actorRole) {
    items = items.filter((initiative) => initiative.proposedBy === actorRole);
  }

  return sortInitiatives(items);
}

function renderList(items) {
  if (!items.length) {
    process.stdout.write('No initiatives found.\n');
    return;
  }

  const lines = items.map((initiative) => {
    const support = computeSupport(initiative);
    return [
      initiative.id,
      `[${normalizeStatus(initiative.status)}/${normalizePriority(initiative.priority)}]`,
      `score=${computeAttentionScore(initiative)}`,
      `${initiative.proposedBy}`,
      initiative.title,
      `( +${support.endorsements} / -${support.challenges} )`,
    ].join(' ');
  });

  process.stdout.write(`${lines.join('\n')}\n`);
}

function renderShow(initiative) {
  const support = computeSupport(initiative);
  process.stdout.write(`${JSON.stringify({
    ...initiative,
    support,
    attentionScore: computeAttentionScore(initiative),
  }, null, 2)}\n`);
}

function buildResult(initiative) {
  return {
    ok: true,
    initiativeId: initiative.id,
    title: initiative.title,
    status: initiative.status,
    priority: initiative.priority,
    proposedBy: initiative.proposedBy,
    pipelineId: initiative.pipelineId || null,
    support: computeSupport(initiative),
    attentionScore: computeAttentionScore(initiative),
  };
}

function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = asString(positional[0], 'list').toLowerCase();
  const actorRole = resolveActorRole(options);
  const register = loadRegister();

  if (command === 'list') {
    const filtered = filterInitiatives(register, {
      status: getOption(options, 'status', ''),
      mine: getOption(options, 'mine', false) === true,
      actorRole,
    });
    if (getOption(options, 'json', false) === true) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        count: filtered.length,
        initiatives: filtered.map((initiative) => ({
          ...initiative,
          support: computeSupport(initiative),
          attentionScore: computeAttentionScore(initiative),
        })),
      }, null, 2)}\n`);
      return;
    }
    renderList(filtered);
    return;
  }

  if (command === 'show') {
    const initiativeId = asString(positional[1], '');
    if (!initiativeId) {
      throw new Error('show requires an initiative id');
    }
    const initiative = findInitiative(register, initiativeId);
    if (!initiative) {
      throw new Error(`Unknown initiative: ${initiativeId}`);
    }
    renderShow(initiative);
    return;
  }

  if (command === 'propose') {
    const createdAt = nowIso();
    const title = asString(getOption(options, 'title', ''), positional.slice(1).join(' '));
    const reason = asString(getOption(options, 'reason', ''), '');
    const initiative = createInitiative({
      title,
      reason,
      priority: getOption(options, 'priority', 'normal'),
      scope: getOption(options, 'scope', 'global'),
      tags: parseTags(options),
    }, actorRole, createdAt);
    const next = registerProposal(register, initiative, actorRole, {
      surface: getOption(options, 'no-surface', false) !== true,
      createdAt,
    });
    writeRegister(next);
    process.stdout.write(`${JSON.stringify(buildResult(initiative), null, 2)}\n`);
    return;
  }

  if (command === 'endorse' || command === 'challenge') {
    const initiativeId = asString(positional[1], '');
    if (!initiativeId) {
      throw new Error(`${command} requires an initiative id`);
    }
    const updated = applyReaction(
      register,
      initiativeId,
      actorRole,
      command,
      asString(getOption(options, 'reason', ''), ''),
      nowIso()
    );
    register.updatedAt = updated.updatedAt;
    writeRegister(register);
    process.stdout.write(`${JSON.stringify(buildResult(updated), null, 2)}\n`);
    return;
  }

  if (command === 'accept' || command === 'park' || command === 'reject') {
    const initiativeId = asString(positional[1], '');
    if (!initiativeId) {
      throw new Error(`${command} requires an initiative id`);
    }
    const statusMap = {
      accept: 'accepted',
      park: 'parked',
      reject: 'rejected',
    };
    const updated = updateInitiativeStatus(
      register,
      initiativeId,
      actorRole,
      statusMap[command],
      asString(getOption(options, 'reason', ''), ''),
      nowIso()
    );
    register.updatedAt = updated.updatedAt;
    writeRegister(register);
    process.stdout.write(`${JSON.stringify(buildResult(updated), null, 2)}\n`);
    return;
  }

  if (command === 'surface') {
    const initiativeId = asString(positional[1], '');
    if (!initiativeId) {
      throw new Error('surface requires an initiative id');
    }
    const initiative = findInitiative(register, initiativeId);
    if (!initiative) {
      throw new Error(`Unknown initiative: ${initiativeId}`);
    }
    const surfacedAt = nowIso();
    const pipelineId = surfaceInitiative(initiative, actorRole, pipeline);
    initiative.pipelineId = pipelineId;
    initiative.surfacedAt = surfacedAt;
    initiative.updatedAt = surfacedAt;
    recordHistory(initiative, 'surfaced', actorRole, pipelineId ? `Pipeline ${pipelineId}` : 'Pipeline surface attempted', surfacedAt);
    register.updatedAt = surfacedAt;
    writeRegister(register);
    process.stdout.write(`${JSON.stringify(buildResult(initiative), null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    usage();
    process.exit(1);
  }
}

module.exports = {
  REGISTER_PATH,
  applyReaction,
  computeAttentionScore,
  computeSupport,
  createInitiative,
  createProposalMessage,
  filterInitiatives,
  loadRegister,
  normalizePriority,
  normalizeRole,
  normalizeScope,
  parseArgs,
  parseTags,
  registerProposal,
  renderList,
  renderShow,
  resolveActorRole,
  sortInitiatives,
  surfaceInitiative,
  updateInitiativeStatus,
  writeRegister,
};
