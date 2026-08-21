'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const webPushDefault = require('web-push');
const {
  NOTIFICATION_CLASSES,
  normalizeRoomNotificationClass,
} = require('./team-room-contracts');

const PUSH_STATE_SCHEMA = 'squidrun.team_room_push_state.v1';
const PUSH_VAPID_SCHEMA = 'squidrun.team_room_push_vapid.v1';
const DEFAULT_QUIET_START = '23:30';
const DEFAULT_QUIET_END = '07:30';
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DELIVERY_RECEIPTS = 2_000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  try { fs.chmodSync(filePath, mode); } catch {}
}

function normalizeClock(value, fallback) {
  const text = String(value || '').trim();
  return CLOCK_PATTERN.test(text) ? text : fallback;
}

function minuteOfDay(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

function isQuietTime(nowMs, quietStart, quietEnd) {
  const start = minuteOfDay(normalizeClock(quietStart, DEFAULT_QUIET_START));
  const end = minuteOfDay(normalizeClock(quietEnd, DEFAULT_QUIET_END));
  if (start === end) return false;
  const date = new Date(Number(nowMs));
  const current = date.getHours() * 60 + date.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function validatePushSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'team_room_push_subscription_required' };
  }
  const endpoint = String(value.endpoint || '').trim();
  let parsed;
  try { parsed = new URL(endpoint); } catch {
    return { ok: false, reason: 'team_room_push_endpoint_invalid' };
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || endpoint.length > 4_096) {
    return { ok: false, reason: 'team_room_push_endpoint_invalid' };
  }
  const p256dh = String(value.keys?.p256dh || '').trim();
  const auth = String(value.keys?.auth || '').trim();
  if (!BASE64URL_PATTERN.test(p256dh) || p256dh.length < 40 || p256dh.length > 256
    || !BASE64URL_PATTERN.test(auth) || auth.length < 16 || auth.length > 128) {
    return { ok: false, reason: 'team_room_push_keys_invalid' };
  }
  const expirationTime = value.expirationTime === null || value.expirationTime === undefined
    ? null
    : Number(value.expirationTime);
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= 0)) {
    return { ok: false, reason: 'team_room_push_expiration_invalid' };
  }
  return {
    ok: true,
    subscription: {
      endpoint,
      expirationTime,
      keys: { p256dh, auth },
    },
  };
}

function freshState() {
  return {
    schema: PUSH_STATE_SCHEMA,
    subscriptions: [],
    deliveries: [],
  };
}

function normalizeStoredState(value) {
  if (!value || value.schema !== PUSH_STATE_SCHEMA
    || !Array.isArray(value.subscriptions) || !Array.isArray(value.deliveries)) {
    throw new Error('team_room_push_state_invalid');
  }
  return value;
}

function deliveryPayload(message, notificationClass) {
  const sender = ({ architect: 'Mira', builder: 'Rook', oracle: 'Vera' })[String(message.authorId || '')]
    || 'Team Room';
  return JSON.stringify({
    schema: 'squidrun.team_room_push.v1',
    sender,
    messageId: String(message.messageId || ''),
    notificationClass,
    url: '/',
  });
}

class TeamRoomPushManager {
  constructor(options = {}) {
    if (!options.projectRoot && !options.rootPath) throw new Error('team_room_push_root_required');
    this.rootPath = path.resolve(options.rootPath || path.join(options.projectRoot, '.squidrun', 'room', 'push'));
    this.vapidPath = path.join(this.rootPath, 'vapid.json');
    this.statePath = path.join(this.rootPath, 'state.json');
    this.webPush = options.webPush || webPushDefault;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.isCredentialActive = typeof options.isCredentialActive === 'function'
      ? options.isCredentialActive
      : () => false;
    this.isViewerPresent = typeof options.isViewerPresent === 'function'
      ? options.isViewerPresent
      : () => false;
    this.vapidSubject = String(options.vapidSubject || 'https://squidrun.com').trim();
    this.vapid = null;
    this.state = null;
    this.inFlight = new Set();
  }

  init() {
    fs.mkdirSync(this.rootPath, { recursive: true });
    this.vapid = this._loadOrCreateVapid();
    this.state = fs.existsSync(this.statePath)
      ? normalizeStoredState(JSON.parse(fs.readFileSync(this.statePath, 'utf8')))
      : freshState();
    if (!fs.existsSync(this.statePath)) this._persist();
    this.webPush.setVapidDetails(this.vapidSubject, this.vapid.publicKey, this.vapid.privateKey);
    return { ok: true, publicKey: this.vapid.publicKey };
  }

  _loadOrCreateVapid() {
    if (fs.existsSync(this.vapidPath)) {
      const existing = JSON.parse(fs.readFileSync(this.vapidPath, 'utf8'));
      if (existing?.schema !== PUSH_VAPID_SCHEMA
        || !BASE64URL_PATTERN.test(String(existing.publicKey || ''))
        || !BASE64URL_PATTERN.test(String(existing.privateKey || ''))) {
        throw new Error('team_room_push_vapid_invalid');
      }
      return existing;
    }
    const generated = this.webPush.generateVAPIDKeys();
    if (!generated || !BASE64URL_PATTERN.test(String(generated.publicKey || ''))
      || !BASE64URL_PATTERN.test(String(generated.privateKey || ''))) {
      throw new Error('team_room_push_vapid_generation_failed');
    }
    const vapid = {
      schema: PUSH_VAPID_SCHEMA,
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      createdAtMs: Number(this.now()),
    };
    writeJsonAtomic(this.vapidPath, vapid);
    return vapid;
  }

  _requireReady() {
    if (!this.vapid || !this.state) throw new Error('team_room_push_not_initialized');
  }

  _persist() {
    this._requireReady();
    writeJsonAtomic(this.statePath, this.state);
  }

  publicKey() {
    this._requireReady();
    return this.vapid.publicKey;
  }

  settingsForCredential(credentialId) {
    this._requireReady();
    const subscription = this.state.subscriptions.find((item) => item.credentialId === String(credentialId));
    return {
      enabled: Boolean(subscription),
      quietStart: subscription?.preferences?.quietStart || DEFAULT_QUIET_START,
      quietEnd: subscription?.preferences?.quietEnd || DEFAULT_QUIET_END,
      previewsEnabled: false,
    };
  }

  subscribe(credentialId, rawSubscription, preferences = {}) {
    this._requireReady();
    const credential = String(credentialId || '').trim();
    if (!credential) return { ok: false, reason: 'team_room_push_credential_required' };
    if (!this.isCredentialActive(credential)) {
      return { ok: false, reason: 'team_room_push_credential_inactive' };
    }
    const checked = validatePushSubscription(rawSubscription);
    if (!checked.ok) return checked;
    const nowMs = Number(this.now());
    const subscriptionId = `trp_${sha256(`${credential}\0${checked.subscription.endpoint}`).slice(0, 32)}`;
    this.state.subscriptions = this.state.subscriptions.filter((item) => (
      item.credentialId !== credential && item.subscription.endpoint !== checked.subscription.endpoint
    ));
    this.state.subscriptions.push({
      subscriptionId,
      credentialId: credential,
      subscription: checked.subscription,
      preferences: {
        quietStart: normalizeClock(preferences.quietStart, DEFAULT_QUIET_START),
        quietEnd: normalizeClock(preferences.quietEnd, DEFAULT_QUIET_END),
      },
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    this._persist();
    return { ok: true, settings: this.settingsForCredential(credential) };
  }

  updatePreferences(credentialId, preferences = {}) {
    this._requireReady();
    const subscription = this.state.subscriptions.find((item) => item.credentialId === String(credentialId));
    if (!subscription) return { ok: false, reason: 'team_room_push_subscription_not_found' };
    const quietStart = String(preferences.quietStart || '').trim();
    const quietEnd = String(preferences.quietEnd || '').trim();
    if (!CLOCK_PATTERN.test(quietStart) || !CLOCK_PATTERN.test(quietEnd)) {
      return { ok: false, reason: 'team_room_push_quiet_hours_invalid' };
    }
    subscription.preferences = { quietStart, quietEnd };
    subscription.updatedAtMs = Number(this.now());
    this._persist();
    return { ok: true, settings: this.settingsForCredential(credentialId) };
  }

  removeCredential(credentialId) {
    this._requireReady();
    const credential = String(credentialId || '').trim();
    const beforeSubscriptions = this.state.subscriptions.length;
    const beforeDeliveries = this.state.deliveries.length;
    this.state.subscriptions = this.state.subscriptions.filter((item) => item.credentialId !== credential);
    const removedIds = new Set(this.state.deliveries
      .filter((item) => item.credentialId === credential)
      .map((item) => item.subscriptionId));
    this.state.deliveries = this.state.deliveries.filter((item) => (
      item.credentialId !== credential && !removedIds.has(item.subscriptionId)
    ));
    if (beforeSubscriptions !== this.state.subscriptions.length
      || beforeDeliveries !== this.state.deliveries.length) {
      this._persist();
    }
    return { ok: true, removed: beforeSubscriptions - this.state.subscriptions.length };
  }

  _pruneInactive() {
    const before = this.state.subscriptions.length;
    const inactiveIds = new Set(this.state.subscriptions
      .filter((item) => !this.isCredentialActive(item.credentialId))
      .map((item) => item.subscriptionId));
    if (inactiveIds.size === 0) return false;
    this.state.subscriptions = this.state.subscriptions.filter((item) => !inactiveIds.has(item.subscriptionId));
    this.state.deliveries = this.state.deliveries.filter((item) => !inactiveIds.has(item.subscriptionId));
    return before !== this.state.subscriptions.length;
  }

  _pruneDeliveries() {
    const before = this.state.deliveries.length;
    const cutoff = Number(this.now()) - DELIVERY_RETENTION_MS;
    this.state.deliveries = this.state.deliveries
      .filter((item) => Number(item.deliveredAtMs) >= cutoff)
      .sort((a, b) => Number(b.deliveredAtMs) - Number(a.deliveredAtMs))
      .slice(0, MAX_DELIVERY_RECEIPTS);
    return before !== this.state.deliveries.length;
  }

  async notifyForMessage(message = {}) {
    this._requireReady();
    const notificationClass = normalizeRoomNotificationClass(message.metadata?.notificationClass);
    if (!notificationClass) return { ok: true, sent: 0, reason: 'notification_not_requested' };
    if (message.author?.memberKind !== 'agent' || message.authorId === 'james') {
      return { ok: true, sent: 0, reason: 'notification_author_ineligible' };
    }
    if (this.isViewerPresent('james')) {
      return { ok: true, sent: 0, reason: 'viewer_present' };
    }
    let changed = this._pruneInactive();
    changed = this._pruneDeliveries() || changed;
    if (this.state.subscriptions.length === 0) {
      if (changed) this._persist();
      return {
        ok: false,
        sent: 0,
        failed: 0,
        suppressedQuiet: 0,
        reason: 'team_room_push_no_subscriptions',
      };
    }
    const deliveredKeys = new Set(this.state.deliveries.map((item) => item.deliveryKey));
    let sent = 0;
    let failed = 0;
    let suppressedQuiet = 0;
    for (const item of [...this.state.subscriptions]) {
      if (notificationClass !== NOTIFICATION_CLASSES.FAILURE
        && isQuietTime(this.now(), item.preferences?.quietStart, item.preferences?.quietEnd)) {
        suppressedQuiet += 1;
        continue;
      }
      const deliveryKey = sha256(`${message.messageId}\0${item.subscriptionId}`);
      if (deliveredKeys.has(deliveryKey) || this.inFlight.has(deliveryKey)) continue;
      this.inFlight.add(deliveryKey);
      try {
        await this.webPush.sendNotification(
          item.subscription,
          deliveryPayload(message, notificationClass),
          { TTL: 300, urgency: notificationClass === NOTIFICATION_CLASSES.FAILURE ? 'high' : 'normal' }
        );
        this.state.deliveries.push({
          deliveryKey,
          messageId: String(message.messageId),
          subscriptionId: item.subscriptionId,
          credentialId: item.credentialId,
          deliveredAtMs: Number(this.now()),
        });
        deliveredKeys.add(deliveryKey);
        sent += 1;
        changed = true;
      } catch (error) {
        const statusCode = Number(error?.statusCode || error?.status || 0);
        if ([404, 410].includes(statusCode)) {
          this.state.subscriptions = this.state.subscriptions
            .filter((candidate) => candidate.subscriptionId !== item.subscriptionId);
          this.state.deliveries = this.state.deliveries
            .filter((candidate) => candidate.subscriptionId !== item.subscriptionId);
          failed += 1;
          changed = true;
        } else {
          failed += 1;
        }
      } finally {
        this.inFlight.delete(deliveryKey);
      }
    }
    changed = this._pruneDeliveries() || changed;
    if (changed) this._persist();
    return {
      ok: failed === 0,
      sent,
      failed,
      suppressedQuiet,
      reason: failed > 0
        ? 'team_room_push_delivery_failed'
        : sent > 0
          ? 'team_room_push_delivered'
          : suppressedQuiet > 0
            ? 'quiet_hours'
            : 'team_room_push_already_delivered',
    };
  }
}

module.exports = {
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  NOTIFICATION_CLASSES,
  PUSH_STATE_SCHEMA,
  PUSH_VAPID_SCHEMA,
  TeamRoomPushManager,
  deliveryPayload,
  isQuietTime,
  normalizeNotificationClass: normalizeRoomNotificationClass,
  validatePushSubscription,
  writeJsonAtomic,
};
