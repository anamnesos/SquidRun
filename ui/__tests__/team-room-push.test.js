'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  NOTIFICATION_CLASSES,
  TeamRoomPushManager,
  deliveryPayload,
} = require('../modules/main/team-room-push');

const PUBLIC_KEY = `B${'a'.repeat(86)}`;
const PRIVATE_KEY = 'b'.repeat(43);
const SUBSCRIPTION = Object.freeze({
  endpoint: 'https://push.example.test/device-one',
  expirationTime: null,
  keys: {
    p256dh: 'c'.repeat(65),
    auth: 'd'.repeat(22),
  },
});

function questionMessage(overrides = {}) {
  return {
    messageId: 'trm_question_one',
    authorId: 'oracle',
    author: { memberId: 'oracle', memberKind: 'agent', displayName: 'Vera' },
    participationReason: 'real_question',
    body: 'This private room text must never enter the push payload.',
    metadata: { notificationClass: NOTIFICATION_CLASSES.QUESTION },
    ...overrides,
  };
}

function managerFixture(tempRoot, overrides = {}) {
  const active = overrides.active || new Set(['cred-one']);
  const webPush = overrides.webPush || {
    generateVAPIDKeys: jest.fn(() => ({ publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY })),
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(async () => ({ statusCode: 201 })),
  };
  const manager = new TeamRoomPushManager({
    projectRoot: tempRoot,
    webPush,
    now: overrides.now || (() => new Date(2026, 7, 21, 12, 0, 0).getTime()),
    isCredentialActive: (credentialId) => active.has(credentialId),
    isViewerPresent: overrides.isViewerPresent || (() => false),
  });
  manager.init();
  return { manager, webPush, active };
}

describe('Team Room Web Push manager', () => {
  let tempRoot;

  beforeEach(() => { tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-push-')); });
  afterEach(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

  test('keeps VAPID and subscriptions local, exact-credential bound, and lock-screen generic', async () => {
    const { manager, webPush } = managerFixture(tempRoot);
    expect(manager.subscribe('cred-one', SUBSCRIPTION)).toEqual(expect.objectContaining({ ok: true }));
    const result = await manager.notifyForMessage(questionMessage());
    expect(result).toEqual({
      ok: true, sent: 1, failed: 0, suppressedQuiet: 0, reason: 'team_room_push_delivered',
    });
    expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    const payload = webPush.sendNotification.mock.calls[0][1];
    expect(payload).toContain('"sender":"Vera"');
    expect(payload).not.toContain('private room text');
    expect(JSON.parse(payload)).toEqual(expect.objectContaining({
      messageId: 'trm_question_one',
      notificationClass: NOTIFICATION_CLASSES.QUESTION,
    }));
    const state = JSON.parse(fs.readFileSync(manager.statePath, 'utf8'));
    expect(state.subscriptions[0]).toEqual(expect.objectContaining({ credentialId: 'cred-one' }));
    expect(fs.existsSync(manager.vapidPath)).toBe(true);
  });

  test('suppresses an ordinary alert in quiet hours while allowing a failure alert through', async () => {
    const { manager, webPush } = managerFixture(tempRoot, {
      now: () => new Date(2026, 7, 21, 1, 0, 0).getTime(),
    });
    manager.subscribe('cred-one', SUBSCRIPTION);
    await expect(manager.notifyForMessage(questionMessage())).resolves.toEqual({
      ok: true, sent: 0, failed: 0, suppressedQuiet: 1, reason: 'quiet_hours',
    });
    const failure = questionMessage({
      messageId: 'trm_failure_one',
      participationReason: 'new_evidence_or_action',
      metadata: { notificationClass: NOTIFICATION_CLASSES.FAILURE },
    });
    await expect(manager.notifyForMessage(failure)).resolves.toEqual({
      ok: true, sent: 1, failed: 0, suppressedQuiet: 0, reason: 'team_room_push_delivered',
    });
    expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
  });

  test('stays quiet while Operator is actively reading the room', async () => {
    const { manager, webPush } = managerFixture(tempRoot, { isViewerPresent: () => true });
    manager.subscribe('cred-one', SUBSCRIPTION);
    await expect(manager.notifyForMessage(questionMessage())).resolves.toEqual({
      ok: true, sent: 0, reason: 'viewer_present',
    });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });

  test('reports an explicit notification intent honestly when no phone is subscribed', async () => {
    const { manager } = managerFixture(tempRoot);
    await expect(manager.notifyForMessage(questionMessage())).resolves.toEqual({
      ok: false,
      sent: 0,
      failed: 0,
      suppressedQuiet: 0,
      reason: 'team_room_push_no_subscriptions',
    });
  });

  test('deduplicates concurrent and repeated delivery by message plus subscription', async () => {
    let release;
    const webPush = {
      generateVAPIDKeys: jest.fn(() => ({ publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY })),
      setVapidDetails: jest.fn(),
      sendNotification: jest.fn(() => new Promise((resolve) => { release = resolve; })),
    };
    const { manager } = managerFixture(tempRoot, { webPush });
    manager.subscribe('cred-one', SUBSCRIPTION);
    const first = manager.notifyForMessage(questionMessage());
    await Promise.resolve();
    const second = manager.notifyForMessage(questionMessage());
    release({ statusCode: 201 });
    await Promise.all([first, second]);
    await manager.notifyForMessage(questionMessage());
    expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
  });

  test('prunes revoked credentials and 404/410 subscriptions', async () => {
    const { manager, webPush, active } = managerFixture(tempRoot);
    manager.subscribe('cred-one', SUBSCRIPTION);
    active.delete('cred-one');
    await manager.notifyForMessage(questionMessage());
    expect(manager.settingsForCredential('cred-one').enabled).toBe(false);

    active.add('cred-one');
    manager.subscribe('cred-one', SUBSCRIPTION);
    webPush.sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    await manager.notifyForMessage(questionMessage({ messageId: 'trm_gone' }));
    expect(manager.settingsForCredential('cred-one').enabled).toBe(false);
  });

  test('persists delivery-only credential cleanup even when no subscription remains', () => {
    const { manager } = managerFixture(tempRoot);
    manager.state.deliveries.push({
      deliveryKey: 'stale', messageId: 'trm_old', subscriptionId: 'sub_old',
      credentialId: 'cred-one', deliveredAtMs: Date.now(),
    });
    manager._persist();
    expect(manager.removeCredential('cred-one')).toEqual({ ok: true, removed: 0 });
    expect(JSON.parse(fs.readFileSync(manager.statePath, 'utf8')).deliveries).toEqual([]);
  });

  test('payload helper never carries message body or subscription material', () => {
    const payload = deliveryPayload(questionMessage(), NOTIFICATION_CLASSES.QUESTION);
    expect(payload).not.toContain('private room text');
    expect(payload).not.toContain(SUBSCRIPTION.endpoint);
    expect(payload).not.toContain(SUBSCRIPTION.keys.auth);
  });
});
