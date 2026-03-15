const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getProjectRoot } = require('../../config');

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function normalizeStatement(statement) {
  return String(statement || '').replace(/\s+/g, ' ').trim();
}

function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function getSectionRange(lines, heading) {
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) return null;
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s+/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }
  return { startIndex, endIndex };
}

function appendBulletToSection(filePath, heading, statement) {
  const normalized = normalizeStatement(statement);
  ensureDir(filePath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${heading}\n\n- ${normalized}\n`);
    return { filePath, added: true, alreadyPresent: false };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const existingLines = raw.split(/\r?\n/);
  if (existingLines.some((line) => normalizeStatement(line.replace(/^[-*]\s+/, '')) === normalized)) {
    return { filePath, added: false, alreadyPresent: true };
  }

  const lines = existingLines.slice();
  const range = getSectionRange(lines, heading);
  if (!range) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(heading, '', `- ${normalized}`);
  } else {
    let insertAt = range.endIndex;
    while (insertAt > range.startIndex + 1 && lines[insertAt - 1] === '') {
      insertAt -= 1;
    }
    lines.splice(insertAt, 0, `- ${normalized}`);
  }

  const nextContent = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
  fs.writeFileSync(filePath, nextContent);
  return { filePath, added: true, alreadyPresent: false };
}

function resolveProjectRoot(options = {}) {
  const input = asObject(options);
  const explicit = asString(input.projectRoot || input.workspaceRoot || input.workspaceDir || '', '');
  return explicit ? path.resolve(explicit) : getProjectRoot();
}

function gitBlobShaFromContent(content = '') {
  const body = Buffer.from(String(content), 'utf8');
  return crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

function readFileOrEmpty(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function computeFileBlobSha(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return gitBlobShaFromContent(readFileOrEmpty(filePath));
}

function resolvePromotionTarget(entry = {}, projectRoot = getProjectRoot()) {
  const value = asObject(entry);
  const knowledgeDir = path.join(projectRoot, 'workspace', 'knowledge');
  const legacyCategory = asString(value.category, '').toLowerCase();
  const legacyDomain = asString(value.domain, '').toLowerCase();
  const memoryClass = asString(value.memory_class || value.memoryClass, '').toLowerCase();
  const scope = asObject(value.scope);

  if (memoryClass === 'user_preference' || legacyCategory === 'preference' || legacyDomain === 'user_preferences') {
    return {
      targetFile: 'workspace/knowledge/user-context.md',
      filePath: path.join(knowledgeDir, 'user-context.md'),
      heading: '## Observed Preferences',
    };
  }
  if (memoryClass === 'environment_quirk') {
    if (value.device_id || value.deviceId) {
      const deviceId = String(value.device_id || value.deviceId).toUpperCase();
      return {
        targetFile: 'workspace/knowledge/devices.md',
        filePath: path.join(knowledgeDir, 'devices.md'),
        heading: `## ${deviceId}`,
      };
    }
    return {
      targetFile: 'workspace/knowledge/environment.md',
      filePath: path.join(knowledgeDir, 'environment.md'),
      heading: '# Environment',
    };
  }
  if (memoryClass === 'procedural_rule' || legacyCategory === 'workflow' || legacyDomain === 'workflows') {
    return {
      targetFile: 'workspace/knowledge/workflows.md',
      filePath: path.join(knowledgeDir, 'workflows.md'),
      heading: '# Workflows',
    };
  }
  if (memoryClass === 'architecture_decision') {
    const project = asString(scope.project || scope.domain || '', '');
    if (project) {
      return {
        targetFile: 'workspace/knowledge/projects.md',
        filePath: path.join(knowledgeDir, 'projects.md'),
        heading: `## ${project}`,
      };
    }
    return {
      targetFile: 'ARCHITECTURE.md',
      filePath: path.join(projectRoot, 'ARCHITECTURE.md'),
      heading: '## Decisions',
    };
  }
  if (legacyCategory === 'system_state' || legacyDomain === 'system_architecture') {
    return {
      targetFile: 'workspace/knowledge/infrastructure.md',
      filePath: path.join(knowledgeDir, 'infrastructure.md'),
      heading: '# Infrastructure',
    };
  }
  if (legacyDomain === 'business_context') {
    return {
      targetFile: 'workspace/knowledge/user-context.md',
      filePath: path.join(knowledgeDir, 'user-context.md'),
      heading: '## Active Focus Areas',
    };
  }
  return {
    targetFile: 'workspace/knowledge/memory-pr-promotions.md',
    filePath: path.join(knowledgeDir, 'memory-pr-promotions.md'),
    heading: '# Memory PR Promotions',
  };
}

function buildPromotionPatch(entry = {}, target = {}) {
  const targetFile = asString(target.targetFile || '', '');
  const heading = asString(target.heading || '', '# Memory PR Promotions');
  const statement = normalizeStatement(entry.content || entry.statement || '');
  return [
    `--- a/${targetFile}`,
    `+++ b/${targetFile}`,
    `@@ ${heading}`,
    `+ - ${statement}`,
    '',
  ].join('\n');
}

function buildPromotionArtifacts(entry = {}, options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const target = resolvePromotionTarget(entry, projectRoot);
  const baseSha = computeFileBlobSha(target.filePath);
  return {
    target_file: target.targetFile,
    target_heading: target.heading,
    absolute_path: target.filePath,
    base_sha: baseSha,
    patch_text: buildPromotionPatch(entry, target),
  };
}

function buildConflictArtifactPath(candidateId, nowMs = Date.now(), options = {}) {
  const projectRoot = resolveProjectRoot(options);
  return path.join(projectRoot, '.squidrun', 'memory', 'conflicts', `${candidateId}-${nowMs}.json`);
}

function upsertConflictSignal(conflictEntry = {}, options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const signalPath = path.join(projectRoot, '.squidrun', 'memory', 'conflicts', 'pending.json');
  ensureDir(signalPath);
  let current = { pending: [] };
  try {
    current = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
  } catch {
    current = { pending: [] };
  }
  const pending = Array.isArray(current.pending) ? current.pending : [];
  const next = pending.filter((entry) => entry.candidate_id !== conflictEntry.candidate_id);
  next.push(conflictEntry);
  fs.writeFileSync(signalPath, `${JSON.stringify({ pending: next }, null, 2)}\n`);
  return signalPath;
}

class MemoryPromotionService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.projectRoot = resolveProjectRoot(options);
  }

  requireDb() {
    if (!this.db || typeof this.db.prepare !== 'function') {
      throw new Error('memory_promotion_db_unavailable');
    }
    return this.db;
  }

  listCandidates(options = {}) {
    const db = this.requireDb();
    const status = asString(options.status || 'pending', 'pending');
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : 50;
    const rows = db.prepare(`
      SELECT q.*, m.content, m.scope_json, m.device_id, m.session_id, m.lifecycle_state
      FROM memory_promotion_queue q
      JOIN memory_objects m ON m.memory_id = q.memory_id
      WHERE (? = 'all' OR q.status = ?)
      ORDER BY q.updated_at DESC, q.created_at DESC
      LIMIT ?
    `).all(status, status, limit);
    return {
      ok: true,
      candidates: rows.map((row) => ({
        ...row,
        scope: row.scope_json ? JSON.parse(row.scope_json) : null,
      })),
    };
  }

  getCandidate(candidateId) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT q.*, m.content, m.scope_json, m.device_id, m.session_id, m.lifecycle_state, m.status AS memory_status
      FROM memory_promotion_queue q
      JOIN memory_objects m ON m.memory_id = q.memory_id
      WHERE q.candidate_id = ?
      LIMIT 1
    `).get(String(candidateId || ''));
    if (!row) return null;
    return {
      ...row,
      scope: row.scope_json ? JSON.parse(row.scope_json) : null,
    };
  }

  getMemory(memoryId) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_objects
      WHERE memory_id = ?
      LIMIT 1
    `).get(String(memoryId || '')) || null;
  }

  updateCandidate(candidateId, patch = {}) {
    const db = this.requireDb();
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries({
      status: 'status',
      review_notes: 'review_notes',
      reviewed_by: 'reviewed_by',
      reviewed_at: 'reviewed_at',
      conflict_artifact_path: 'conflict_artifact_path',
      base_sha: 'base_sha',
      patch_text: 'patch_text',
      target_file: 'target_file',
      target_heading: 'target_heading',
    })) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    sets.push('updated_at = ?');
    values.push(patch.updated_at || Date.now());
    values.push(candidateId);
    db.prepare(`UPDATE memory_promotion_queue SET ${sets.join(', ')} WHERE candidate_id = ?`).run(...values);
  }

  updateMemory(memoryId, patch = {}) {
    const db = this.requireDb();
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries({
      status: 'status',
      lifecycle_state: 'lifecycle_state',
      promoted_at: 'promoted_at',
      last_access_session: 'last_access_session',
      stale_since_session: 'stale_since_session',
      stale_window_until_session: 'stale_window_until_session',
      archived_at: 'archived_at',
      useful_marked_at: 'useful_marked_at',
      correction_of: 'correction_of',
      supersedes: 'supersedes',
    })) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    sets.push('updated_at = ?');
    values.push(patch.updated_at || Date.now());
    values.push(memoryId);
    db.prepare(`UPDATE memory_objects SET ${sets.join(', ')} WHERE memory_id = ?`).run(...values);
  }

  insertConflictRecord(conflict = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_conflict_queue (
        conflict_id,
        candidate_id,
        memory_id,
        target_file,
        base_sha,
        current_sha,
        patch_text,
        artifact_path,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conflict.conflict_id,
      conflict.candidate_id,
      conflict.memory_id,
      conflict.target_file,
      conflict.base_sha || null,
      conflict.current_sha || null,
      conflict.patch_text || null,
      conflict.artifact_path || null,
      conflict.status || 'pending',
      conflict.created_at,
      conflict.updated_at
    );
  }

  approveCandidate(candidateId, options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
    const reviewer = asString(options.reviewer || 'architect', 'architect');
    const candidate = this.getCandidate(candidateId);
    if (!candidate) {
      return { ok: false, reason: 'candidate_not_found', candidateId };
    }
    if (candidate.status === 'promoted') {
      return { ok: true, status: 'promoted', candidateId, alreadyApplied: true };
    }

    const artifacts = buildPromotionArtifacts({
      ...candidate,
      memory_class: candidate.memory_class,
      content: candidate.content,
      scope: candidate.scope,
      device_id: candidate.device_id,
    }, { projectRoot: options.projectRoot || this.projectRoot });
    const currentSha = computeFileBlobSha(artifacts.absolute_path);
    const baseSha = candidate.base_sha || artifacts.base_sha;
    const patchText = candidate.patch_text || artifacts.patch_text;
    const targetFile = candidate.target_file || artifacts.target_file;
    const targetHeading = candidate.target_heading || artifacts.target_heading;

    if (baseSha && currentSha && baseSha !== currentSha) {
      const artifactPath = buildConflictArtifactPath(candidate.candidate_id, nowMs, {
        projectRoot: options.projectRoot || this.projectRoot,
      });
      ensureDir(artifactPath);
      const conflictPayload = {
        candidate_id: candidate.candidate_id,
        memory_id: candidate.memory_id,
        target_file: targetFile,
        base_sha: baseSha,
        current_sha: currentSha,
        patch_text: patchText,
        created_at: nowMs,
      };
      fs.writeFileSync(artifactPath, `${JSON.stringify(conflictPayload, null, 2)}\n`);
      upsertConflictSignal(conflictPayload, { projectRoot: options.projectRoot || this.projectRoot });

      this.insertConflictRecord({
        conflict_id: `conflict-${candidate.candidate_id}`,
        candidate_id: candidate.candidate_id,
        memory_id: candidate.memory_id,
        target_file: targetFile,
        base_sha: baseSha,
        current_sha: currentSha,
        patch_text: patchText,
        artifact_path: artifactPath,
        created_at: nowMs,
        updated_at: nowMs,
      });
      this.updateCandidate(candidate.candidate_id, {
        status: 'conflict',
        reviewed_by: reviewer,
        reviewed_at: nowMs,
        review_notes: 'promotion_conflict_detected',
        conflict_artifact_path: artifactPath,
        base_sha: baseSha,
        patch_text: patchText,
        target_file: targetFile,
        target_heading: targetHeading,
        updated_at: nowMs,
      });
      return {
        ok: true,
        status: 'conflict',
        candidateId: candidate.candidate_id,
        conflict_artifact_path: artifactPath,
      };
    }

    const absolutePath = path.join(options.projectRoot || this.projectRoot, targetFile);
    const writeResult = appendBulletToSection(absolutePath, targetHeading, candidate.content);
    const supersededMemoryId = asString(candidate.correction_of || candidate.supersedes || '', '');
    const supersededMemory = supersededMemoryId ? this.getMemory(supersededMemoryId) : null;
    this.updateCandidate(candidate.candidate_id, {
      status: 'promoted',
      reviewed_by: reviewer,
      reviewed_at: nowMs,
      review_notes: options.reviewNotes || null,
      base_sha: baseSha,
      patch_text: patchText,
      target_file: targetFile,
      target_heading: targetHeading,
      updated_at: nowMs,
    });
    this.updateMemory(candidate.memory_id, {
      status: 'active',
      lifecycle_state: 'active',
      promoted_at: nowMs,
      supersedes: supersededMemoryId || null,
      updated_at: nowMs,
    });
    if (supersededMemory && supersededMemory.memory_id !== candidate.memory_id) {
      this.updateMemory(supersededMemory.memory_id, {
        status: 'superseded',
        lifecycle_state: 'superseded',
        updated_at: nowMs,
      });
    }

    return {
      ok: true,
      status: 'promoted',
      candidateId: candidate.candidate_id,
      target_file: targetFile,
      target_heading: targetHeading,
      touchedFile: writeResult.filePath,
      alreadyPresent: writeResult.alreadyPresent,
      added: writeResult.added,
      correctionApplied: Boolean(supersededMemory && supersededMemory.memory_id !== candidate.memory_id),
      supersededMemoryId: supersededMemory?.memory_id || null,
    };
  }

  rejectCandidate(candidateId, options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
    const reviewer = asString(options.reviewer || 'architect', 'architect');
    const candidate = this.getCandidate(candidateId);
    if (!candidate) {
      return { ok: false, reason: 'candidate_not_found', candidateId };
    }
    this.updateCandidate(candidate.candidate_id, {
      status: 'rejected',
      reviewed_by: reviewer,
      reviewed_at: nowMs,
      review_notes: options.reviewNotes || null,
      updated_at: nowMs,
    });
    this.updateMemory(candidate.memory_id, {
      status: 'rejected',
      lifecycle_state: 'rejected',
      updated_at: nowMs,
    });
    return {
      ok: true,
      status: 'rejected',
      candidateId: candidate.candidate_id,
    };
  }
}

module.exports = {
  MemoryPromotionService,
  appendBulletToSection,
  buildPromotionArtifacts,
  buildPromotionPatch,
  computeFileBlobSha,
  gitBlobShaFromContent,
  resolvePromotionTarget,
};
