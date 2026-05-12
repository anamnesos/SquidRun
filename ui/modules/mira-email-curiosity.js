'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIRA_EMAIL_CURIOSITY_SCHEMA = 'squidrun.mira.email_curiosity_read_v0';
const MIRA_EMAIL_CURIOSITY_SNAPSHOT_SCHEMA = 'squidrun.mira.email_curiosity_snapshot_v0';

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function oneLine(value, max = 180) {
  const text = trimText(value).replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function defaultEmailCuriositySnapshotPath(projectRoot = process.cwd()) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-email-curiosity-snapshot.json');
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeLabel(label = {}) {
  const id = trimText(label.id || label.name);
  const name = trimText(label.name || label.id);
  if (!id && !name) return null;
  const messagesTotal = numberOrZero(label.messagesTotal ?? label.messages_total ?? label.total);
  const messagesUnread = numberOrZero(label.messagesUnread ?? label.messages_unread ?? label.unread);
  const threadsTotal = numberOrZero(label.threadsTotal ?? label.threads_total);
  const threadsUnread = numberOrZero(label.threadsUnread ?? label.threads_unread);
  return {
    id: id || name,
    name: name || id,
    messages_total: messagesTotal,
    messages_unread: messagesUnread,
    threads_total: threadsTotal,
    threads_unread: threadsUnread,
  };
}

function normalizeRecentMessage(entry) {
  const rawId = trimText(entry?.id || entry?.message_id || entry?.messageId || entry);
  if (!rawId) return null;
  return {
    message_ref: `email-msg:${stableHash(rawId).slice(0, 16)}`,
    label_ids: asArray(entry?.label_ids || entry?.labelIds || entry?.labels).map(trimText).filter(Boolean).slice(0, 8),
    sender_domain: trimText(entry?.sender_domain || entry?.senderDomain) || null,
    subject_excerpt: oneLine(entry?.subject || entry?.subject_excerpt || entry?.snippet, 100) || null,
    timestamp: trimText(entry?.timestamp || entry?.date || entry?.internal_date) || null,
    has_attachment: typeof (entry?.has_attachment ?? entry?.hasAttachment) === 'boolean'
      ? Boolean(entry?.has_attachment ?? entry?.hasAttachment)
      : null,
  };
}

function normalizeEmailSnapshot(input = {}) {
  const snapshot = input?.snapshot && typeof input.snapshot === 'object' ? input.snapshot : input;
  const labels = asArray(snapshot.labels)
    .map(normalizeLabel)
    .filter(Boolean);
  const recentMessageSource = snapshot.recent_messages
    || snapshot.recentMessages
    || snapshot.messages
    || snapshot.message_ids
    || snapshot.messageIds
    || snapshot.recent_message_ids
    || snapshot.recentMessageIds;
  const recent_messages = asArray(recentMessageSource)
    .map(normalizeRecentMessage)
    .filter(Boolean)
    .slice(0, 25);
  return {
    schema: MIRA_EMAIL_CURIOSITY_SNAPSHOT_SCHEMA,
    captured_at: trimText(snapshot.captured_at || snapshot.capturedAt) || new Date().toISOString(),
    source: trimText(snapshot.source || 'gmail_connector_metadata') || 'gmail_connector_metadata',
    query: oneLine(snapshot.query || snapshot.search_query || snapshot.searchQuery, 160) || null,
    labels,
    recent_messages,
    next_page_token_present: Boolean(snapshot.next_page_token || snapshot.nextPageToken),
  };
}

function writeMiraEmailCuriositySnapshot(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const snapshotPath = path.resolve(options.snapshotPath || payload.snapshotPath || defaultEmailCuriositySnapshotPath(projectRoot));
  const snapshot = normalizeEmailSnapshot(payload);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return {
    schema: MIRA_EMAIL_CURIOSITY_SNAPSHOT_SCHEMA,
    ok: true,
    decision: 'email_snapshot_written',
    snapshot_path: snapshotPath,
    label_count: snapshot.labels.length,
    recent_message_count: snapshot.recent_messages.length,
    applied: false,
    consequence_controls: {
      internal_only: true,
      read_only_source_capture: true,
      email_send_performed: false,
      email_modify_performed: false,
      email_body_read: false,
      external_send_performed: false,
    },
  };
}

function snapshotFromPayloadOrDisk(payload = {}, options = {}) {
  if (payload.snapshot || payload.labels || payload.message_ids || payload.recent_message_ids || payload.recent_messages) {
    return normalizeEmailSnapshot(payload);
  }
  if (options.snapshot && typeof options.snapshot === 'object') return normalizeEmailSnapshot(options.snapshot);
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const snapshotPath = path.resolve(options.snapshotPath || payload.snapshotPath || defaultEmailCuriositySnapshotPath(projectRoot));
  const fileSnapshot = readJsonFile(snapshotPath);
  return fileSnapshot ? normalizeEmailSnapshot(fileSnapshot) : null;
}

function readMiraEmailCuriosity(payload = {}, options = {}) {
  let snapshot;
  try {
    snapshot = snapshotFromPayloadOrDisk(payload, options);
  } catch (err) {
    return {
      schema: MIRA_EMAIL_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: 'email_snapshot_read_failed',
      error: err?.message || String(err),
      label_count: 0,
      recent_message_count: 0,
      no_mutation_performed: true,
    };
  }
  if (!snapshot) {
    return {
      schema: MIRA_EMAIL_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: 'email_connector_snapshot_missing',
      label_count: 0,
      recent_message_count: 0,
      no_mutation_performed: true,
    };
  }

  const labels = snapshot.labels.slice(0, 20);
  const unread_total = labels.reduce((sum, label) => sum + numberOrZero(label.messages_unread), 0);
  const message_total = labels.reduce((sum, label) => sum + numberOrZero(label.messages_total), 0);
  const top_labels = labels
    .slice()
    .sort((left, right) => right.messages_unread - left.messages_unread || right.messages_total - left.messages_total || left.name.localeCompare(right.name))
    .slice(0, 8)
    .map((label) => ({
      id: label.id,
      name: label.name,
      messages_total: label.messages_total,
      messages_unread: label.messages_unread,
      threads_unread: label.threads_unread,
    }));
  const recent_messages = snapshot.recent_messages.slice(0, 12);

  return {
    schema: MIRA_EMAIL_CURIOSITY_SCHEMA,
    ok: true,
    decision: 'email_metadata_read_only',
    source: snapshot.source,
    captured_at: snapshot.captured_at,
    query: snapshot.query,
    label_count: labels.length,
    unread_total,
    message_total,
    top_labels,
    recent_message_count: recent_messages.length,
    recent_messages,
    next_page_token_present: snapshot.next_page_token_present,
    no_mutation_performed: true,
    consequence_controls: {
      internal_only: true,
      read_only: true,
      email_body_read: false,
      email_send_performed: false,
      email_modify_performed: false,
      raw_message_ids_exposed: false,
      external_send_performed: false,
    },
  };
}

module.exports = {
  MIRA_EMAIL_CURIOSITY_SCHEMA,
  MIRA_EMAIL_CURIOSITY_SNAPSHOT_SCHEMA,
  defaultEmailCuriositySnapshotPath,
  normalizeEmailSnapshot,
  readMiraEmailCuriosity,
  writeMiraEmailCuriositySnapshot,
};
