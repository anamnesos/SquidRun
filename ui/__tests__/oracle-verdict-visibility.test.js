const {
  classifyOracleVerdictRow,
  collectPendingOracleVerdicts,
} = require('../modules/oracle-verdict-visibility');

describe('oracle verdict visibility classifier', () => {
  test('marks Oracle 86-style recorded PASS as pending visibility', () => {
    const row = {
      messageId: 'hm-oracle-86',
      senderRole: 'oracle',
      targetRole: 'architect',
      rawBody: '(ORACLE 86): PASS',
      status: 'recorded',
      metadata: { source: 'hm-send' },
    };

    expect(classifyOracleVerdictRow(row)).toEqual(expect.objectContaining({
      isOracleVerdict: true,
      pending: true,
      visible: false,
      verdict: 'PASS',
      sourceRef: 'oracle#86',
      status: 'recorded',
    }));
    expect(collectPendingOracleVerdicts([row])).toEqual([
      expect.objectContaining({
        kind: 'oracle_verdict_visibility_pending',
        messageId: 'hm-oracle-86',
        sourceRef: 'oracle#86',
        verdict: 'PASS',
        ackStatus: 'visibility_unverified',
      }),
    ]);
  });

  test('marks routed unverified Oracle PASS rows as pending visibility', () => {
    const rows = [
      {
        messageId: 'hm-oracle-83',
        senderRole: 'oracle',
        targetRole: 'architect',
        rawBody: '(ORACLE 83): PASS. Diagnosis follows.',
        status: 'routed',
        ackStatus: 'routed_unverified_timeout',
        metadata: {
          deliveryAccepted: true,
          deliveryVerified: false,
          finalOutcome: 'routed_unverified_timeout',
        },
      },
      {
        messageId: 'hm-oracle-79',
        senderRole: 'oracle',
        targetRole: 'architect',
        rawBody: '(ORACLE #79): PASS',
        status: 'routed',
        ackStatus: 'accepted.daemon_pty_unverified',
        metadata: {
          deliveryAccepted: true,
          deliveryVerified: false,
          finalOutcome: 'accepted.daemon_pty_unverified',
        },
      },
    ];

    const pending = collectPendingOracleVerdicts(rows, { limit: 5 });
    expect(pending).toHaveLength(2);
    expect(pending[0]).toEqual(expect.objectContaining({
      messageId: 'hm-oracle-83',
      sourceRef: 'oracle#83',
      ackStatus: 'routed_unverified_timeout',
    }));
    expect(pending[1]).toEqual(expect.objectContaining({
      messageId: 'hm-oracle-79',
      sourceRef: 'oracle#79',
      ackStatus: 'accepted.daemon_pty_unverified',
    }));
  });

  test('closes verified verdict rows instead of showing pending visibility', () => {
    const row = {
      messageId: 'hm-oracle-91',
      senderRole: 'oracle',
      targetRole: 'architect',
      rawBody: '(ORACLE 91): MODIFY before commit.',
      status: 'acked',
      ackStatus: 'delivered.verified',
      metadata: {
        deliveryAccepted: true,
        deliveryVerified: true,
      },
    };

    expect(classifyOracleVerdictRow(row)).toEqual(expect.objectContaining({
      isOracleVerdict: true,
      pending: false,
      visible: true,
      verdict: 'MODIFY',
    }));
    expect(collectPendingOracleVerdicts([row])).toEqual([]);
  });

  test('ignores non-verdict Oracle ACK chatter', () => {
    const row = {
      messageId: 'hm-oracle-92',
      senderRole: 'oracle',
      targetRole: 'architect',
      rawBody: '(ORACLE 92): ACK. I saw Builder packet and will review.',
      status: 'recorded',
      metadata: { source: 'hm-send' },
    };

    expect(classifyOracleVerdictRow(row)).toEqual(expect.objectContaining({
      isOracleVerdict: false,
      pending: false,
      visible: false,
      verdict: null,
    }));
    expect(collectPendingOracleVerdicts([row])).toEqual([]);
  });
});
