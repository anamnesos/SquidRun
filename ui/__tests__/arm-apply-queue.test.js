const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  upsertArmRegistryManifest,
  closeArmRegistryStores,
} = require('../modules/main/arm-registry');
const {
  enqueueArmApplyRequest,
  getArmApplyRequest,
  markArmApplyRequestExecutable,
  dispatchArmApplyRequest,
  closeArmApplyQueueStores,
} = require('../modules/main/arm-apply-queue');

function hasSqliteDriver() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return true;
  } catch {
    // Continue to next fallback.
  }
  try {
    // eslint-disable-next-line global-require
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

function trustquoteManifest() {
  return {
    appRoomId: 'trustquote',
    sessionId: 'app-session-406:trustquote',
    mainSessionId: 'app-session-406',
    leadRole: 'trustquote-lead',
    leadPaneId: 'trustquote-lead',
    routeTarget: 'trustquote',
    arms: [
      {
        armKey: 'money-documents',
        role: 'trustquote-billing',
        paneId: 'trustquote-billing',
        routeTarget: 'trustquote-billing',
        armKind: 'domain',
        displayName: 'Money + Documents',
        dataSources: ['jobs', 'quotes', 'payments', 'pricebook'],
        permissions: { read: ['money_records'], draft: ['invoice', 'payment_reminder'] },
        checkInObligation: { required: true },
      },
    ],
  };
}

const HIGH_RISK_CATEGORIES = [
  'customer_message',
  'money_write',
  'schedule_mutation',
  'delete_archive',
  'refund_reversal',
  'production_repair',
];

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('arm apply queue', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-apply-queue-'));
    dbPath = path.join(tempDir, 'evidence-ledger.db');
    expect(upsertArmRegistryManifest(trustquoteManifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);
  });

  afterEach(() => {
    closeArmRegistryStores();
    closeArmApplyQueueStores();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('forces high-risk categories into durable approval-required rows', () => {
    for (const [index, category] of HIGH_RISK_CATEGORIES.entries()) {
      const queued = enqueueArmApplyRequest({
        appRoomId: 'trustquote',
        sessionId: 'app-session-406:trustquote',
        armKey: 'money-documents',
        actionCategory: category,
        riskClass: 'safe',
        evidenceRefs: [`trustquote-proof:${category}`],
        draftPayload: { category, proposedChange: 'draft-only' },
      }, { dbPath, nowMs: 2_000 + index });

      expect(queued.ok).toBe(true);
      expect(queued.status).toBe('approval_required');
      expect(queued.request).toEqual(expect.objectContaining({
        actionCategory: category,
        riskClass: 'approval_required',
        status: 'approval_required',
        approvalRequired: true,
        evidenceRefs: [`trustquote-proof:${category}`],
      }));
      expect(queued.request.sideEffectResult).toEqual(expect.objectContaining({
        dispatchEnabled: false,
        dispatched: false,
        noExecutionPerformed: true,
      }));
    }

    closeArmApplyQueueStores();
    const persisted = getArmApplyRequest({
      actionCategory: 'money_write',
      status: 'approval_required',
    }, { dbPath });
    expect(persisted).toEqual(expect.objectContaining({
      actionCategory: 'money_write',
      approvalRequired: true,
    }));
  });

  test('does not mark a risky request executable without explicit approval', () => {
    const queued = enqueueArmApplyRequest({
      requestId: 'apply-customer-message-1',
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'money-documents',
      actionCategory: 'customer_message',
      riskClass: 'safe',
      evidenceRefs: ['customer:123', 'draft:payment-reminder'],
      draftPayload: { message: 'Draft payment reminder, not sent.' },
    }, { dbPath, nowMs: 2_000 });
    expect(queued.ok).toBe(true);

    const blocked = markArmApplyRequestExecutable({
      requestId: 'apply-customer-message-1',
    }, { dbPath, nowMs: 3_000 });

    expect(blocked).toEqual(expect.objectContaining({
      ok: false,
      status: 'approval_required',
      executable: false,
    }));
    expect(getArmApplyRequest({ requestId: 'apply-customer-message-1' }, { dbPath })).toEqual(expect.objectContaining({
      status: 'approval_required',
      approvedBy: null,
      approvalRef: null,
    }));

    const approved = markArmApplyRequestExecutable({
      requestId: 'apply-customer-message-1',
      approvedBy: 'architect',
      approvalRef: 'hm-approval:67999',
    }, { dbPath, nowMs: 4_000 });

    expect(approved).toEqual(expect.objectContaining({
      ok: true,
      status: 'executable',
      executable: true,
    }));
    expect(approved.request).toEqual(expect.objectContaining({
      status: 'executable',
      approvedBy: 'architect',
      approvalRef: 'hm-approval:67999',
      approvedAtMs: 4000,
    }));
  });

  test('keeps the apply queue as a no-dispatch stub even after approval', () => {
    const queued = enqueueArmApplyRequest({
      requestId: 'apply-schedule-change-1',
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'money-documents',
      actionCategory: 'schedule_mutation',
      riskClass: 'safe',
      evidenceRefs: ['appointment:77', 'conflict:sourceEventId'],
      draftPayload: { moveAppointmentTo: '2026-06-07T14:00:00-07:00' },
    }, { dbPath, nowMs: 2_000 });
    expect(queued.ok).toBe(true);

    expect(markArmApplyRequestExecutable({
      requestId: 'apply-schedule-change-1',
      approvedBy: 'architect',
      approvalRef: 'hm-approval:68000',
    }, { dbPath, nowMs: 3_000 }).ok).toBe(true);

    const executor = jest.fn(() => ({ ok: true, status: 'sent' }));
    const dispatched = dispatchArmApplyRequest({
      requestId: 'apply-schedule-change-1',
    }, { dbPath, nowMs: 4_000, executor });

    expect(executor).not.toHaveBeenCalled();
    expect(dispatched).toEqual(expect.objectContaining({
      ok: false,
      status: 'executor_disabled',
      dispatched: false,
      dispatchEnabled: false,
    }));
    expect(dispatched.sideEffectResult).toEqual(expect.objectContaining({
      executorPresent: true,
      dispatchEnabled: false,
      dispatched: false,
      noExecutionPerformed: true,
      reason: 'executor_disabled',
      sideEffects: expect.objectContaining({
        customerMessagesSent: 0,
        moneyWrites: 0,
        scheduleMutations: 0,
        deleteArchiveActions: 0,
        refundReversalActions: 0,
        productionRepairActions: 0,
      }),
    }));
    expect(dispatched.request).toEqual(expect.objectContaining({
      status: 'dispatch_blocked',
      sideEffectResult: expect.objectContaining({
        noExecutionPerformed: true,
      }),
    }));
  });
});
