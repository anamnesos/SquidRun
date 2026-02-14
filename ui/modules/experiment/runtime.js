const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const pty = require('node-pty');
const { WORKSPACE_PATH } = require('../../config');
const log = require('../logger');
const { TeamMemoryStore } = require('../team-memory/store');
const { TeamMemoryClaims } = require('../team-memory/claims');
const { EvidenceLedgerStore } = require('../main/evidence-ledger-store');
const {
  DEFAULT_PROFILES_PATH,
  loadExperimentProfiles,
  resolveProfileAndCommand,
  buildExperimentEnv,
  fingerprintEnv,
} = require('./profiles');

const DEFAULT_DB_PATH = path.join(WORKSPACE_PATH, 'runtime', 'team-memory.sqlite');
const DEFAULT_ARTIFACT_ROOT = path.join(WORKSPACE_PATH, 'runtime', 'experiments');
const DEFAULT_EVIDENCE_LEDGER_DB_PATH = path.join(WORKSPACE_PATH, 'runtime', 'evidence-ledger.db');
const DEFAULT_OUTPUT_CAP_BYTES = 1024 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const STATUS_SET = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'canceled',
  'attach_pending',
  'attached',
]);

let sharedRuntime = null;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asNullableString(value) {
  const text = asString(value, '');
  return text || null;
}

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function asTimestamp(value, fallback = Date.now()) {
  const numeric = asNumber(value, fallback);
  if (!Number.isFinite(numeric) || numeric < 0) return Math.floor(fallback);
  return Math.floor(numeric);
}

function toId(prefix) {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function deriveEvidenceRelation(phaseStatus, fallback = 'supports') {
  if (phaseStatus === 'succeeded') return 'supports';
  if (phaseStatus === 'failed' || phaseStatus === 'timed_out' || phaseStatus === 'canceled') return 'contradicts';
  return fallback;
}

function hashText(value = '') {
  return crypto.createHash('sha256').update(String(value), 'utf-8').digest('hex');
}

function encodeCursor(value = {}) {
  const json = JSON.stringify(value);
  return Buffer.from(json, 'utf-8').toString('base64url');
}

function decodeCursor(value) {
  const cursor = asString(value, '');
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(decoded);
    const createdAt = asPositiveInt(parsed.createdAt, null);
    const id = asString(parsed.id, '');
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function quotePathForShell(filePath) {
  return `"${String(filePath).replace(/"/g, '\\"')}"`;
}

function buildShellInvocation(command, stdoutPath, stderrPath) {
  const stdoutQuoted = quotePathForShell(stdoutPath);
  const stderrQuoted = quotePathForShell(stderrPath);
  const redirected = `${command} 1> ${stdoutQuoted} 2> ${stderrQuoted}`;

  if (process.platform === 'win32') {
    const shell = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    return { shell, args: ['/d', '/s', '/c', redirected] };
  }

  return {
    shell: '/bin/bash',
    args: ['-lc', redirected],
  };
}

function killProcessTree(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(numericPid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    spawnSync('pkill', ['-TERM', '-P', String(numericPid)], {
      stdio: 'ignore',
    });
  } catch {
    // Best effort child kill.
  }

  try {
    process.kill(numericPid, 'SIGKILL');
  } catch {
    // Best effort kill.
  }
}

function truncateUtf8(value = '', maxBytes = DEFAULT_OUTPUT_CAP_BYTES) {
  const text = String(value || '');
  const limit = asPositiveInt(maxBytes, DEFAULT_OUTPUT_CAP_BYTES) || DEFAULT_OUTPUT_CAP_BYTES;
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.byteLength <= limit) {
    return {
      text,
      bytes: buffer.byteLength,
      truncated: false,
    };
  }
  const sliced = buffer.subarray(0, limit).toString('utf-8');
  return {
    text: sliced,
    bytes: limit,
    truncated: true,
  };
}

function parseRedactionRules(rawRules) {
  if (!Array.isArray(rawRules)) return [];
  const rules = [];
  for (const entry of rawRules) {
    if (typeof entry === 'string' && entry.trim()) {
      const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rules.push(new RegExp(escaped, 'g'));
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const pattern = asString(entry.pattern, '');
    if (!pattern) continue;
    const flags = asString(entry.flags, 'g');
    try {
      rules.push(new RegExp(pattern, flags));
    } catch {
      // ignore invalid regex
    }
  }
  return rules;
}

function applyRedaction(text, rules = []) {
  let output = String(text || '');
  let redacted = false;
  for (const rule of rules) {
    const next = output.replace(rule, '[REDACTED]');
    if (next !== output) redacted = true;
    output = next;
  }
  return { text: output, redacted };
}

function readTextFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function getGitFingerprint(cwd) {
  const target = asString(cwd, path.join(WORKSPACE_PATH, '..'));
  const fallback = { sha: null, branch: null, dirty: null };
  try {
    const sha = asString(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf-8' }), '');
    const branch = asString(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, encoding: 'utf-8' }), '');
    const porcelain = asString(execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf-8' }), '');
    return {
      sha: sha || null,
      branch: branch || null,
      dirty: porcelain.length > 0,
    };
  } catch {
    return fallback;
  }
}

function normalizeGuardContext(value) {
  const guard = asObject(value);
  const guardId = asNullableString(guard.guardId || guard.guard_id);
  const action = asNullableString(guard.action);
  const blocking = guard.blocking === true;
  if (!guardId && !action && !blocking) return null;
  return {
    guardId,
    action,
    blocking,
  };
}

class ExperimentRuntime {
  constructor(options = {}) {
    this.options = asObject(options);
    this.dbPath = asString(this.options.dbPath, DEFAULT_DB_PATH);
    this.artifactRoot = asString(this.options.artifactRoot, DEFAULT_ARTIFACT_ROOT);
    this.profilesPath = asString(this.options.profilesPath, DEFAULT_PROFILES_PATH);
    this.evidenceLedgerDbPath = asString(this.options.evidenceLedgerDbPath, DEFAULT_EVIDENCE_LEDGER_DB_PATH);
    this.store = null;
    this.claims = null;
    this.profiles = {};
    this.queue = [];
    this.currentRun = null;
    this.runMetaCache = new Map();
  }

  init(initOptions = {}) {
    this.store = new TeamMemoryStore({ dbPath: this.dbPath });
    const initResult = this.store.init({
      nowMs: initOptions.nowMs,
    });
    if (!initResult.ok) {
      return {
        ok: false,
        reason: initResult.reason || 'db_init_failed',
        status: this.store.getStatus(),
      };
    }
    this.claims = new TeamMemoryClaims(this.store.db);

    const profilesResult = loadExperimentProfiles({
      profilesPath: this.profilesPath,
    });
    if (!profilesResult.ok) {
      return {
        ok: false,
        reason: profilesResult.reason || 'profiles_unavailable',
        error: profilesResult.error || null,
        status: this.store.getStatus(),
      };
    }
    this.profiles = profilesResult.profiles;
    this.profilesPath = profilesResult.profilesPath;

    try {
      fs.mkdirSync(this.artifactRoot, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        reason: 'artifact_root_error',
        error: err.message,
        status: this.store.getStatus(),
      };
    }

    return {
      ok: true,
      status: this.store.getStatus(),
      profileCount: Object.keys(this.profiles).length,
      profilesPath: this.profilesPath,
      artifactRoot: this.artifactRoot,
      evidenceLedgerDbPath: this.evidenceLedgerDbPath,
    };
  }

  isAvailable() {
    return Boolean(this.store && this.store.isAvailable() && this.store.db);
  }

  close() {
    if (this.currentRun?.ptyProcess?.pid) {
      killProcessTree(this.currentRun.ptyProcess.pid);
    }
    this.currentRun = null;
    this.queue = [];
    this.claims = null;
    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }

  getStatus() {
    return {
      ok: this.isAvailable(),
      running: Boolean(this.currentRun),
      queued: this.queue.length,
      dbStatus: this.store?.getStatus?.() || null,
      profileCount: Object.keys(this.profiles || {}).length,
      profilesPath: this.profilesPath,
      artifactRoot: this.artifactRoot,
      evidenceLedgerDbPath: this.evidenceLedgerDbPath,
    };
  }

  execute(action, payload = {}) {
    const normalizedAction = asString(action, '').toLowerCase();
    const input = asObject(payload);

    switch (normalizedAction) {
      case 'health':
        return this.getStatus();

      case 'create-experiment':
      case 'run-experiment':
      case 'run_experiment':
        return this.createExperiment(input);

      case 'get-experiment':
        return this.getExperiment(input);

      case 'list-experiments':
        return this.listExperiments(input);

      case 'attach-to-claim':
        return this.attachToClaim(input);

      default:
        return {
          ok: false,
          reason: 'unknown_action',
          action: normalizedAction || action || null,
        };
    }
  }

  createExperiment(payload = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const resolved = resolveProfileAndCommand(payload, this.profiles);
    if (!resolved.ok) {
      return {
        ok: false,
        status: 'rejected',
        accepted: false,
        queued: false,
        reason: resolved.reason || 'invalid_profile',
        profileId: resolved.profileId || null,
      };
    }

    const request = asObject(payload);
    const requestedBy = asString(request.requestedBy || request.requested_by || request.owner, 'system');
    const claimId = asNullableString(request.claimId || request.claim_id);
    const relation = asNullableString(request.relation);
    const session = asNullableString(request.session);
    const idempotencyKey = asNullableString(request.idempotencyKey || request.idempotency_key);
    const guardContext = normalizeGuardContext(request.guardContext || request.guard_context);
    const outputCapBytes = asPositiveInt(request.outputCapBytes ?? request.output_cap_bytes, DEFAULT_OUTPUT_CAP_BYTES) || DEFAULT_OUTPUT_CAP_BYTES;
    const timeoutMs = asPositiveInt(resolved.timeoutMs, 30000) || 30000;
    const runId = asString(request.runId || request.run_id, toId('exp'));
    const artifactDir = path.join(this.artifactRoot, runId);
    const nowMs = asTimestamp(request.nowMs);
    const wasBusy = Boolean(this.currentRun || this.queue.length > 0);

    if (idempotencyKey) {
      const existing = this.store.db.prepare(`
        SELECT id
        FROM experiments
        WHERE idempotency_key = ?
        LIMIT 1
      `).get(idempotencyKey);
      if (existing?.id) {
        const snapshot = this.getExperiment({ runId: existing.id });
        return {
          ok: true,
          status: 'duplicate',
          accepted: true,
          queued: snapshot?.experiment?.status === 'queued' || snapshot?.experiment?.status === 'running',
          runId: existing.id,
          artifactDir: snapshot?.experiment?.artifactDir || path.join(this.artifactRoot, existing.id),
          experiment: snapshot?.experiment || null,
        };
      }
    }

    try {
      fs.mkdirSync(artifactDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        status: 'rejected',
        accepted: false,
        queued: false,
        reason: 'artifact_dir_error',
        error: err.message,
      };
    }

    try {
      this.store.db.prepare(`
        INSERT INTO experiments (
          id, idempotency_key, claim_id, profile, command, requested_by, relation,
          guard_context, status, timeout_ms, output_cap_bytes, artifact_dir, cwd,
          session, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        idempotencyKey,
        claimId,
        resolved.profileId, // profileId -> profile DB mapper
        resolved.command,
        requestedBy,
        relation,
        guardContext ? JSON.stringify(guardContext) : null,
        'queued',
        timeoutMs,
        outputCapBytes,
        artifactDir,
        resolved.cwd,
        session,
        nowMs,
        nowMs
      );
    } catch (err) {
      return {
        ok: false,
        status: 'rejected',
        accepted: false,
        queued: false,
        reason: 'db_error',
        error: err.message,
      };
    }

    const queueItem = {
      runId,
      profileId: resolved.profileId,
      command: resolved.command,
      cwd: resolved.cwd,
      claimId,
      relation,
      requestedBy,
      timeoutMs,
      outputCapBytes,
      redactionRules: request.redactionRules,
      session,
      input: asObject(request.input),
      guardContext,
      artifactDir,
      createdAt: nowMs,
    };
    this.queue.push(queueItem);
    this.drainQueue();

    return {
      ok: true,
      accepted: true,
      queued: wasBusy,
      runId,
      profileId: resolved.profileId,
      status: wasBusy ? 'queued' : 'running',
      artifactDir,
    };
  }

  getExperiment(payload = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };
    const runId = asString(payload.runId || payload.run_id || payload.id, '');
    if (!runId) return { ok: false, reason: 'run_id_required' };

    const row = this.store.db.prepare(`
      SELECT *
      FROM experiments
      WHERE id = ?
      LIMIT 1
    `).get(runId);
    if (!row) {
      return { ok: false, reason: 'experiment_not_found', runId };
    }

    return {
      ok: true,
      experiment: this.mapExperimentRow(row),
    };
  }

  listExperiments(payload = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable', experiments: [] };
    const filters = asObject(payload);
    const clauses = ['1 = 1'];
    const params = [];

    const status = asString(filters.status, '').toLowerCase();
    if (status && STATUS_SET.has(status)) {
      clauses.push('status = ?');
      params.push(status);
    }

    const profileId = asString(filters.profileId || filters.profile || filters.profile_id, '').toLowerCase();
    if (profileId) {
      clauses.push('profile = ?');
      params.push(profileId);
    }

    const claimId = asString(filters.claimId || filters.claim_id, '');
    if (claimId) {
      clauses.push('claim_id = ?');
      params.push(claimId);
    }

    const guardId = asString(filters.guardId || filters.guard_id, '');
    if (guardId) {
      clauses.push(`guard_context LIKE ?`);
      params.push(`%"guardId":"${guardId.replace(/"/g, '\\"')}"%`);
    }

    const sinceMs = asPositiveInt(filters.sinceMs ?? filters.since, null);
    if (sinceMs) {
      clauses.push('created_at >= ?');
      params.push(sinceMs);
    }

    const untilMs = asPositiveInt(filters.untilMs ?? filters.until, null);
    if (untilMs) {
      clauses.push('created_at <= ?');
      params.push(untilMs);
    }

    const cursor = decodeCursor(filters.cursor);
    if (cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, asPositiveInt(filters.limit, DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT));
    const rows = this.store.db.prepare(`
      SELECT *
      FROM experiments
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit + 1);

    const next = rows.length > limit ? rows.pop() : null;
    const experiments = rows.map((row) => this.mapExperimentRow(row, { summaryOnly: true }));
    const nextCursor = next
      ? encodeCursor({ createdAt: Number(next.created_at || 0), id: String(next.id) })
      : null;

    return {
      ok: true,
      experiments,
      nextCursor,
    };
  }

  attachToClaim(payload = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };
    const runId = asString(payload.runId || payload.run_id || payload.id, '');
    const claimId = asString(payload.claimId || payload.claim_id, '');
    const relation = asString(payload.relation, '').toLowerCase();
    const addedBy = asString(payload.addedBy || payload.added_by || payload.owner, 'system');
    if (!runId || !claimId || !relation) {
      return { ok: false, reason: 'run_id_claim_id_relation_required' };
    }

    const row = this.store.db.prepare(`
      SELECT status, evidence_ref, relation
      FROM experiments
      WHERE id = ?
      LIMIT 1
    `).get(runId);
    if (!row) {
      return { ok: false, reason: 'experiment_not_found', runId };
    }

    if (row.status === 'attached') {
      return {
        ok: true,
        status: 'duplicate',
        runId,
        claimId,
        relation,
        addedBy,
      };
    }

    const evidenceEventId = asString(row.evidence_ref, '');
    if (!evidenceEventId) {
      return {
        ok: false,
        status: 'not_attachable',
        reason: 'evidence_event_missing',
        runId,
        claimId,
        relation,
        addedBy,
      };
    }

    const finalRelation = relation || asString(row.relation, 'supports') || 'supports';
    const addEvidenceResult = this.claims?.addEvidence(claimId, evidenceEventId, finalRelation, {
      addedBy,
      nowMs: payload.nowMs,
    });
    if (!addEvidenceResult?.ok) {
      return {
        ok: false,
        status: 'not_attachable',
        reason: addEvidenceResult?.reason || 'claim_evidence_failed',
        runId,
        claimId,
        relation: finalRelation,
        addedBy,
      };
    }

    const updatedAt = asTimestamp(payload.nowMs);
    this.store.db.prepare(`
      UPDATE experiments
      SET claim_id = ?, relation = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(claimId, finalRelation, 'attached', updatedAt, runId);

    return {
      ok: true,
      status: addEvidenceResult.status === 'duplicate' ? 'duplicate' : 'attached',
      runId,
      claimId,
      relation: finalRelation,
      addedBy,
      evidenceEventId,
    };
  }

  mapExperimentRow(row, options = {}) {
    const summaryOnly = options.summaryOnly === true;
    const runId = String(row.id);
    const artifactDir = asString(row.artifact_dir, path.join(this.artifactRoot, runId));
    const metaPath = path.join(artifactDir, 'meta.json');
    const resultPath = path.join(artifactDir, 'result.json');
    const stdoutPath = path.join(artifactDir, 'stdout.log');
    const stderrPath = path.join(artifactDir, 'stderr.log');
    let meta = this.runMetaCache.get(runId);
    if (!meta && fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        this.runMetaCache.set(runId, meta);
      } catch {
        meta = null;
      }
    }

    const base = {
      runId,
      profileId: asString(row.profile, null),
      status: asString(row.status, 'queued'),
      requestedBy: asString(row.requested_by, 'system'),
      claimId: asNullableString(row.claim_id),
      relation: asNullableString(row.relation),
      guardContext: (() => {
        try {
          return row.guard_context ? JSON.parse(row.guard_context) : null;
        } catch {
          return null;
        }
      })(),
      createdAt: Number(row.created_at || 0),
      startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
      finishedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      timeoutMs: row.timeout_ms === null || row.timeout_ms === undefined ? null : Number(row.timeout_ms),
      commandPreview: asString(row.command, null),
      artifactDir,
      output: {
        stdoutBytes: Number(row.stdout_bytes || 0),
        stderrBytes: Number(row.stderr_bytes || 0),
        truncated: Number(row.truncated || 0) === 1,
        redacted: Number(row.redacted || 0) === 1,
      },
      attach: {
        evidenceEventId: asNullableString(row.evidence_ref),
        claimEvidenceStatus: row.status === 'attached' ? 'attached' : null,
      },
    };

    if (summaryOnly) return base;

    return {
      ...base,
      cwd: asNullableString(row.cwd) || asNullableString(meta?.cwd),
      git: {
        sha: asNullableString(row.git_sha) || asNullableString(meta?.git?.sha),
        branch: asNullableString(meta?.git?.branch),
        dirty: typeof meta?.git?.dirty === 'boolean' ? meta.git.dirty : null,
      },
      files: {
        stdout: stdoutPath,
        stderr: stderrPath,
        meta: metaPath,
        result: resultPath,
      },
      error: asNullableString(row.error_message) || asNullableString(meta?.error),
    };
  }

  appendExperimentCompletedLedgerEvent(details = {}) {
    const runId = asString(details.runId, '');
    if (!runId) {
      return {
        ok: false,
        reason: 'run_id_required',
        evidenceEventId: null,
      };
    }

    const store = new EvidenceLedgerStore({
      dbPath: this.evidenceLedgerDbPath,
      enabled: true,
    });
    const initResult = store.init();
    if (!initResult?.ok) {
      store.close();
      return {
        ok: false,
        reason: initResult?.reason || 'ledger_unavailable',
        evidenceEventId: null,
      };
    }

    const artifactDir = asString(details.artifactDir, path.join(this.artifactRoot, runId));
    const stdoutPath = path.join(artifactDir, 'stdout.log');
    const stderrPath = path.join(artifactDir, 'stderr.log');
    const metaPath = path.join(artifactDir, 'meta.json');
    const resultPath = path.join(artifactDir, 'result.json');
    const completedAt = asTimestamp(details.completedAt);
    const evidenceEventId = `evt_experiment_${runId}`;
    const traceId = asString(details.traceId || details.guardId, '') || `trc_experiment_${runId}`;
    const payload = {
      runId,
      claimId: asNullableString(details.claimId),
      profileId: asNullableString(details.profileId),
      status: asNullableString(details.phaseStatus),
      exitCode: details.exitCode === null || details.exitCode === undefined ? null : Number(details.exitCode),
      timedOut: details.timedOut === true,
      durationMs: Number(details.durationMs || 0),
      artifactDir,
      commandPreview: asNullableString(details.commandPreview),
      output: {
        stdoutBytes: Number(details.stdoutBytes || 0),
        stderrBytes: Number(details.stderrBytes || 0),
        truncated: details.truncated === true,
        redacted: details.redacted === true,
      },
      hashes: {
        stdout: asNullableString(details.stdoutHash),
        stderr: asNullableString(details.stderrHash),
      },
      files: {
        stdout: stdoutPath,
        stderr: stderrPath,
        meta: metaPath,
        result: resultPath,
      },
      guardContext: details.guardContext || null,
      git: details.git || null,
    };

    const appendResult = store.appendEvent({
      eventId: evidenceEventId,
      traceId,
      parentEventId: asNullableString(details.parentEventId),
      type: 'experiment.completed',
      stage: 'experiment',
      source: 'team-memory.experiment-worker',
      paneId: '2',
      role: asString(details.requestedBy, 'system'),
      ts: completedAt,
      direction: 'internal',
      payload,
      evidenceRefs: [
        {
          kind: 'file',
          path: stdoutPath,
          hash: asString(details.stdoutHash, ''),
          note: 'experiment stdout',
        },
        {
          kind: 'file',
          path: stderrPath,
          hash: asString(details.stderrHash, ''),
          note: 'experiment stderr',
        },
        {
          kind: 'file',
          path: metaPath,
          hash: '',
          note: 'experiment metadata',
        },
      ],
      meta: {
        runId,
        guardId: asNullableString(details.guardId),
        action: asNullableString(details.guardAction),
      },
    }, {
      sessionId: asNullableString(details.session),
      nowMs: completedAt,
      ingestedAtMs: completedAt,
    });
    store.close();

    if (!appendResult?.ok) {
      return {
        ok: false,
        reason: appendResult?.reason || appendResult?.status || 'ledger_append_failed',
        evidenceEventId: null,
      };
    }

    return {
      ok: true,
      status: appendResult.status || 'inserted',
      evidenceEventId,
    };
  }

  drainQueue() {
    if (!this.isAvailable()) return;
    if (this.currentRun) return;
    if (this.queue.length === 0) return;

    const next = this.queue.shift();
    this.currentRun = next;
    this.runExperiment(next)
      .catch((err) => {
        log.error('ExperimentRuntime', `Experiment ${next.runId} failed unexpectedly: ${err.message}`);
      })
      .finally(() => {
        this.currentRun = null;
        setImmediate(() => this.drainQueue());
      });
  }

  async runExperiment(job) {
    const nowMs = Date.now();
    this.store.db.prepare(`
      UPDATE experiments
      SET status = ?, started_at = ?, updated_at = ?
      WHERE id = ?
    `).run('running', nowMs, nowMs, job.runId);

    const rawStdoutPath = path.join(job.artifactDir, 'stdout.raw.log');
    const rawStderrPath = path.join(job.artifactDir, 'stderr.raw.log');
    const stdoutPath = path.join(job.artifactDir, 'stdout.log');
    const stderrPath = path.join(job.artifactDir, 'stderr.log');
    const metaPath = path.join(job.artifactDir, 'meta.json');
    const resultPath = path.join(job.artifactDir, 'result.json');
    const completedAtDefault = Date.now();

    const env = buildExperimentEnv(asObject(job.input).envAllowlist);
    const envFingerprint = fingerprintEnv(env);
    const invocation = buildShellInvocation(job.command, rawStdoutPath, rawStderrPath);
    const startedAt = Date.now();

    const runResult = await new Promise((resolve) => {
      let timedOut = false;
      let settled = false;
      const ptyProcess = pty.spawn(invocation.shell, invocation.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: job.cwd,
        env,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          killProcessTree(ptyProcess.pid);
        } catch {
          // best effort
        }
      }, job.timeoutMs);

      this.currentRun = {
        ...job,
        ptyProcess,
      };

      ptyProcess.onExit(({ exitCode }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: Number.isFinite(exitCode) ? exitCode : null,
          timedOut,
          pid: ptyProcess.pid,
          startedAt,
          completedAt: Date.now(),
        });
      });
    });

    const stdoutRaw = readTextFileSafe(rawStdoutPath);
    const stderrRaw = readTextFileSafe(rawStderrPath);
    const rules = parseRedactionRules(job.redactionRules);
    const stdoutRedacted = applyRedaction(stdoutRaw, rules);
    const stderrRedacted = applyRedaction(stderrRaw, rules);
    const stdoutCapped = truncateUtf8(stdoutRedacted.text, job.outputCapBytes);
    const stderrCapped = truncateUtf8(stderrRedacted.text, job.outputCapBytes);
    const truncated = stdoutCapped.truncated || stderrCapped.truncated;
    const redacted = stdoutRedacted.redacted || stderrRedacted.redacted;
    const stdoutHash = hashText(stdoutCapped.text);
    const stderrHash = hashText(stderrCapped.text);
    const git = getGitFingerprint(job.cwd);
    const completedAt = asTimestamp(runResult.completedAt, completedAtDefault);
    const durationMs = Math.max(0, completedAt - startedAt);
    const phaseStatus = runResult.timedOut
      ? 'timed_out'
      : (runResult.exitCode === 0 ? 'succeeded' : 'failed');
    let finalStatus = phaseStatus;
    let evidenceRef = null;
    let attachResult = null;
    let errorMessage = runResult.timedOut ? `Timed out after ${job.timeoutMs}ms` : null;

    fs.writeFileSync(stdoutPath, stdoutCapped.text, 'utf-8');
    fs.writeFileSync(stderrPath, stderrCapped.text, 'utf-8');

    const meta = {
      runId: job.runId,
      profileId: job.profileId,
      commandPreview: job.command,
      requestedBy: job.requestedBy,
      claimId: job.claimId,
      relation: job.relation,
      guardContext: job.guardContext,
      cwd: job.cwd,
      git,
      envFingerprint,
      timeoutMs: job.timeoutMs,
      outputCapBytes: job.outputCapBytes,
      startedAt,
      completedAt,
      durationMs,
      exitCode: runResult.exitCode,
      timedOut: runResult.timedOut,
      output: {
        stdoutBytes: stdoutCapped.bytes,
        stderrBytes: stderrCapped.bytes,
        truncated,
        redacted,
      },
      hashes: {
        stdout: stdoutHash,
        stderr: stderrHash,
      },
      artifacts: {
        stdout: stdoutPath,
        stderr: stderrPath,
      },
    };

    const eventResult = this.appendExperimentCompletedLedgerEvent({
      runId: job.runId,
      claimId: job.claimId,
      profileId: job.profileId,
      commandPreview: job.command,
      requestedBy: job.requestedBy,
      guardContext: job.guardContext,
      guardId: job.guardContext?.guardId || null,
      guardAction: job.guardContext?.action || null,
      session: job.session,
      phaseStatus,
      exitCode: runResult.exitCode,
      timedOut: runResult.timedOut,
      durationMs,
      completedAt,
      artifactDir: job.artifactDir,
      stdoutBytes: stdoutCapped.bytes,
      stderrBytes: stderrCapped.bytes,
      truncated,
      redacted,
      stdoutHash,
      stderrHash,
      git,
      traceId: asNullableString(job.input?.traceId || job.input?.trace_id || job.guardContext?.traceId),
      parentEventId: asNullableString(job.input?.parentEventId || job.input?.parent_event_id || job.guardContext?.parentEventId),
    });
    evidenceRef = eventResult?.evidenceEventId || null;
    if (!eventResult?.ok) {
      errorMessage = [errorMessage, `ledger_event_failed:${eventResult?.reason || 'unknown'}`].filter(Boolean).join('; ');
    }

    if (job.claimId) {
      if (evidenceRef) {
        const relationFromResult = deriveEvidenceRelation(
          phaseStatus,
          asString(job.relation, 'supports').toLowerCase() || 'supports'
        );
        const addEvidenceResult = this.claims?.addEvidence(
          job.claimId,
          evidenceRef,
          relationFromResult,
          {
            addedBy: job.requestedBy || 'system',
            nowMs: completedAt,
          }
        );

        if (addEvidenceResult?.ok) {
          attachResult = {
            ok: true,
            status: addEvidenceResult.status,
            relation: relationFromResult,
            claimStatusUpdate: null,
          };
          finalStatus = 'attached';

          const claimSnapshot = this.claims?.getClaim(job.claimId);
          if (claimSnapshot?.status === 'pending_proof') {
            const nextStatus = phaseStatus === 'succeeded' ? 'confirmed' : 'contested';
            const claimStatusUpdate = this.claims.updateClaimStatus(
              job.claimId,
              nextStatus,
              job.requestedBy || 'system',
              `experiment_${phaseStatus}`,
              completedAt
            );
            attachResult.claimStatusUpdate = claimStatusUpdate;
            if (!claimStatusUpdate?.ok) {
              errorMessage = [errorMessage, `claim_status_update_failed:${claimStatusUpdate?.reason || 'unknown'}`].filter(Boolean).join('; ');
            }
          }
        } else {
          finalStatus = 'attach_pending';
          errorMessage = [errorMessage, `claim_evidence_failed:${addEvidenceResult?.reason || 'unknown'}`].filter(Boolean).join('; ');
        }
      } else {
        finalStatus = 'attach_pending';
      }
    }

    if (!job.claimId && eventResult?.ok && evidenceRef) {
      meta.evidenceEventId = evidenceRef;
    }
    if (job.claimId) {
      meta.attach = {
        evidenceEventId: evidenceRef,
        status: finalStatus,
        relation: attachResult?.relation || null,
        claimStatusUpdate: attachResult?.claimStatusUpdate || null,
      };
    }

    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(resultPath, `${JSON.stringify({ ok: true, ...meta }, null, 2)}\n`, 'utf-8');
    this.runMetaCache.set(job.runId, meta);

    this.store.db.prepare(`
      UPDATE experiments
      SET status = ?,
          exit_code = ?,
          duration_ms = ?,
          stdout_hash = ?,
          stderr_hash = ?,
          git_sha = ?,
          evidence_ref = ?,
          relation = COALESCE(?, relation),
          completed_at = ?,
          updated_at = ?,
          stdout_bytes = ?,
          stderr_bytes = ?,
          truncated = ?,
          redacted = ?,
          error_message = ?
      WHERE id = ?
    `).run(
      finalStatus,
      runResult.exitCode,
      durationMs,
      stdoutHash,
      stderrHash,
      git.sha,
      evidenceRef,
      attachResult?.relation || null,
      completedAt,
      completedAt,
      stdoutCapped.bytes,
      stderrCapped.bytes,
      truncated ? 1 : 0,
      redacted ? 1 : 0,
      errorMessage || null,
      job.runId
    );

    try {
      fs.unlinkSync(rawStdoutPath);
    } catch {
      // best effort
    }
    try {
      fs.unlinkSync(rawStderrPath);
    } catch {
      // best effort
    }
  }
}

function asRuntimeOptions(value = {}) {
  return asObject(value);
}

function createExperimentRuntime(options = {}) {
  const runtime = new ExperimentRuntime(asRuntimeOptions(options));
  const initResult = runtime.init(options);
  return {
    runtime,
    initResult,
  };
}

function initializeExperimentRuntime(options = {}) {
  const opts = asObject(options);
  const runtimeOptions = asRuntimeOptions(opts.runtimeOptions);
  const forceRuntimeRecreate = opts.forceRuntimeRecreate === true;
  const recreateUnavailable = opts.recreateUnavailable !== false;

  if (forceRuntimeRecreate) {
    closeSharedRuntime();
  }

  if (sharedRuntime && recreateUnavailable && sharedRuntime.runtime?.isAvailable() !== true) {
    closeSharedRuntime();
  }

  if (!sharedRuntime) {
    sharedRuntime = createExperimentRuntime(runtimeOptions);
  }

  const current = sharedRuntime.runtime;
  return {
    ok: current?.isAvailable?.() === true,
    initResult: sharedRuntime.initResult,
    status: current?.getStatus?.() || null,
  };
}

function executeExperimentOperation(action, payload = {}, options = {}) {
  const opts = asObject(options);
  const runtimeOptions = asRuntimeOptions(opts.runtimeOptions);
  const forceRuntimeRecreate = opts.forceRuntimeRecreate === true;
  const recreateUnavailable = opts.recreateUnavailable !== false;

  if (forceRuntimeRecreate) {
    closeSharedRuntime();
  }
  if (sharedRuntime && recreateUnavailable && sharedRuntime.runtime?.isAvailable() !== true) {
    closeSharedRuntime();
  }
  if (!sharedRuntime) {
    sharedRuntime = createExperimentRuntime(runtimeOptions);
  }
  return sharedRuntime.runtime.execute(action, payload);
}

function closeSharedRuntime() {
  if (!sharedRuntime) return;
  try {
    sharedRuntime.runtime?.close?.();
  } catch {
    // best effort
  }
  sharedRuntime = null;
}

module.exports = {
  ExperimentRuntime,
  createExperimentRuntime,
  initializeExperimentRuntime,
  executeExperimentOperation,
  closeSharedRuntime,
  DEFAULT_DB_PATH,
  DEFAULT_ARTIFACT_ROOT,
  DEFAULT_OUTPUT_CAP_BYTES,
};
