'use strict';

const fs = require('fs');
const path = require('path');

const PROTOCOL = 'mira.hm_send_adapter.v0';
const ALLOWED_TARGETS = Object.freeze({
  architect: { role: 'architect', pane_id: '1' },
  builder: { role: 'builder', pane_id: '2' },
  oracle: { role: 'oracle', pane_id: '3' },
});

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function normalizePathForPayload(value) {
  return String(value || '').replace(/\\/g, '/');
}

function resolveProjectLink(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const explicitLinkPath = options.linkPath ? path.resolve(options.linkPath) : null;
  const linkPath = explicitLinkPath || path.join(cwd, '.squidrun', 'link.json');
  const link = readJsonFile(linkPath);
  return { linkPath, link };
}

function resolveSquidRunRoot(options = {}) {
  const { link } = resolveProjectLink(options);
  const fromLink = typeof link?.squidrun_root === 'string' ? link.squidrun_root.trim() : '';
  return path.resolve(options.squidrunRoot || fromLink || options.cwd || process.cwd());
}

function resolveWorkspace(options = {}) {
  const { link } = resolveProjectLink(options);
  const fromLink = typeof link?.workspace === 'string' ? link.workspace.trim() : '';
  return path.resolve(options.workspace || fromLink || options.cwd || process.cwd());
}

function resolveHmSendPath(options = {}) {
  const { link } = resolveProjectLink(options);
  const fromLink = typeof link?.comms?.hm_send === 'string' ? link.comms.hm_send.trim() : '';
  return path.resolve(options.hmSendPath || fromLink || path.join(resolveSquidRunRoot(options), 'ui', 'scripts', 'hm-send.js'));
}

function normalizeTargetRole(targetRole) {
  const normalized = String(targetRole || '').trim().toLowerCase();
  return ALLOWED_TARGETS[normalized] ? normalized : null;
}

function assertPaneTarget(targetRole) {
  const normalized = String(targetRole || '').trim().toLowerCase();
  const role = normalizeTargetRole(normalized);
  if (role) return role;

  const externalTargets = new Set(['telegram', 'user', 'external', 'web', 'browser']);
  const code = externalTargets.has(normalized)
    || normalized.startsWith('@')
    || /^https?:\/\//i.test(normalized)
    ? 'external_target_refused'
    : 'invalid_pane_target';

  throw Object.assign(new Error(`Mira hm-send adapter only targets SquidRun panes: architect, builder, oracle. Refused '${targetRole}'.`), {
    code,
    targetRole,
  });
}

function buildPaneMessageEnvelope(input = {}, options = {}) {
  const targetRole = assertPaneTarget(input.targetRole || input.target?.role);
  const content = String(input.content || '').trim();
  if (!content) {
    throw Object.assign(new Error('Mira pane message content cannot be empty.'), { code: 'empty_message' });
  }

  const now = Number.isFinite(Number(input.timestampMs)) ? Number(input.timestampMs) : Date.now();
  const messageId = String(input.messageId || `mira-pane-${now}`);
  const sessionId = input.sessionId || options.sessionId || resolveProjectLink(options).link?.session_id || null;
  const workspace = normalizePathForPayload(resolveWorkspace(options));
  const target = ALLOWED_TARGETS[targetRole];

  return {
    protocol: PROTOCOL,
    request_id: String(input.requestId || `req-${messageId}`),
    message_id: messageId,
    session_id: sessionId,
    timestamp_ms: now,
    source: {
      service: 'mira-runtime',
      surface: input.surface || 'mira-bridge',
      adapter: 'hm-send',
    },
    target: {
      system: 'squidrun',
      role: target.role,
      pane_id: target.pane_id,
    },
    workspace,
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    body: {
      content,
    },
  };
}

function buildHmSendCommand(envelope, options = {}) {
  const targetRole = assertPaneTarget(envelope?.target?.role);
  const hmSendPath = resolveHmSendPath(options);
  return {
    executable: process.execPath,
    args: [
      hmSendPath,
      targetRole,
      '--stdin',
      '--role',
      'mira',
      '--no-fallback',
    ],
    stdin: envelope.body.content,
    cwd: resolveSquidRunRoot(options),
  };
}

function createDryRunResult(envelope, command) {
  return {
    ok: true,
    dryRun: true,
    protocol: PROTOCOL,
    message_id: envelope.message_id,
    session_id: envelope.session_id,
    delivery: {
      status: 'dry_run',
      target_role: envelope.target.role,
      target_pane_id: envelope.target.pane_id,
      channel: 'hm-send',
      transport: 'ui/scripts/hm-send.js',
    },
    envelope,
    command,
  };
}

function planPaneMessage(input = {}, options = {}) {
  const envelope = buildPaneMessageEnvelope(input, options);
  const command = buildHmSendCommand(envelope, options);
  return createDryRunResult(envelope, command);
}

module.exports = {
  PROTOCOL,
  ALLOWED_TARGETS,
  assertPaneTarget,
  buildPaneMessageEnvelope,
  buildHmSendCommand,
  planPaneMessage,
};
