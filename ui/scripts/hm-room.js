#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { getProjectRoot } = require('../config');
const { parsePrivateNetworkOrigin } = require('../modules/main/team-room-auth');
const {
  NOTIFICATION_CLASSES,
  PARTICIPATION_REASONS,
  TEAM_ROOM_NOTIFICATION_INSTRUCTION,
  isRoomNotificationClassAllowed,
} = require('../modules/main/team-room-contracts');

const IDENTITY_FLAGS = new Set(['--as', '--author', '--member', '--member-id', '--profile', '--role', '--source']);
const ROLE_BY_PANE = Object.freeze({ '1': 'architect', '2': 'builder', '3': 'oracle' });
const VALID_ROLES = new Set(['architect', 'builder', 'oracle']);
const APP_GENERATION_PATTERN = /^app-(?:session-\d+|\d+-\d+)(?:[-:][A-Za-z0-9._-]+)?$/u;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PANE_LAUNCH_PATTERN = /^pl_[a-f0-9]{32}$/u;
const BINDING_REVISION_PATTERN = /^trb_[a-f0-9]{32}$/u;

function usage() {
  return [
    'Team Room',
    '',
    '  hm-room post --reason <reason> [--notify <class>] "message"',
    '  hm-room post --reason <reason> --stdin',
    '  hm-room reply --activation <id> --reason <reason> "message"',
    '  hm-room reply --activation <id> --reason <reason> --reentry --stdin',
    '  hm-room list [--json]',
    '  hm-room status [--json]',
    '',
    `Reasons: ${Object.values(PARTICIPATION_REASONS).join(', ')}`,
    `Notification classes: ${Object.values(NOTIFICATION_CLASSES).join(', ')}`,
    TEAM_ROOM_NOTIFICATION_INSTRUCTION,
    'Identity comes from the SquidRun runtime. Identity override flags are forbidden.',
  ].join('\n');
}

function resolveRuntimeRole(env = process.env) {
  const declaredRole = String(env.SQUIDRUN_ROLE || '').trim().toLowerCase();
  const paneId = String(env.SQUIDRUN_PANE_ID || '').trim();
  const paneRole = ROLE_BY_PANE[paneId] || '';
  const profileName = String(env.SQUIDRUN_PROFILE || '').trim().toLowerCase();
  const paneLaunchId = String(env.SQUIDRUN_PANE_LAUNCH_ID || '').trim();
  const appGeneration = String(env.SQUIDRUN_APP_GENERATION || '').trim();
  if (!declaredRole || !paneRole || !profileName || !paneLaunchId || !appGeneration) {
    return { ok: false, reason: 'room_cli_runtime_identity_incomplete' };
  }
  if (declaredRole !== paneRole) {
    return { ok: false, reason: 'room_cli_runtime_identity_mismatch' };
  }
  if (!VALID_ROLES.has(declaredRole)
    || !PROFILE_PATTERN.test(profileName)
    || !PANE_LAUNCH_PATTERN.test(paneLaunchId)
    || !APP_GENERATION_PATTERN.test(appGeneration)) {
    return { ok: false, reason: 'room_cli_runtime_identity_unknown' };
  }
  return { ok: true, role: declaredRole, paneId, profileName, paneLaunchId, appGeneration };
}

function parseArgs(argv = []) {
  const args = [...argv];
  if (args.some((arg) => IDENTITY_FLAGS.has(String(arg).toLowerCase()))) {
    return { ok: false, reason: 'room_cli_identity_override_forbidden' };
  }
  const command = String(args.shift() || 'help').trim().toLowerCase();
  if (['help', '--help', '-h'].includes(command)) return { ok: true, command: 'help' };
  if (!['post', 'reply', 'list', 'status'].includes(command)) {
    return { ok: false, reason: 'room_cli_command_invalid' };
  }
  const options = {
    command,
    json: false,
    stdin: false,
    reentry: false,
    activationId: null,
    reason: null,
    notificationClass: null,
    bodyParts: [],
  };
  while (args.length > 0) {
    const value = String(args.shift());
    if (value === '--json') options.json = true;
    else if (value === '--stdin') options.stdin = true;
    else if (value === '--reentry') options.reentry = true;
    else if (value === '--activation') options.activationId = String(args.shift() || '').trim();
    else if (value === '--reason') options.reason = String(args.shift() || '').trim().toLowerCase();
    else if (value === '--notify') {
      const notificationClass = String(args.shift() || '').trim().toLowerCase();
      if (!notificationClass || notificationClass.startsWith('--')) {
        return { ok: false, reason: 'room_cli_notification_class_required' };
      }
      options.notificationClass = notificationClass;
    }
    else if (value.startsWith('--')) return { ok: false, reason: `room_cli_flag_invalid:${value}` };
    else options.bodyParts.push(value);
  }
  if (options.stdin && options.bodyParts.length > 0) return { ok: false, reason: 'room_cli_body_source_conflict' };
  return { ok: true, ...options };
}

function readRuntimeFiles(projectRoot, identity) {
  const runtimeRoot = path.join(projectRoot, '.squidrun', 'runtime', 'team-room');
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime.json'), 'utf8'));
    const credential = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'credentials', `${identity.role}.json`), 'utf8'));
    const origin = parsePrivateNetworkOrigin(runtime.origin);
    if (!origin.ok || origin.protocol !== 'http:') {
      return { ok: false, reason: 'room_cli_runtime_origin_invalid' };
    }
    if (runtime.appGeneration !== identity.appGeneration
      || runtime.cliBindings?.[identity.role]?.role !== identity.role
      || String(runtime.cliBindings?.[identity.role]?.paneId) !== identity.paneId
      || runtime.cliBindings?.[identity.role]?.profileName !== identity.profileName
      || runtime.cliBindings?.[identity.role]?.paneLaunchId !== identity.paneLaunchId
      || runtime.cliBindings?.[identity.role]?.appGeneration !== identity.appGeneration
      || !BINDING_REVISION_PATTERN.test(String(runtime.cliBindings?.[identity.role]?.bindingRevision || ''))
      || credential.role !== identity.role
      || String(credential.paneId) !== identity.paneId
      || credential.profileName !== identity.profileName
      || credential.paneLaunchId !== identity.paneLaunchId
      || credential.appGeneration !== identity.appGeneration
      || credential.bindingRevision !== runtime.cliBindings?.[identity.role]?.bindingRevision
      || credential.source !== 'room_cli'
      || !/^[A-Za-z0-9_-]{40,256}$/u.test(String(credential.token || ''))) {
      return { ok: false, reason: 'room_cli_runtime_binding_mismatch' };
    }
    return { ok: true, runtime, credential };
  } catch (error) {
    return { ok: false, reason: `room_cli_runtime_unavailable:${error.code || error.message}` };
  }
}

function requestJson(origin, route, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const url = new URL(route, origin);
    const request = http.request(url, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
      },
      timeout: Number(options.timeoutMs) || 10_000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          resolve({ statusCode: response.statusCode, payload });
        } catch {
          reject(new Error('room_cli_response_invalid'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('room_cli_request_timeout')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function renderMessages(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  if (messages.length === 0) return 'Team Room is quiet.';
  return messages.map((message) => {
    const name = message.author?.displayName || message.authorId;
    const when = new Date(message.createdAtMs).toLocaleString();
    return `[${when}] ${name}: ${message.body}`;
  }).join('\n\n');
}

function renderPostError(payload = {}) {
  const reason = String(payload?.reason || 'room_cli_post_failed');
  if (reason === 'room_root_already_covered') {
    const coveredBy = String(payload?.details?.coveredByAgent || 'another agent').trim() || 'another agent';
    return `already covered on this root by ${coveredBy}`;
  }
  if (reason === 'room_agent_root_duplicate') {
    return 'that agent root was already posted moments ago';
  }
  return reason;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    stderr.write(`${parsed.reason}\n${usage()}\n`);
    return 1;
  }
  if (parsed.command === 'help') {
    stdout.write(`${usage()}\n`);
    return 0;
  }
  const identity = resolveRuntimeRole(deps.env || process.env);
  if (!identity.ok) { stderr.write(`${identity.reason}\n`); return 1; }
  const runtime = readRuntimeFiles(path.resolve(deps.projectRoot || getProjectRoot()), identity);
  if (!runtime.ok) { stderr.write(`${runtime.reason}\n`); return 1; }
  try {
    if (parsed.command === 'status') {
      const response = await requestJson(runtime.runtime.origin, '/api/cli/snapshot', { token: runtime.credential.token });
      const output = response.payload?.ok
        ? { ok: true, role: identity.role, origin: runtime.runtime.origin, messages: response.payload.snapshot.messages.length }
        : response.payload;
      stdout.write(parsed.json ? `${JSON.stringify(output, null, 2)}\n` : `${output.ok ? 'Team Room connected' : output.reason}\n`);
      return output.ok ? 0 : 1;
    }
    if (parsed.command === 'list') {
      const response = await requestJson(runtime.runtime.origin, '/api/cli/snapshot', { token: runtime.credential.token });
      if (!response.payload?.ok) { stderr.write(`${response.payload?.reason || 'room_cli_list_failed'}\n`); return 1; }
      stdout.write(parsed.json
        ? `${JSON.stringify(response.payload.snapshot, null, 2)}\n`
        : `${renderMessages(response.payload.snapshot)}\n`);
      return 0;
    }
    const body = parsed.stdin
      ? fs.readFileSync(0, 'utf8').replace(/\r\n/gu, '\n').trim()
      : parsed.bodyParts.join(' ').trim();
    if (!body) { stderr.write('room_cli_message_empty\n'); return 1; }
    if (parsed.command === 'reply' || parsed.command === 'post') {
      if (parsed.command === 'reply' && !parsed.activationId) {
        stderr.write('room_cli_activation_required\n');
        return 1;
      }
      if (parsed.command === 'post' && parsed.activationId) {
        stderr.write('room_cli_root_activation_forbidden\n');
        return 1;
      }
      if (parsed.command === 'post' && parsed.reentry) {
        stderr.write('room_cli_root_reentry_forbidden\n');
        return 1;
      }
      if (!Object.values(PARTICIPATION_REASONS).includes(parsed.reason)) {
        stderr.write('room_cli_participation_reason_invalid\n');
        return 1;
      }
      if (parsed.notificationClass && !Object.values(NOTIFICATION_CLASSES).includes(parsed.notificationClass)) {
        stderr.write('room_cli_notification_class_invalid\n');
        return 1;
      }
      if (parsed.notificationClass && !isRoomNotificationClassAllowed(parsed.notificationClass, parsed.reason)) {
        stderr.write('room_cli_notification_class_reason_mismatch\n');
        return 1;
      }
    }
    const payload = {
      body,
      clientNonce: `cli-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`,
      ...(parsed.notificationClass ? { notificationClass: parsed.notificationClass } : {}),
      ...(parsed.command === 'reply' ? {
        activationId: parsed.activationId,
        participationReason: parsed.reason,
        rootReentry: parsed.reentry,
      } : parsed.command === 'post' ? {
        agentInitiatedRoot: true,
        participationReason: parsed.reason,
      } : {}),
    };
    const response = await requestJson(runtime.runtime.origin, '/api/cli/messages', {
      method: 'POST',
      token: runtime.credential.token,
      body: payload,
    });
    if (!response.payload?.ok) { stderr.write(`${renderPostError(response.payload)}\n`); return 1; }
    stdout.write(parsed.json
      ? `${JSON.stringify(response.payload, null, 2)}\n`
      : `Posted to Team Room (${response.payload.message.messageId}).\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  IDENTITY_FLAGS,
  ROLE_BY_PANE,
  main,
  parseArgs,
  readRuntimeFiles,
  renderMessages,
  renderPostError,
  requestJson,
  resolveRuntimeRole,
  usage,
};
