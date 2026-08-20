'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getProjectRoot } = require('../../config');
const {
  DEFAULT_PROFILE_NAME,
  DEFAULT_ROOM_ID,
  DEFAULT_ROOM_MEMBERS,
  EXPLICIT_ROOM_SOURCES,
  MAX_CONSECUTIVE_AGENT_POSTS,
  MEMBER_KINDS,
  TEAM_ROOM_DB_USER_VERSION,
  TEAM_ROOM_SCHEMA,
  canonicalJson,
  classifySameRootCoverage,
  deriveActivationTargets,
  normalizeClientPost,
  normalizeMessageMetadata,
  SAME_ROOT_COVERAGE_WINDOW_MS,
  sha256,
  validateTrustedIdentity,
  isSafeIdentifier,
} = require('./team-room-contracts');
const { inspectAttachmentFile } = require('./team-room-attachments');

function resolveDefaultDbPath() {
  return path.join(getProjectRoot(), '.squidrun', 'room', 'room.db');
}

function resolveDefaultAttachmentRoot() {
  return path.join(getProjectRoot(), '.squidrun', 'room', 'attachments');
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();
const DEFAULT_ATTACHMENT_ROOT = resolveDefaultAttachmentRoot();

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  member_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('human', 'agent')),
  role TEXT NOT NULL,
  pane_id TEXT,
  avatar_key TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (room_id, profile_name, member_id),
  UNIQUE (room_id, profile_name, role)
);

CREATE TABLE IF NOT EXISTS room_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  author_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to_message_id TEXT,
  root_message_id TEXT NOT NULL,
  source TEXT NOT NULL,
  client_nonce TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  participation_reason TEXT,
  causal_activation_id TEXT UNIQUE,
  root_reentry INTEGER NOT NULL DEFAULT 0 CHECK (root_reentry IN (0, 1)),
  activation_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (activation_suppressed IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  UNIQUE (room_id, profile_name, author_id, client_nonce),
  FOREIGN KEY (room_id, profile_name, author_id)
    REFERENCES room_members (room_id, profile_name, member_id),
  FOREIGN KEY (reply_to_message_id) REFERENCES room_messages (message_id),
  FOREIGN KEY (root_message_id) REFERENCES room_messages (message_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS room_attachments (
  attachment_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'quarantined')),
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_name TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  width INTEGER,
  height INTEGER,
  original_rel_path TEXT NOT NULL,
  preview_rel_path TEXT,
  created_at_ms INTEGER NOT NULL,
  finalized_at_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (room_id, profile_name, sha256)
);

CREATE TABLE IF NOT EXISTS room_message_attachments (
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (message_id, attachment_id),
  UNIQUE (message_id, ordinal),
  FOREIGN KEY (message_id) REFERENCES room_messages (message_id),
  FOREIGN KEY (attachment_id) REFERENCES room_attachments (attachment_id)
);

CREATE TABLE IF NOT EXISTS room_activations (
  activation_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  target_member_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'delivered', 'failed', 'suppressed_fuse')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at_ms INTEGER,
  delivered_at_ms INTEGER,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (message_id, target_member_id),
  FOREIGN KEY (message_id) REFERENCES room_messages (message_id),
  FOREIGN KEY (room_id, profile_name, target_member_id)
    REFERENCES room_members (room_id, profile_name, member_id)
);

CREATE TABLE IF NOT EXISTS room_state (
  room_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  consecutive_agent_posts INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_agent_posts >= 0),
  activation_fused INTEGER NOT NULL DEFAULT 0 CHECK (activation_fused IN (0, 1)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (room_id, profile_name)
);

CREATE TABLE IF NOT EXISTS room_auth_credentials (
  credential_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  member_id TEXT NOT NULL,
  session_kind TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  FOREIGN KEY (room_id, profile_name, member_id)
    REFERENCES room_members (room_id, profile_name, member_id)
);

CREATE INDEX IF NOT EXISTS idx_room_messages_order
  ON room_messages (room_id, profile_name, seq);
CREATE INDEX IF NOT EXISTS idx_room_messages_root_author
  ON room_messages (room_id, profile_name, root_message_id, author_id, seq);
CREATE INDEX IF NOT EXISTS idx_room_activations_target_status
  ON room_activations (room_id, profile_name, target_member_id, status, created_at_ms);

CREATE TRIGGER IF NOT EXISTS room_messages_append_only_update
BEFORE UPDATE ON room_messages
BEGIN SELECT RAISE(ABORT, 'room_messages_append_only'); END;

CREATE TRIGGER IF NOT EXISTS room_messages_append_only_delete
BEFORE DELETE ON room_messages
BEGIN SELECT RAISE(ABORT, 'room_messages_append_only'); END;

CREATE TRIGGER IF NOT EXISTS room_message_attachments_append_only_update
BEFORE UPDATE ON room_message_attachments
BEGIN SELECT RAISE(ABORT, 'room_message_attachments_append_only'); END;

CREATE TRIGGER IF NOT EXISTS room_message_attachments_append_only_delete
BEFORE DELETE ON room_message_attachments
BEGIN SELECT RAISE(ABORT, 'room_message_attachments_append_only'); END;

CREATE TRIGGER IF NOT EXISTS room_attachment_storage_immutable
BEFORE UPDATE ON room_attachments
WHEN NEW.attachment_id != OLD.attachment_id
  OR NEW.room_id != OLD.room_id
  OR NEW.profile_name != OLD.profile_name
  OR NEW.sha256 != OLD.sha256
  OR NEW.mime_type != OLD.mime_type
  OR NEW.original_name != OLD.original_name
  OR NEW.bytes != OLD.bytes
  OR COALESCE(NEW.width, -1) != COALESCE(OLD.width, -1)
  OR COALESCE(NEW.height, -1) != COALESCE(OLD.height, -1)
  OR NEW.original_rel_path != OLD.original_rel_path
  OR COALESCE(NEW.preview_rel_path, '') != COALESCE(OLD.preview_rel_path, '')
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.finalized_at_ms != OLD.finalized_at_ms
  OR NEW.metadata_json != OLD.metadata_json
BEGIN SELECT RAISE(ABORT, 'room_attachment_storage_immutable'); END;

CREATE TRIGGER IF NOT EXISTS room_attachment_status_guard
BEFORE UPDATE OF status ON room_attachments
WHEN NOT (OLD.status = 'ready' AND NEW.status = 'quarantined')
BEGIN SELECT RAISE(ABORT, 'room_attachment_status_transition_invalid'); END;

CREATE TRIGGER IF NOT EXISTS room_attachments_append_only_delete
BEFORE DELETE ON room_attachments
BEGIN SELECT RAISE(ABORT, 'room_attachments_append_only'); END;

CREATE TRIGGER IF NOT EXISTS room_activation_identity_immutable
BEFORE UPDATE ON room_activations
WHEN NEW.activation_id != OLD.activation_id
  OR NEW.message_id != OLD.message_id
  OR NEW.room_id != OLD.room_id
  OR NEW.profile_name != OLD.profile_name
  OR NEW.target_member_id != OLD.target_member_id
  OR NEW.created_at_ms != OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'room_activation_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS room_activation_transition_guard
BEFORE UPDATE OF status ON room_activations
WHEN NOT (
  (OLD.status = 'queued' AND NEW.status IN ('claimed', 'suppressed_fuse'))
  OR (OLD.status = 'claimed' AND NEW.status IN ('delivered', 'failed', 'suppressed_fuse'))
  OR (OLD.status = 'failed' AND NEW.status = 'queued')
)
BEGIN SELECT RAISE(ABORT, 'room_activation_transition_invalid'); END;

CREATE TRIGGER IF NOT EXISTS room_activations_append_only_delete
BEFORE DELETE ON room_activations
BEGIN SELECT RAISE(ABORT, 'room_activations_append_only'); END;

CREATE TRIGGER IF NOT EXISTS room_auth_identity_immutable
BEFORE UPDATE ON room_auth_credentials
WHEN NEW.credential_id != OLD.credential_id
  OR NEW.token_hash != OLD.token_hash
  OR NEW.room_id != OLD.room_id
  OR NEW.profile_name != OLD.profile_name
  OR NEW.member_id != OLD.member_id
  OR NEW.session_kind != OLD.session_kind
  OR NEW.capabilities_json != OLD.capabilities_json
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.expires_at_ms != OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'room_auth_identity_immutable'); END;
`;

const SCHEMA_V2_SQL = `
ALTER TABLE room_auth_credentials ADD COLUMN source TEXT;

UPDATE room_auth_credentials
SET source = CASE
  WHEN session_kind = 'paired_device' THEN 'room_web'
  WHEN session_kind = 'runtime_registry' THEN 'room_cli'
  ELSE NULL
END
WHERE source IS NULL;

DROP TRIGGER IF EXISTS room_activation_transition_guard;
CREATE TRIGGER room_activation_transition_guard
BEFORE UPDATE OF status ON room_activations
WHEN NOT (
  (OLD.status = 'queued' AND NEW.status IN ('claimed', 'suppressed_fuse'))
  OR (OLD.status = 'claimed' AND NEW.status IN ('delivered', 'failed', 'suppressed_fuse'))
  OR (OLD.status = 'failed' AND NEW.status = 'queued')
)
BEGIN SELECT RAISE(ABORT, 'room_activation_transition_invalid'); END;

CREATE TRIGGER IF NOT EXISTS room_auth_source_immutable
BEFORE UPDATE ON room_auth_credentials
WHEN COALESCE(NEW.source, '') != COALESCE(OLD.source, '')
BEGIN SELECT RAISE(ABORT, 'room_auth_source_immutable'); END;
`;

const SCHEMA_V3_TABLES_SQL = `
CREATE TABLE room_attachment_claims (
  claim_id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  claimed_message_id TEXT,
  created_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  CHECK (
    (claimed_message_id IS NULL AND claimed_at_ms IS NULL)
    OR (claimed_message_id IS NOT NULL AND claimed_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (attachment_id) REFERENCES room_attachments (attachment_id),
  FOREIGN KEY (claimed_message_id) REFERENCES room_messages (message_id)
);

CREATE TABLE room_message_attachments_v3 (
  message_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (message_id, claim_id),
  UNIQUE (message_id, ordinal),
  UNIQUE (claim_id),
  FOREIGN KEY (message_id) REFERENCES room_messages (message_id),
  FOREIGN KEY (claim_id) REFERENCES room_attachment_claims (claim_id),
  FOREIGN KEY (attachment_id) REFERENCES room_attachments (attachment_id)
);
`;

const SCHEMA_V3_FINALIZE_SQL = `
DROP TRIGGER IF EXISTS room_message_attachments_append_only_update;
DROP TRIGGER IF EXISTS room_message_attachments_append_only_delete;
DROP TABLE room_message_attachments;
ALTER TABLE room_message_attachments_v3 RENAME TO room_message_attachments;

CREATE INDEX idx_room_attachment_claims_content
  ON room_attachment_claims (attachment_id, created_at_ms);
CREATE INDEX idx_room_attachment_claims_scope
  ON room_attachment_claims (room_id, profile_name, claim_id);

CREATE TRIGGER room_attachment_claim_identity_immutable
BEFORE UPDATE ON room_attachment_claims
WHEN NEW.claim_id != OLD.claim_id
  OR NEW.attachment_id != OLD.attachment_id
  OR NEW.room_id != OLD.room_id
  OR NEW.profile_name != OLD.profile_name
  OR NEW.original_name != OLD.original_name
  OR NEW.created_at_ms != OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'room_attachment_claim_identity_immutable'); END;

CREATE TRIGGER room_attachment_claim_transition_guard
BEFORE UPDATE OF claimed_message_id, claimed_at_ms ON room_attachment_claims
WHEN NOT (
  OLD.claimed_message_id IS NULL
  AND OLD.claimed_at_ms IS NULL
  AND NEW.claimed_message_id IS NOT NULL
  AND NEW.claimed_at_ms IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'room_attachment_claim_transition_invalid'); END;

CREATE TRIGGER room_attachment_claims_append_only_delete
BEFORE DELETE ON room_attachment_claims
BEGIN SELECT RAISE(ABORT, 'room_attachment_claims_append_only'); END;

CREATE TRIGGER room_message_attachments_append_only_update
BEFORE UPDATE ON room_message_attachments
BEGIN SELECT RAISE(ABORT, 'room_message_attachments_append_only'); END;

CREATE TRIGGER room_message_attachments_append_only_delete
BEFORE DELETE ON room_message_attachments
BEGIN SELECT RAISE(ABORT, 'room_message_attachments_append_only'); END;
`;

function loadSqliteDriver() {
  try {
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      return { name: 'node:sqlite', create: (filename) => new mod.DatabaseSync(filename) };
    }
  } catch {}
  try {
    const BetterSqlite3 = require('better-sqlite3');
    return { name: 'better-sqlite3', create: (filename) => new BetterSqlite3(filename) };
  } catch {
    return null;
  }
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function toBool(value) {
  return Number(value) === 1;
}

function mapMember(row) {
  if (!row) return null;
  return {
    roomId: row.room_id,
    profileName: row.profile_name,
    memberId: row.member_id,
    displayName: row.display_name,
    memberKind: row.member_kind,
    role: row.role,
    paneId: row.pane_id,
    avatarKey: row.avatar_key,
    active: toBool(row.active),
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    seq: Number(row.seq),
    messageId: row.message_id,
    roomId: row.room_id,
    profileName: row.profile_name,
    schema: row.schema_version,
    authorId: row.author_id,
    kind: row.kind,
    body: row.body,
    replyToMessageId: row.reply_to_message_id,
    rootMessageId: row.root_message_id,
    source: row.source,
    clientNonce: row.client_nonce,
    contentHash: row.content_hash,
    participationReason: row.participation_reason,
    causalActivationId: row.causal_activation_id,
    rootReentry: toBool(row.root_reentry),
    activationSuppressed: toBool(row.activation_suppressed),
    metadata: parseJson(row.metadata_json, {}),
    createdAtMs: Number(row.created_at_ms),
  };
}

function mapAttachment(row, attachmentRoot) {
  if (!row) return null;
  const metadata = parseJson(row.metadata_json, {});
  const previewRelativePath = row.preview_rel_path;
  return {
    attachmentId: row.attachment_id,
    roomId: row.room_id,
    profileName: row.profile_name,
    status: row.status,
    sha256: row.sha256,
    mimeType: row.mime_type,
    originalName: row.original_name,
    bytes: Number(row.bytes),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    relativePath: row.original_rel_path,
    localPath: path.resolve(attachmentRoot, ...String(row.original_rel_path).split('/')),
    previewRelativePath,
    previewLocalPath: previewRelativePath
      ? path.resolve(attachmentRoot, ...String(previewRelativePath).split('/'))
      : null,
    createdAtMs: Number(row.created_at_ms),
    finalizedAtMs: Number(row.finalized_at_ms),
    metadata,
  };
}

function mapClaimAttachment(row, attachmentRoot) {
  if (!row) return null;
  const attachment = mapAttachment(row, attachmentRoot);
  return {
    ...attachment,
    attachmentId: row.claim_id,
    contentAttachmentId: row.attachment_id,
    originalName: row.claim_original_name || attachment.originalName,
    claimedMessageId: row.claimed_message_id || null,
    claimCreatedAtMs: Number(row.claim_created_at_ms ?? row.created_at_ms),
    claimedAtMs: row.claimed_at_ms === null || row.claimed_at_ms === undefined
      ? null
      : Number(row.claimed_at_ms),
  };
}

function mapActivation(row) {
  if (!row) return null;
  return {
    activationId: row.activation_id,
    messageId: row.message_id,
    roomId: row.room_id,
    profileName: row.profile_name,
    targetMemberId: row.target_member_id,
    status: row.status,
    attempts: Number(row.attempts),
    claimedAtMs: row.claimed_at_ms === null ? null : Number(row.claimed_at_ms),
    deliveredAtMs: row.delivered_at_ms === null ? null : Number(row.delivered_at_ms),
    lastError: row.last_error,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

class TeamRoomStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.attachmentRoot = options.attachmentRoot || DEFAULT_ATTACHMENT_ROOT;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.randomUUID = typeof options.randomUUID === 'function' ? options.randomUUID : crypto.randomUUID;
    this.attachmentInspector = typeof options.attachmentInspector === 'function'
      ? options.attachmentInspector
      : inspectAttachmentFile;
    this.db = null;
    this.driverName = null;
  }

  init() {
    if (this.db) return { ok: true, driver: this.driverName, dbPath: this.dbPath };
    const driver = loadSqliteDriver();
    if (!driver) return { ok: false, reason: 'sqlite_driver_unavailable' };
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      fs.mkdirSync(this.attachmentRoot, { recursive: true });
      this.db = driver.create(this.dbPath);
      this.driverName = driver.name;
      this.db.exec('PRAGMA journal_mode=WAL;');
      this.db.exec('PRAGMA synchronous=FULL;');
      this.db.exec('PRAGMA foreign_keys=ON;');
      this.db.exec('PRAGMA busy_timeout=5000;');
      const versionRow = this.db.prepare('PRAGMA user_version').get();
      let currentVersion = Number(Object.values(versionRow || {})[0] || 0);
      if (currentVersion > TEAM_ROOM_DB_USER_VERSION) throw new Error('team_room_schema_newer_than_runtime');
      if (currentVersion < 1) {
        this.db.exec('BEGIN IMMEDIATE;');
        try {
          this.db.exec(SCHEMA_V1_SQL);
          this.db.exec('PRAGMA user_version=1;');
          this.db.exec('COMMIT;');
          currentVersion = 1;
        } catch (err) {
          try { this.db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
      }
      if (currentVersion < 2) {
        this.db.exec('BEGIN IMMEDIATE;');
        try {
          this.db.exec(SCHEMA_V2_SQL);
          this.db.exec('PRAGMA user_version=2;');
          this.db.exec('COMMIT;');
          currentVersion = 2;
        } catch (err) {
          try { this.db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
      }
      if (currentVersion < 3) {
        this.db.exec('BEGIN IMMEDIATE;');
        try {
          this._migrateAttachmentClaimsV3();
          this.db.exec('PRAGMA user_version=3;');
          this.db.exec('COMMIT;');
          currentVersion = 3;
        } catch (err) {
          try { this.db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
      }
      if (currentVersion !== TEAM_ROOM_DB_USER_VERSION) throw new Error('team_room_schema_migration_incomplete');
      this._seedMembers();
      return { ok: true, driver: this.driverName, dbPath: this.dbPath };
    } catch (err) {
      try { this.db?.close(); } catch {}
      this.db = null;
      return { ok: false, reason: `open_failed:${err.message}` };
    }
  }

  _requireDb() {
    if (!this.db) throw new Error('team_room_store_not_initialized');
  }

  _transaction(fn) {
    this._requireDb();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw err;
    }
  }

  _migrateAttachmentClaimsV3() {
    this.db.exec(SCHEMA_V3_TABLES_SQL);
    const attachments = this.db.prepare(`
      SELECT attachment_id, room_id, profile_name, original_name, created_at_ms
      FROM room_attachments ORDER BY attachment_id
    `).all();
    const links = this.db.prepare(`
      SELECT ma.message_id, ma.attachment_id, ma.ordinal, m.seq, m.created_at_ms AS message_created_at_ms
      FROM room_message_attachments ma
      JOIN room_messages m ON m.message_id = ma.message_id
      ORDER BY m.seq, ma.ordinal, ma.message_id
    `).all();
    const linksByAttachment = new Map();
    for (const link of links) {
      const values = linksByAttachment.get(link.attachment_id) || [];
      values.push(link);
      linksByAttachment.set(link.attachment_id, values);
    }
    const insertClaim = this.db.prepare(`
      INSERT INTO room_attachment_claims (
        claim_id, attachment_id, room_id, profile_name, original_name,
        claimed_message_id, created_at_ms, claimed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLink = this.db.prepare(`
      INSERT INTO room_message_attachments_v3 (message_id, claim_id, attachment_id, ordinal)
      VALUES (?, ?, ?, ?)
    `);
    for (const attachment of attachments) {
      const attachmentLinks = linksByAttachment.get(attachment.attachment_id) || [];
      if (attachmentLinks.length === 0) {
        insertClaim.run(
          attachment.attachment_id, attachment.attachment_id, attachment.room_id,
          attachment.profile_name, attachment.original_name, null, Number(attachment.created_at_ms), null
        );
        continue;
      }
      for (let index = 0; index < attachmentLinks.length; index += 1) {
        const link = attachmentLinks[index];
        const claimId = index === 0
          ? attachment.attachment_id
          : `trc_migrated_${sha256(`${attachment.attachment_id}\0${link.message_id}\0${index}`).slice(0, 40)}`;
        insertClaim.run(
          claimId, attachment.attachment_id, attachment.room_id, attachment.profile_name,
          attachment.original_name, link.message_id, Number(attachment.created_at_ms), Number(link.message_created_at_ms)
        );
        insertLink.run(link.message_id, claimId, attachment.attachment_id, Number(link.ordinal));
      }
    }
    this.db.exec(SCHEMA_V3_FINALIZE_SQL);
  }

  _seedMembers() {
    const nowMs = Number(this.now());
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO room_members (
        room_id, profile_name, member_id, display_name, member_kind, role, pane_id, avatar_key, active, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateDisplayName = this.db.prepare(`
      UPDATE room_members SET display_name = ?
      WHERE room_id = ? AND profile_name = ? AND member_id = ?
    `);
    for (const member of DEFAULT_ROOM_MEMBERS) {
      insert.run(
        member.roomId, member.profileName, member.memberId, member.displayName, member.memberKind,
        member.role, member.paneId || null, member.avatarKey || null, member.active === false ? 0 : 1, nowMs
      );
      const stored = this.getMember(member.memberId, member.roomId, member.profileName);
      if (!stored
        || stored.memberKind !== member.memberKind
        || stored.role !== member.role
        || stored.paneId !== (member.paneId || null)) {
        throw new Error(`seeded_room_member_conflict:${member.memberId}`);
      }
      if (stored.displayName !== member.displayName) {
        updateDisplayName.run(member.displayName, member.roomId, member.profileName, member.memberId);
      }
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO room_state (
        room_id, profile_name, consecutive_agent_posts, activation_fused, updated_at_ms
      ) VALUES (?, ?, 0, 0, ?)
    `).run(DEFAULT_ROOM_ID, DEFAULT_PROFILE_NAME, nowMs);
  }

  getMember(memberId, roomId = DEFAULT_ROOM_ID, profileName = DEFAULT_PROFILE_NAME) {
    this._requireDb();
    return mapMember(this.db.prepare(`
      SELECT * FROM room_members WHERE room_id = ? AND profile_name = ? AND member_id = ?
    `).get(String(roomId).toLowerCase(), String(profileName).toLowerCase(), String(memberId).toLowerCase()));
  }

  listMembers(roomId = DEFAULT_ROOM_ID, profileName = DEFAULT_PROFILE_NAME) {
    this._requireDb();
    return this.db.prepare(`
      SELECT * FROM room_members WHERE room_id = ? AND profile_name = ? ORDER BY member_id
    `).all(String(roomId).toLowerCase(), String(profileName).toLowerCase()).map(mapMember);
  }

  registerReadyAttachment(input = {}) {
    this._requireDb();
    const roomId = String(input.roomId || DEFAULT_ROOM_ID).trim().toLowerCase();
    const profileName = String(input.profileName || DEFAULT_PROFILE_NAME).trim().toLowerCase();
    const normalizedMetadata = normalizeMessageMetadata(input.metadata);
    if (!normalizedMetadata.ok) return normalizedMetadata;
    const requestedAttachmentId = input.attachmentId === undefined
      ? null
      : String(input.attachmentId || '').trim();
    if (requestedAttachmentId !== null && !isSafeIdentifier(requestedAttachmentId)) {
      return { ok: false, reason: 'room_attachment_id_invalid' };
    }
    const previewRelativePath = input.previewRelativePath === undefined || input.previewRelativePath === null
      ? null
      : String(input.previewRelativePath).replace(/\\/gu, '/');
    if (previewRelativePath !== null
      && (!previewRelativePath || path.posix.isAbsolute(previewRelativePath)
        || previewRelativePath.split('/').some((part) => part === '..' || part === ''))) {
      return { ok: false, reason: 'room_attachment_preview_path_invalid' };
    }
    const inspected = this.attachmentInspector({
      rootPath: this.attachmentRoot,
      filePath: input.filePath,
      claimedMime: input.claimedMime,
      expectedBytes: input.expectedBytes,
      expectedSha256: input.expectedSha256,
      originalName: input.originalName,
    });
    if (!inspected.ok) return inspected;
    const attachmentId = requestedAttachmentId || `tra_${this.randomUUID()}`;
    const nowMs = Number(this.now());
    try {
      this.db.prepare(`
        INSERT INTO room_attachments (
          attachment_id, room_id, profile_name, status, sha256, mime_type, original_name, bytes,
          width, height, original_rel_path, preview_rel_path, created_at_ms, finalized_at_ms, metadata_json
        ) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attachmentId, roomId, profileName, inspected.sha256, inspected.mimeType, inspected.originalName,
        inspected.bytes, input.width ?? null, input.height ?? null, inspected.relativePath,
        previewRelativePath, nowMs, nowMs, canonicalJson(normalizedMetadata.metadata)
      );
      return { ok: true, status: 'inserted', attachment: this.getAttachment(attachmentId) };
    } catch (err) {
      const existing = this.db.prepare(`
        SELECT * FROM room_attachments WHERE room_id = ? AND profile_name = ? AND sha256 = ?
      `).get(roomId, profileName, inspected.sha256);
      if (existing) return { ok: true, status: 'idempotent', attachment: mapAttachment(existing, this.attachmentRoot) };
      return { ok: false, reason: `attachment_insert_failed:${err.message}` };
    }
  }

  createAttachmentClaim(contentAttachmentId, identity = {}) {
    this._requireDb();
    const attachment = this.getAttachment(contentAttachmentId);
    const roomId = String(identity.roomId || DEFAULT_ROOM_ID).trim().toLowerCase();
    const profileName = String(identity.profileName || DEFAULT_PROFILE_NAME).trim().toLowerCase();
    if (!attachment || attachment.roomId !== roomId || attachment.profileName !== profileName) {
      return { ok: false, reason: 'room_attachment_not_found_or_cross_scope' };
    }
    if (attachment.status !== 'ready') return { ok: false, reason: 'room_attachment_not_ready' };
    const claimId = `trc_${this.randomUUID()}`;
    const nowMs = Number(this.now());
    try {
      this.db.prepare(`
        INSERT INTO room_attachment_claims (
          claim_id, attachment_id, room_id, profile_name, original_name,
          claimed_message_id, created_at_ms, claimed_at_ms
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
      `).run(
        claimId, attachment.attachmentId, roomId, profileName,
        String(identity.originalName || attachment.originalName), nowMs
      );
      return { ok: true, status: 'inserted', attachment: this.getAttachmentClaim(claimId) };
    } catch (err) {
      return { ok: false, reason: `room_attachment_claim_insert_failed:${err.message}` };
    }
  }

  getAttachment(attachmentId) {
    this._requireDb();
    return mapAttachment(this.db.prepare('SELECT * FROM room_attachments WHERE attachment_id = ?').get(String(attachmentId)), this.attachmentRoot);
  }

  getAttachmentClaim(claimId) {
    this._requireDb();
    return mapClaimAttachment(this.db.prepare(`
      SELECT c.claim_id, c.original_name AS claim_original_name, c.claimed_message_id,
        c.created_at_ms AS claim_created_at_ms, c.claimed_at_ms, a.*
      FROM room_attachment_claims c
      JOIN room_attachments a ON a.attachment_id = c.attachment_id
      WHERE c.claim_id = ?
    `).get(String(claimId)), this.attachmentRoot);
  }

  getAttachmentBySha(sha256, roomId = DEFAULT_ROOM_ID, profileName = DEFAULT_PROFILE_NAME) {
    this._requireDb();
    return mapAttachment(this.db.prepare(`
      SELECT * FROM room_attachments WHERE room_id = ? AND profile_name = ? AND sha256 = ?
    `).get(
      String(roomId).trim().toLowerCase(),
      String(profileName).trim().toLowerCase(),
      String(sha256).trim().toLowerCase()
    ), this.attachmentRoot);
  }

  _verifyAttachmentClaim(attachmentId, identity, options = {}) {
    const attachment = this.getAttachmentClaim(attachmentId);
    if (!attachment || attachment.roomId !== identity.roomId || attachment.profileName !== identity.profileName) {
      return { ok: false, reason: 'room_attachment_not_found_or_cross_scope' };
    }
    if (options.requireUnclaimed === true && attachment.claimedMessageId) {
      return { ok: false, reason: 'room_attachment_already_claimed' };
    }
    if (attachment.status !== 'ready') return { ok: false, reason: 'room_attachment_not_ready' };
    const verified = this.attachmentInspector({
      rootPath: this.attachmentRoot,
      filePath: attachment.localPath,
      claimedMime: attachment.mimeType,
      expectedBytes: attachment.bytes,
      expectedSha256: attachment.sha256,
      originalName: attachment.originalName,
    });
    if (!verified.ok) {
      this.db.prepare("UPDATE room_attachments SET status = 'quarantined' WHERE attachment_id = ? AND status = 'ready'")
        .run(attachment.contentAttachmentId);
      return { ok: false, reason: 'room_attachment_integrity_failed', details: verified.reason };
    }
    return { ok: true, attachment };
  }

  verifyReadyAttachment(attachmentId, identity) {
    this._requireDb();
    return this._verifyAttachmentClaim(attachmentId, identity);
  }

  postMessage(input = {}) {
    this._requireDb();
    const normalized = normalizeClientPost(input.payload, input.identity);
    if (!normalized.ok) return normalized;
    const { identity, post } = normalized;
    const trusted = validateTrustedIdentity(identity);
    if (!trusted.ok) return trusted;
    const member = this.getMember(identity.memberId, identity.roomId, identity.profileName);
    if (!member || !member.active
      || member.memberKind !== identity.memberKind
      || member.role !== identity.role
      || member.paneId !== identity.paneId) {
      return { ok: false, reason: 'room_author_identity_mismatch' };
    }

    const existing = this.db.prepare(`
      SELECT * FROM room_messages
      WHERE room_id = ? AND profile_name = ? AND author_id = ? AND client_nonce = ?
    `).get(identity.roomId, identity.profileName, identity.memberId, post.clientNonce);
    if (existing) {
      return existing.content_hash === post.contentHash
        ? { ok: true, status: 'idempotent', message: mapMessage(existing), activations: this.listActivations(existing.message_id) }
        : { ok: false, reason: 'room_client_nonce_conflict' };
    }

    const attachments = [];
    for (const attachmentId of post.attachmentIds) {
      const checked = this._verifyAttachmentClaim(attachmentId, identity, { requireUnclaimed: true });
      if (!checked.ok) return checked;
      attachments.push(checked.attachment);
    }

    try {
      return this._transaction(() => {
        const messageId = `trm_${this.randomUUID()}`;
        const state = this.db.prepare(`
          SELECT * FROM room_state WHERE room_id = ? AND profile_name = ?
        `).get(identity.roomId, identity.profileName) || { consecutive_agent_posts: 0, activation_fused: 0 };
        if (identity.memberKind === MEMBER_KINDS.AGENT && toBool(state.activation_fused)) {
          throw new Error('room_activation_fused');
        }
        let reply = null;
        let rootMessageId = messageId;
        if (post.replyToMessageId) {
          reply = this.getMessage(post.replyToMessageId);
          if (!reply || reply.roomId !== identity.roomId || reply.profileName !== identity.profileName) {
            throw new Error('room_reply_not_found_or_cross_scope');
          }
          rootMessageId = reply.rootMessageId;
        }
        const nowMs = Number(this.now());

        if (identity.memberKind === MEMBER_KINDS.AGENT && post.agentInitiatedRoot) {
          const duplicate = this.db.prepare(`
            SELECT message_id, created_at_ms FROM room_messages
            WHERE room_id = ?
              AND profile_name = ?
              AND author_id = ?
              AND reply_to_message_id IS NULL
              AND causal_activation_id IS NULL
              AND body = ?
              AND participation_reason = ?
              AND created_at_ms >= ?
            ORDER BY seq DESC
            LIMIT 1
          `).get(
            identity.roomId,
            identity.profileName,
            identity.memberId,
            post.body,
            post.participationReason,
            nowMs - SAME_ROOT_COVERAGE_WINDOW_MS
          );
          if (duplicate) {
            return {
              ok: false,
              reason: 'room_agent_root_duplicate',
              details: {
                duplicateOfMessageId: duplicate.message_id,
                duplicateCreatedAtMs: Number(duplicate.created_at_ms),
              },
            };
          }
        } else if (identity.memberKind === MEMBER_KINDS.AGENT) {
          if (!post.causalActivationId) throw new Error('agent_causal_activation_required');
          const activation = this.getActivation(post.causalActivationId);
          if (!activation
            || activation.roomId !== identity.roomId
            || activation.profileName !== identity.profileName
            || activation.targetMemberId !== identity.memberId) {
            throw new Error('agent_causal_activation_mismatch');
          }
          if (!['claimed', 'delivered'].includes(activation.status)) {
            throw new Error('agent_causal_activation_not_delivered');
          }
          if (post.replyToMessageId !== activation.messageId) {
            throw new Error('agent_reply_must_match_activation_message');
          }
          const priorResponse = this.db.prepare('SELECT message_id FROM room_messages WHERE causal_activation_id = ?')
            .get(post.causalActivationId);
          if (priorResponse) throw new Error('agent_activation_already_answered');
          const priorRootPost = this.db.prepare(`
            SELECT message_id FROM room_messages
            WHERE room_id = ? AND profile_name = ? AND root_message_id = ? AND author_id = ?
            LIMIT 1
          `).get(identity.roomId, identity.profileName, rootMessageId, identity.memberId);
          if (priorRootPost && !post.rootReentry) throw new Error('agent_root_post_limit_reached');

          const priorAgentPosts = this.db.prepare(`
            SELECT m.message_id, m.author_id, m.body, m.participation_reason, m.created_at_ms
            FROM room_messages m
            JOIN room_members member
              ON member.room_id = m.room_id
             AND member.profile_name = m.profile_name
             AND member.member_id = m.author_id
            WHERE m.room_id = ?
              AND m.profile_name = ?
              AND m.root_message_id = ?
              AND m.author_id != ?
              AND member.member_kind = 'agent'
              AND m.created_at_ms >= ?
            ORDER BY m.seq DESC
          `).all(
            identity.roomId,
            identity.profileName,
            rootMessageId,
            identity.memberId,
            nowMs - SAME_ROOT_COVERAGE_WINDOW_MS
          ).map((row) => ({
            messageId: row.message_id,
            authorId: row.author_id,
            body: row.body,
            participationReason: row.participation_reason,
            createdAtMs: Number(row.created_at_ms),
          }));
          const rootMessage = this.getMessage(rootMessageId);
          const coverage = classifySameRootCoverage({
            activatedBody: reply?.body || '',
            attachments,
            body: post.body,
            memberId: identity.memberId,
            participationReason: post.participationReason,
            rootBody: rootMessage?.body || '',
            priorPosts: priorAgentPosts,
          });
          if (coverage.covered) {
            return {
              ok: false,
              reason: 'room_root_already_covered',
              details: {
                rootMessageId,
                coveredByAgent: coverage.coveredByAgentId,
                coveredByMessageId: coverage.coveredByMessageId,
                coverageReason: coverage.reason,
                coverageRatio: coverage.coverageRatio,
              },
            };
          }
        } else if (post.causalActivationId) {
          throw new Error('human_causal_activation_forbidden');
        }

        for (const attachment of attachments) {
          const currentClaim = this.db.prepare(`
            SELECT claimed_message_id FROM room_attachment_claims
            WHERE claim_id = ? AND room_id = ? AND profile_name = ?
          `).get(attachment.attachmentId, identity.roomId, identity.profileName);
          if (!currentClaim) throw new Error('room_attachment_not_found_or_cross_scope');
          if (currentClaim.claimed_message_id) throw new Error('room_attachment_already_claimed');
        }
        let consecutiveAgentPosts = Number(state.consecutive_agent_posts || 0);
        let activationFused = toBool(state.activation_fused);
        if (identity.memberKind === MEMBER_KINDS.HUMAN) {
          consecutiveAgentPosts = 0;
          activationFused = false;
        } else {
          consecutiveAgentPosts += 1;
          if (consecutiveAgentPosts >= MAX_CONSECUTIVE_AGENT_POSTS) activationFused = true;
        }

        this.db.prepare(`
          INSERT INTO room_messages (
            message_id, room_id, profile_name, schema_version, author_id, kind, body,
            reply_to_message_id, root_message_id, source, client_nonce, content_hash,
            participation_reason, causal_activation_id, root_reentry, activation_suppressed,
            metadata_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          messageId, identity.roomId, identity.profileName, TEAM_ROOM_SCHEMA, identity.memberId,
          post.kind, post.body, post.replyToMessageId, rootMessageId, identity.source,
          post.clientNonce, post.contentHash, post.participationReason, post.causalActivationId,
          post.rootReentry ? 1 : 0, activationFused ? 1 : 0, canonicalJson(post.metadata), nowMs
        );

        for (let index = 0; index < attachments.length; index += 1) {
          const claimed = this.db.prepare(`
            UPDATE room_attachment_claims
            SET claimed_message_id = ?, claimed_at_ms = ?
            WHERE claim_id = ? AND claimed_message_id IS NULL AND claimed_at_ms IS NULL
          `).run(messageId, nowMs, attachments[index].attachmentId);
          if (Number(claimed.changes || 0) !== 1) throw new Error('room_attachment_already_claimed');
          this.db.prepare(`
            INSERT INTO room_message_attachments (message_id, claim_id, attachment_id, ordinal)
            VALUES (?, ?, ?, ?)
          `).run(
            messageId, attachments[index].attachmentId, attachments[index].contentAttachmentId, index
          );
        }

        this.db.prepare(`
          INSERT INTO room_state (room_id, profile_name, consecutive_agent_posts, activation_fused, updated_at_ms)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(room_id, profile_name) DO UPDATE SET
            consecutive_agent_posts = excluded.consecutive_agent_posts,
            activation_fused = excluded.activation_fused,
            updated_at_ms = excluded.updated_at_ms
        `).run(identity.roomId, identity.profileName, consecutiveAgentPosts, activationFused ? 1 : 0, nowMs);

        if (activationFused) {
          this.db.prepare(`
            UPDATE room_activations
            SET status = 'suppressed_fuse', last_error = 'activation_fuse_cancelled', updated_at_ms = ?
            WHERE room_id = ? AND profile_name = ? AND status IN ('queued', 'claimed')
          `).run(nowMs, identity.roomId, identity.profileName);
        }

        const members = this.listMembers(identity.roomId, identity.profileName);
        const targets = deriveActivationTargets(identity, members);
        const status = activationFused ? 'suppressed_fuse' : 'queued';
        for (const targetMemberId of targets) {
          this.db.prepare(`
            INSERT INTO room_activations (
              activation_id, message_id, room_id, profile_name, target_member_id, status,
              attempts, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
          `).run(
            `tra_${this.randomUUID()}`, messageId, identity.roomId, identity.profileName,
            targetMemberId, status, nowMs, nowMs
          );
        }
        return {
          ok: true,
          status: 'inserted',
          message: this.getMessage(messageId),
          activations: this.listActivations(messageId),
          state: this.getRoomState(identity.roomId, identity.profileName),
        };
      });
    } catch (err) {
      if (String(err.message).includes('UNIQUE constraint failed: room_messages.room_id')) {
        const raced = this.db.prepare(`
          SELECT * FROM room_messages
          WHERE room_id = ? AND profile_name = ? AND author_id = ? AND client_nonce = ?
        `).get(identity.roomId, identity.profileName, identity.memberId, post.clientNonce);
        if (raced && raced.content_hash === post.contentHash) {
          return { ok: true, status: 'idempotent', message: mapMessage(raced), activations: this.listActivations(raced.message_id) };
        }
      }
      return { ok: false, reason: err.message };
    }
  }

  getMessage(messageId) {
    this._requireDb();
    return mapMessage(this.db.prepare('SELECT * FROM room_messages WHERE message_id = ?').get(String(messageId)));
  }

  getMessageAttachments(messageId) {
    this._requireDb();
    return this.db.prepare(`
      SELECT ma.claim_id, c.original_name AS claim_original_name, c.claimed_message_id,
        c.created_at_ms AS claim_created_at_ms, c.claimed_at_ms, a.*
      FROM room_message_attachments ma
      JOIN room_attachment_claims c ON c.claim_id = ma.claim_id
      JOIN room_attachments a ON a.attachment_id = ma.attachment_id
      WHERE ma.message_id = ? ORDER BY ma.ordinal
    `).all(String(messageId)).map((row) => mapClaimAttachment(row, this.attachmentRoot));
  }

  listMessages(roomId = DEFAULT_ROOM_ID, profileName = DEFAULT_PROFILE_NAME) {
    this._requireDb();
    return this.db.prepare(`
      SELECT * FROM room_messages WHERE room_id = ? AND profile_name = ? ORDER BY seq
    `).all(String(roomId).toLowerCase(), String(profileName).toLowerCase()).map(mapMessage);
  }

  getActivation(activationId) {
    this._requireDb();
    return mapActivation(this.db.prepare('SELECT * FROM room_activations WHERE activation_id = ?').get(String(activationId)));
  }

  listActivations(messageId) {
    this._requireDb();
    return this.db.prepare(`
      SELECT * FROM room_activations WHERE message_id = ? ORDER BY target_member_id
    `).all(String(messageId)).map(mapActivation);
  }

  ensureMissingActivations(messageId) {
    this._requireDb();
    try {
      return this._transaction(() => {
        const message = this.getMessage(messageId);
        if (!message) throw new Error('room_message_not_found');
        const author = this.getMember(message.authorId, message.roomId, message.profileName);
        const targets = deriveActivationTargets(author, this.listMembers(message.roomId, message.profileName));
        const nowMs = Number(this.now());
        const status = message.activationSuppressed ? 'suppressed_fuse' : 'queued';
        let inserted = 0;
        for (const target of targets) {
          const result = this.db.prepare(`
            INSERT OR IGNORE INTO room_activations (
              activation_id, message_id, room_id, profile_name, target_member_id, status,
              attempts, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
          `).run(`tra_${this.randomUUID()}`, message.messageId, message.roomId, message.profileName, target, status, nowMs, nowMs);
          inserted += Number(result.changes || 0);
        }
        return { ok: true, inserted, activations: this.listActivations(messageId) };
      });
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  claimActivationBatch(targetMemberId, options = {}) {
    this._requireDb();
    const roomId = String(options.roomId || DEFAULT_ROOM_ID).toLowerCase();
    const profileName = String(options.profileName || DEFAULT_PROFILE_NAME).toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    try {
      return this._transaction(() => {
        const state = this.getRoomState(roomId, profileName);
        if (state.activationFused) return { ok: true, activations: [], fused: true };
        const rows = this.db.prepare(`
          SELECT a.* FROM room_activations a
          JOIN room_messages m ON m.message_id = a.message_id
          WHERE a.room_id = ? AND a.profile_name = ? AND a.target_member_id = ? AND a.status = 'queued'
          ORDER BY m.seq ASC, a.created_at_ms ASC
          LIMIT ?
        `).all(roomId, profileName, String(targetMemberId).toLowerCase(), limit);
        const nowMs = Number(this.now());
        const claimed = [];
        for (const row of rows) {
          const result = this.db.prepare(`
            UPDATE room_activations SET status = 'claimed', attempts = attempts + 1,
              claimed_at_ms = ?, last_error = NULL, updated_at_ms = ?
            WHERE activation_id = ? AND status = 'queued'
          `).run(nowMs, nowMs, row.activation_id);
          if (Number(result.changes || 0) === 1) claimed.push(this.getActivationPayload(row.activation_id));
        }
        return { ok: true, activations: claimed, fused: false };
      });
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  getActivationPayload(activationId) {
    const activation = this.getActivation(activationId);
    if (!activation) return null;
    const message = this.getMessage(activation.messageId);
    return { activation, message, attachments: this.getMessageAttachments(activation.messageId) };
  }

  isActivationDeliverable(activationId) {
    const activation = this.getActivation(activationId);
    if (activation && (activation.status === 'suppressed_fuse'
      || this.getRoomState(activation.roomId, activation.profileName).activationFused)) {
      return { ok: false, reason: 'room_activation_fused', activation };
    }
    if (!activation || activation.status !== 'claimed') {
      return { ok: false, reason: 'room_activation_not_claimed', activation };
    }
    return { ok: true, activation };
  }

  markActivationDelivered(activationId) {
    return this._finishActivation(activationId, 'delivered', null);
  }

  markActivationFailed(activationId, error) {
    return this._finishActivation(activationId, 'failed', String(error || 'delivery_failed').slice(0, 1000));
  }

  _finishActivation(activationId, status, lastError) {
    this._requireDb();
    const nowMs = Number(this.now());
    try {
      const result = this.db.prepare(`
        UPDATE room_activations SET status = ?, delivered_at_ms = ?, last_error = ?, updated_at_ms = ?
        WHERE activation_id = ? AND status = 'claimed'
          AND NOT EXISTS (
            SELECT 1 FROM room_state s
            WHERE s.room_id = room_activations.room_id
              AND s.profile_name = room_activations.profile_name
              AND s.activation_fused = 1
          )
      `).run(status, status === 'delivered' ? nowMs : null, lastError, nowMs, String(activationId));
      if (Number(result.changes || 0) === 1) return { ok: true, activation: this.getActivation(activationId) };
      const activation = this.getActivation(activationId);
      if (activation && this.getRoomState(activation.roomId, activation.profileName).activationFused) {
        return { ok: false, reason: 'room_activation_fused', activation };
      }
      return { ok: false, reason: 'room_activation_not_claimed', activation };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  requeueFailedActivation(activationId) {
    this._requireDb();
    const activation = this.getActivation(activationId);
    if (!activation || activation.status !== 'failed') return { ok: false, reason: 'room_activation_not_failed' };
    if (this.getRoomState(activation.roomId, activation.profileName).activationFused) {
      return { ok: false, reason: 'room_activation_fused' };
    }
    const nowMs = Number(this.now());
    const result = this.db.prepare(`
      UPDATE room_activations SET status = 'queued', claimed_at_ms = NULL, last_error = NULL, updated_at_ms = ?
      WHERE activation_id = ? AND status = 'failed'
    `).run(nowMs, String(activationId));
    return Number(result.changes || 0) === 1
      ? { ok: true, activation: this.getActivation(activationId) }
      : { ok: false, reason: 'room_activation_requeue_failed' };
  }

  recoverStaleClaims(options = {}) {
    this._requireDb();
    const roomId = String(options.roomId || DEFAULT_ROOM_ID).toLowerCase();
    const profileName = String(options.profileName || DEFAULT_PROFILE_NAME).toLowerCase();
    const olderThanMs = Math.max(1_000, Number(options.olderThanMs) || 60_000);
    const cutoffMs = Number(this.now()) - olderThanMs;
    try {
      return this._transaction(() => {
        const rows = this.db.prepare(`
          SELECT activation_id FROM room_activations
          WHERE room_id = ? AND profile_name = ? AND status = 'claimed' AND claimed_at_ms <= ?
          ORDER BY claimed_at_ms, activation_id
        `).all(roomId, profileName, cutoffMs);
        const fused = this.getRoomState(roomId, profileName).activationFused;
        const nowMs = Number(this.now());
        let requeued = 0;
        let failed = 0;
        for (const row of rows) {
          const marked = this.db.prepare(`
            UPDATE room_activations SET status = 'failed', last_error = 'stale_claim_recovered', updated_at_ms = ?
            WHERE activation_id = ? AND status = 'claimed'
          `).run(nowMs, row.activation_id);
          if (Number(marked.changes || 0) !== 1) continue;
          failed += 1;
          if (!fused) {
            const queued = this.db.prepare(`
              UPDATE room_activations SET status = 'queued', claimed_at_ms = NULL, last_error = NULL, updated_at_ms = ?
              WHERE activation_id = ? AND status = 'failed'
            `).run(nowMs, row.activation_id);
            requeued += Number(queued.changes || 0);
          }
        }
        return { ok: true, found: rows.length, failed, requeued, fused };
      });
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  getRoomState(roomId = DEFAULT_ROOM_ID, profileName = DEFAULT_PROFILE_NAME) {
    this._requireDb();
    const row = this.db.prepare(`
      SELECT * FROM room_state WHERE room_id = ? AND profile_name = ?
    `).get(String(roomId).toLowerCase(), String(profileName).toLowerCase());
    return {
      roomId: String(roomId).toLowerCase(),
      profileName: String(profileName).toLowerCase(),
      consecutiveAgentPosts: Number(row?.consecutive_agent_posts || 0),
      activationFused: toBool(row?.activation_fused),
      updatedAtMs: Number(row?.updated_at_ms || 0),
    };
  }

  insertAuthCredential(input = {}) {
    this._requireDb();
    const source = String(input.source || '').trim().toLowerCase();
    if (!EXPLICIT_ROOM_SOURCES.has(source)) return { ok: false, reason: 'room_credential_source_invalid' };
    try {
      this.db.prepare(`
        INSERT INTO room_auth_credentials (
          credential_id, token_hash, room_id, profile_name, member_id, session_kind, source,
          capabilities_json, created_at_ms, expires_at_ms, revoked_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        input.credentialId, input.tokenHash, input.roomId, input.profileName, input.memberId,
        input.sessionKind, source, canonicalJson(input.capabilities), input.createdAtMs, input.expiresAtMs
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `room_credential_insert_failed:${err.message}` };
    }
  }

  getAuthCredentialByHash(tokenHash) {
    this._requireDb();
    const row = this.db.prepare('SELECT * FROM room_auth_credentials WHERE token_hash = ?').get(String(tokenHash));
    if (!row) return null;
    return {
      credentialId: row.credential_id,
      tokenHash: row.token_hash,
      roomId: row.room_id,
      profileName: row.profile_name,
      memberId: row.member_id,
      sessionKind: row.session_kind,
      source: row.source,
      capabilities: parseJson(row.capabilities_json, []),
      createdAtMs: Number(row.created_at_ms),
      expiresAtMs: Number(row.expires_at_ms),
      revokedAtMs: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms),
    };
  }

  revokeAuthCredential(credentialId) {
    this._requireDb();
    const result = this.db.prepare(`
      UPDATE room_auth_credentials SET revoked_at_ms = ?
      WHERE credential_id = ? AND revoked_at_ms IS NULL
    `).run(Number(this.now()), String(credentialId));
    return { ok: Number(result.changes || 0) === 1 };
  }

  revokeAuthCredentials(options = {}) {
    this._requireDb();
    const source = String(options.source || '').trim().toLowerCase();
    const sessionKind = String(options.sessionKind || '').trim().toLowerCase();
    if (!EXPLICIT_ROOM_SOURCES.has(source) || !sessionKind) {
      return { ok: false, reason: 'room_credential_revoke_scope_invalid' };
    }
    const result = this.db.prepare(`
      UPDATE room_auth_credentials SET revoked_at_ms = ?
      WHERE source = ? AND session_kind = ? AND revoked_at_ms IS NULL
    `).run(Number(this.now()), source, sessionKind);
    return { ok: true, revoked: Number(result.changes || 0) };
  }

  schemaFingerprint() {
    this._requireDb();
    const rows = this.db.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'room_%' AND sql IS NOT NULL ORDER BY type, name
    `).all();
    return sha256(canonicalJson(rows));
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } finally { this.db = null; }
  }
}

module.exports = {
  DEFAULT_ATTACHMENT_ROOT,
  DEFAULT_DB_PATH,
  SCHEMA_V1_SQL,
  SCHEMA_V2_SQL,
  SCHEMA_V3_FINALIZE_SQL,
  SCHEMA_V3_TABLES_SQL,
  TeamRoomStore,
  loadSqliteDriver,
  mapActivation,
  mapAttachment,
  mapClaimAttachment,
  mapMember,
  mapMessage,
  resolveDefaultAttachmentRoot,
  resolveDefaultDbPath,
};
