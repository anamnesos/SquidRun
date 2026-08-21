#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LEGACY_ROLE_ALIASES, ROLE_ID_MAP, resolveCoordPath } = require('../config');
const initiative = require('./hm-initiative');
const {
  ACTIVE_STATUSES,
  appendObservationEvent,
  effectiveStatus,
  listObservations,
  loadObservationLog,
  normalizeOwner,
  openObservation,
  projectObservation,
} = require('../modules/observatory-store');

const ROLE_BY_PANE = Object.freeze({ '1': 'architect', '2': 'builder', '3': 'oracle' });

function parseArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next && !String(next).startsWith('--') ? next : true;
    if (value !== true) index += 1;
    if (!options.has(key)) options.set(key, value);
    else {
      const prior = options.get(key);
      options.set(key, Array.isArray(prior) ? [...prior, value] : [prior, value]);
    }
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  return options.has(key) ? options.get(key) : fallback;
}

function optionValues(options, key) {
  const value = getOption(options, key, []);
  if (value === true || value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeRuntimeRole(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (ROLE_ID_MAP[raw]) return raw;
  if (LEGACY_ROLE_ALIASES[raw]) return LEGACY_ROLE_ALIASES[raw];
  return null;
}

function resolveRuntimeActor(env = process.env) {
  const rawRole = String(env.SQUIDRUN_ROLE || '').trim();
  const rawPane = String(env.SQUIDRUN_PANE_ID || '').trim();
  const role = normalizeRuntimeRole(rawRole);
  const pane = ROLE_BY_PANE[rawPane] || null;
  if (rawRole && !role) throw new Error(`invalid runtime role: ${rawRole}`);
  if (rawPane && !pane) throw new Error(`invalid runtime pane: ${rawPane}`);
  if (role && pane && role !== pane) {
    throw new Error(`runtime role/pane contradiction: ${role} vs ${pane}`);
  }
  const actor = role || pane;
  if (!actor) throw new Error('observatory writes require SQUIDRUN_ROLE or SQUIDRUN_PANE_ID');
  return normalizeOwner(actor);
}

function observatoryPathForActor(actor) {
  return resolveCoordPath(path.join('coord', 'observatory', `${normalizeOwner(actor)}.jsonl`), {
    forWrite: true,
  });
}

function requireText(options, key) {
  const value = getOption(options, key, '');
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`--${key} is required`);
  return normalized;
}

function buildEvidenceEntries(options, key, actor, at) {
  const missingArtifact = getOption(options, 'missing-artifact', false) === true;
  const scopeSearched = getOption(options, 'scope-searched', '');
  return optionValues(options, key).map((ref) => ({
    ref: String(ref),
    note: '',
    scopeSearched,
    countercheck: false,
    missingArtifact,
    recordedBy: actor,
    recordedAt: at.toISOString(),
  }));
}

function observationById(filePath, id) {
  const loaded = loadObservationLog(filePath);
  const state = loaded.states.get(id);
  if (!state) throw new Error(`unknown observation: ${id}`);
  return { loaded, state };
}

function assertPromotionReady(state, actor, now) {
  if (state.owner !== actor) throw new Error(`${actor} cannot promote ${state.owner} observation ${state.id}`);
  if (!ACTIVE_STATUSES.has(state.status) || effectiveStatus(state, now) === 'expired') {
    throw new Error(`observation ${state.id} is not active`);
  }
  if (state.evidence.length === 0) throw new Error('promotion requires evidence');
  if (!state.nextProbe) throw new Error('promotion requires a next probe');
  if ((state.stakes === 'high' || state.favorable) &&
      !state.disconfirmers.some((entry) => entry.countercheck === true)) {
    throw new Error('high-stakes or favorable promotion requires an explicit countercheck');
  }
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function lockIsStale(lockPath, staleMs, nowMs) {
  const owner = readLockOwner(lockPath);
  let observedAt = null;
  try {
    observedAt = fs.statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }
  const createdAt = owner && Number.isFinite(new Date(owner.createdAt).getTime())
    ? new Date(owner.createdAt).getTime()
    : observedAt;
  if (owner && owner.hostname === os.hostname() && processIsAlive(Number(owner.pid))) return false;
  return nowMs - createdAt > staleMs;
}

function breakStaleLock(lockPath) {
  const quarantinePath = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
    fs.rmSync(quarantinePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function withPromotionLock({
  lockPath,
  maxWaitMs = 5000,
  staleMs = 120000,
  pollMs = 25,
}, action) {
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
          token,
          pid: process.pid,
          hostname: os.hostname(),
          createdAt: new Date().toISOString(),
        })}\n`, 'utf8');
      } catch (err) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (lockIsStale(lockPath, staleMs, Date.now()) && breakStaleLock(lockPath)) continue;
      if (Date.now() - startedAt >= maxWaitMs) {
        throw new Error('observatory promotion is busy; retry after the current promotion finishes');
      }
      sleepSync(pollMs);
    }
  }

  let actionError = null;
  let result;
  try {
    result = action();
  } catch (err) {
    actionError = err;
  } finally {
    const owner = readLockOwner(lockPath);
    if (!owner || owner.token !== token) {
      const cleanupError = new Error('observatory promotion lock ownership changed before release');
      if (actionError) cleanupError.cause = actionError;
      throw cleanupError;
    }
    fs.rmSync(lockPath, { recursive: true, force: false });
  }
  if (actionError) throw actionError;
  return result;
}

function promoteObservation({
  filePath,
  id,
  actor,
  now = new Date(),
  initiativeApi = initiative,
  registerPath = initiative.REGISTER_PATH,
  lockPath = path.join(path.dirname(registerPath), '.observatory-promotion.lock'),
  lockWaitMs = 5000,
}) {
  return withPromotionLock({ lockPath, maxWaitMs: lockWaitMs }, () => {
    const { state } = observationById(filePath, id);
    assertPromotionReady(state, actor, now);
    const register = initiativeApi.loadRegister(registerPath);

    if (state.initiativeId) {
      const linked = initiativeApi.findInitiative
        ? initiativeApi.findInitiative(register, state.initiativeId)
        : (register.initiatives || []).find((entry) => entry.id === state.initiativeId);
      if (!linked) throw new Error(`linked initiative is missing: ${state.initiativeId}`);
      return { state, initiative: linked, created: false };
    }

    const observationTag = `observatory:${state.id}`;
    let linked = (register.initiatives || []).find((entry) => (
      Array.isArray(entry.tags) && entry.tags.includes(observationTag)
    ));
    let created = false;
    if (!linked) {
      linked = initiativeApi.createInitiative({
        title: `Investigate: ${state.question}`,
        reason: `${state.id}: ${state.whyItMatters}`,
        priority: state.stakes === 'high' ? 'high' : state.stakes === 'low' ? 'low' : 'normal',
        scope: 'local',
        tags: ['observatory', observationTag, state.owner],
      }, actor, now.toISOString());
      const nextRegister = initiativeApi.registerProposal(register, linked, actor, {
        surface: false,
        createdAt: now.toISOString(),
      });
      initiativeApi.writeRegister(nextRegister, registerPath);
      created = true;
    }

    const linkedState = appendObservationEvent({
      filePath,
      id,
      actor,
      type: 'promoted_to_initiative',
      payload: { initiativeId: linked.id },
      at: now,
    }).state;
    return { state: linkedState, initiative: linked, created };
  });
}

function renderList(items) {
  if (items.length === 0) {
    process.stdout.write('No observations found.\n');
    return;
  }
  const lines = items.map((item) => (
    `${item.id} [${item.effectiveStatus}${item.due ? '/due' : ''}] ${item.question} | next: ${item.nextProbe}`
  ));
  process.stdout.write(`${lines.join('\n')}\n`);
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  hm-observatory open --question <text> --why <text> --stakes <low|medium|high> --evidence <ref> [--missing-artifact --scope-searched <text>] --next-probe <text> --review-at <iso> (--expires-at <iso> | --no-expiry-reason <text>) [--favorable]',
    '  hm-observatory list [--mine] [--due] [--status <status>] [--json]',
    '  hm-observatory show <id> [--json]',
    '  hm-observatory add-evidence <id> --ref <ref> [--note <text>] [--missing-artifact --scope-searched <text>]',
    '  hm-observatory add-disconfirmer <id> --ref <ref> [--note <text>] [--countercheck] [--missing-artifact --scope-searched <text>]',
    '  hm-observatory set-next-probe <id> --probe <text>',
    '  hm-observatory schedule-review <id> --at <iso> [--expires-at <iso> | --no-expiry-reason <text>]',
    '  hm-observatory resolve|dismiss|expire <id> --reason <text>',
    '  hm-observatory promote <id>',
    '',
  ].join('\n'));
}

function main(argv = process.argv.slice(2), runtime = {}) {
  const { positional, options } = parseArgs(argv);
  const command = String(positional[0] || 'list').toLowerCase();
  const actor = resolveRuntimeActor(runtime.env || process.env);
  const filePath = runtime.filePath || observatoryPathForActor(actor);
  const now = runtime.now instanceof Date ? runtime.now : new Date();
  const wantsJson = getOption(options, 'json', false) === true;

  if (command === 'open') {
    const evidence = buildEvidenceEntries(options, 'evidence', actor, now);
    const result = openObservation({
      filePath,
      actor,
      at: now,
      input: {
        question: requireText(options, 'question'),
        whyItMatters: requireText(options, 'why'),
        stakes: requireText(options, 'stakes'),
        favorable: getOption(options, 'favorable', false) === true,
        evidence,
        nextProbe: requireText(options, 'next-probe'),
        reviewAt: requireText(options, 'review-at'),
        expiresAt: getOption(options, 'expires-at', null),
        noExpiryReason: getOption(options, 'no-expiry-reason', null),
      },
    });
    process.stdout.write(`${JSON.stringify({ ok: true, observation: projectObservation(result.state, now) }, null, 2)}\n`);
    return result;
  }

  if (command === 'list') {
    const loaded = loadObservationLog(filePath);
    const items = listObservations(loaded.states, {
      actor,
      mine: getOption(options, 'mine', false) === true,
      due: getOption(options, 'due', false) === true,
      status: getOption(options, 'status', null),
      now,
    });
    if (wantsJson) process.stdout.write(`${JSON.stringify({ ok: true, observations: items }, null, 2)}\n`);
    else renderList(items);
    return items;
  }

  const id = String(positional[1] || '').trim();
  if (!id) throw new Error(`${command} requires an observation id`);

  if (command === 'show') {
    const state = observationById(filePath, id).state;
    const projected = projectObservation(state, now);
    process.stdout.write(`${JSON.stringify(projected, null, 2)}\n`);
    return projected;
  }

  if (command === 'promote') {
    const result = promoteObservation({
      filePath,
      id,
      actor,
      now,
      initiativeApi: runtime.initiativeApi || initiative,
      registerPath: runtime.registerPath || initiative.REGISTER_PATH,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      observationId: id,
      initiativeId: result.initiative.id,
      created: result.created,
    }, null, 2)}\n`);
    return result;
  }

  let type;
  let payload;
  if (command === 'add-evidence' || command === 'add-disconfirmer') {
    type = command === 'add-evidence' ? 'evidence_added' : 'disconfirmer_added';
    payload = {
      ref: requireText(options, 'ref'),
      note: getOption(options, 'note', ''),
      scopeSearched: getOption(options, 'scope-searched', ''),
      countercheck: getOption(options, 'countercheck', false) === true,
      missingArtifact: getOption(options, 'missing-artifact', false) === true,
    };
  } else if (command === 'set-next-probe') {
    type = 'next_probe_set';
    payload = { nextProbe: requireText(options, 'probe') };
  } else if (command === 'schedule-review') {
    type = 'review_scheduled';
    payload = {
      reviewAt: requireText(options, 'at'),
      expiresAt: getOption(options, 'expires-at', null),
      noExpiryReason: getOption(options, 'no-expiry-reason', null),
    };
  } else if (command === 'resolve' || command === 'dismiss') {
    type = 'status_changed';
    payload = { status: command === 'resolve' ? 'resolved' : 'dismissed', reason: requireText(options, 'reason') };
  } else if (command === 'expire') {
    type = 'expired';
    payload = { reason: requireText(options, 'reason') };
  } else {
    throw new Error(`unknown command: ${command}`);
  }

  const result = appendObservationEvent({ filePath, id, actor, type, payload, at: now });
  process.stdout.write(`${JSON.stringify({ ok: true, observation: projectObservation(result.state, now) }, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    usage();
    process.exitCode = 1;
  }
}

module.exports = {
  assertPromotionReady,
  main,
  observatoryPathForActor,
  parseArgs,
  promoteObservation,
  resolveRuntimeActor,
  withPromotionLock,
};
