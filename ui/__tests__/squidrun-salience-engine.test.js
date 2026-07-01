'use strict';

const {
  SALIENCE_SCHEMA_VERSION,
  candidateFromAuditEvent,
  candidateFromCommsRow,
  candidateFromWorkItem,
  geomean,
  pickTopSalience,
  scoreCandidate,
} = require('../modules/main/squidrun-salience-engine');

const NOW = Date.parse('2026-06-30T23:58:00.000Z');
const minsAgo = (n) => NOW - n * 60000;

function candidate(key, score, overrides = {}) {
  return {
    key,
    kind: overrides.kind || 'observed_signal',
    title: overrides.title || key,
    summary: overrides.summary || `${key} summary`,
    factors: { S: score, B: score, W: score, C: score },
    evidenceRefs: [{ type: 'fixture', ref: key }],
    observedAtMs: overrides.observedAtMs ?? minsAgo(10),
    priority: overrides.priority ?? 0,
    ...overrides,
  };
}

describe('squidrun salience engine', () => {
  test('picks top 3 by generalized regret score and audits swallowed losers', () => {
    const out = pickTopSalience({
      generatedAt: '2026-06-30T23:58:00.000Z',
      candidates: [
        candidate('route-proof-regression', 0.92),
        candidate('watchdog-false-positive', 0.82),
        candidate('stale-initiative', 0.72),
        candidate('minor-doc-cleanup', 0.62),
        candidate('uncertain-rumor', 0.88, { factors: { S: 0.88, B: 0.88, W: 0.88, C: 0 } }),
      ],
    });

    expect(out.schema).toBe(SALIENCE_SCHEMA_VERSION);
    expect(out.scoringModel).toBe('the_tell_regret_spine_generalized');
    expect(out.authorityPolicy).toBe('salience_only_no_dispatch');
    expect(out.picked.map((item) => item.key)).toEqual([
      'route-proof-regression',
      'watchdog-false-positive',
      'stale-initiative',
    ]);
    expect(out.picked[0]).toEqual(expect.objectContaining({
      reason: 'ranked_top_3_by_regret_of_silence',
      factors: { S: 0.92, B: 0.92, W: 0.92, C: 0.92 },
      evidenceRefs: [{ type: 'fixture', ref: 'route-proof-regression' }],
    }));
    expect(out.picked[0].authority).toEqual(expect.objectContaining({
      mode: 'rank_only_no_permission',
      grantsPermission: false,
      dispatcherPhase: 'phase3_james_checkpoint',
    }));
    expect(out.swallowed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'minor-doc-cleanup',
        reason: 'rank_4_below_top_3',
        lostTo: 'stale-initiative',
        wouldHaveSaid: 'minor-doc-cleanup',
      }),
      expect.objectContaining({
        key: 'uncertain-rumor',
        reason: 'factor_C_zero',
        blockedFactor: 'C',
      }),
    ]));
    expect(out.audit).toEqual(expect.objectContaining({
      candidateCount: 5,
      uniqueCandidateCount: 5,
      pickedCount: 3,
      swallowedCount: 2,
      tieBreakers: ['score_desc', 'priority_desc', 'observedAtMs_asc', 'key_asc'],
    }));
  });

  test('uses deterministic tie handling: score, priority, age, then key', () => {
    const out = pickTopSalience({
      candidates: [
        candidate('same-score-younger', 0.8, { observedAtMs: minsAgo(1) }),
        candidate('same-score-older', 0.8, { observedAtMs: minsAgo(20) }),
        candidate('priority-wins', 0.8, { priority: 5, observedAtMs: minsAgo(1) }),
        candidate('aaa-key-wins-last-tie', 0.7, { observedAtMs: minsAgo(5) }),
        candidate('zzz-key-loses-last-tie', 0.7, { observedAtMs: minsAgo(5) }),
      ],
      limit: 5,
    });

    expect(out.picked.map((item) => item.key)).toEqual([
      'priority-wins',
      'same-score-older',
      'same-score-younger',
      'aaa-key-wins-last-tie',
      'zzz-key-loses-last-tie',
    ]);
  });

  test('dedupes semantically repeated candidates and keeps swallowed duplicate audit rows', () => {
    const out = pickTopSalience({
      candidates: [
        candidateFromCommsRow({
          rowId: 73318,
          messageId: 'hm-long-proof',
          status: 'recorded',
          body: 'Long proof packet was recorded only.',
          factors: { S: 0.85, B: 0.95, W: 0.85, C: 0.65 },
        }),
        candidateFromCommsRow({
          rowId: 73319,
          messageId: 'hm-long-proof',
          status: 'routed',
          body: 'Same proof packet reached the route.',
          factors: { S: 0.9, B: 0.95, W: 0.9, C: 1 },
        }),
        candidateFromCommsRow({
          rowId: 73320,
          messageId: 'hm-distinct-proof',
          status: 'routed',
          body: 'Fresh distinct packet.',
          factors: { S: 0.75, B: 0.9, W: 0.9, C: 1 },
        }),
      ],
    });

    expect(out.audit).toEqual(expect.objectContaining({
      candidateCount: 3,
      uniqueCandidateCount: 2,
      duplicateCount: 1,
    }));
    expect(out.picked.map((item) => item.key)).toEqual([
      'comms_row:hm-long-proof',
      'comms_row:hm-distinct-proof',
    ]);
    expect(out.picked[0].evidenceRefs).toEqual([expect.objectContaining({
      type: 'comms_journal_row',
      rowId: '73319',
      messageId: 'hm-long-proof',
      status: 'routed',
    })]);
    expect(out.swallowed).toEqual([expect.objectContaining({
      key: 'comms_row:hm-long-proof',
      reason: 'semantic_duplicate_lower_salience',
      duplicateOf: 'comms_row:hm-long-proof',
      evidenceRefs: [expect.objectContaining({ rowId: '73318', status: 'recorded' })],
    })]);
  });

  test('preserves comms, WorkItem, and audit metadata across normalized inputs', () => {
    const workItemCandidate = candidateFromWorkItem({
      id: 'squidrun-salience-engine-phase2-462',
      state: 'active',
      objective: 'Build Phase 2 salience engine',
      session: { id: 'app-session-462' },
      profile: 'main',
      window: { key: 'main' },
      ownerRoles: ['builder', 'oracle'],
      riskClass: 'caution',
      proofState: { missingRoles: ['builder_code', 'oracle_verify'] },
      requiredProofs: [{ role: 'builder_code' }, { role: 'oracle_verify' }],
      updatedAt: '2026-06-30T23:55:00.000Z',
      path: 'D:/projects/squidrun/.squidrun/runtime/work-items/squidrun-salience-engine-phase2-462.json',
    });
    const commsCandidate = candidateFromCommsRow({
      rowId: 73345,
      messageId: 'hm-phase2-opened',
      deliveryId: 'delivery-phase2-opened',
      from: 'builder',
      to: 'oracle',
      status: 'routed',
      routeKind: 'agent_message',
      sessionId: 'app-session-462',
      profile: 'main',
      windowKey: 'main',
      body: 'Phase 2 WorkItem is open.',
      factors: { S: 0.6, B: 0.6, W: 0.8, C: 1 },
    });
    const auditCandidate = candidateFromAuditEvent({
      id: 'swallowed-row-auditability',
      type: 'audit_event',
      title: 'Swallowed rows need explanations',
      status: 'open',
      riskClass: 'safe',
      sessionId: 'app-session-462',
      profile: 'main',
      windowKey: 'main',
      evidenceRefs: [{ type: 'checklist', ref: 'phase2-gate' }],
      factors: { S: 0.55, B: 0.9, W: 0.9, C: 0.9 },
    });

    const out = pickTopSalience({
      candidates: [workItemCandidate, commsCandidate, auditCandidate],
    });

    expect(out.picked).toHaveLength(3);
    expect(out.picked.find((item) => item.kind === 'work_item')).toEqual(expect.objectContaining({
      key: 'work_item:squidrun-salience-engine-phase2-462',
      metadata: expect.objectContaining({
        sessionId: 'app-session-462',
        profile: 'main',
        windowKey: 'main',
        status: 'active',
        missingProofs: ['builder_code', 'oracle_verify'],
      }),
      evidenceRefs: [expect.objectContaining({
        type: 'work_item',
        ref: 'squidrun-salience-engine-phase2-462',
        status: 'active',
      })],
    }));
    expect(out.picked.find((item) => item.kind === 'comms_row')).toEqual(expect.objectContaining({
      source: expect.objectContaining({
        rowId: '73345',
        messageId: 'hm-phase2-opened',
        deliveryId: 'delivery-phase2-opened',
      }),
      metadata: expect.objectContaining({
        from: 'builder',
        to: 'oracle',
        routeKind: 'agent_message',
        status: 'routed',
      }),
    }));
    expect(out.picked.find((item) => item.kind === 'audit_event')).toEqual(expect.objectContaining({
      evidenceRefs: [expect.objectContaining({ type: 'checklist', ref: 'phase2-gate' })],
    }));
  });

  test('holds approval-required candidates as salience only, never authority dispatch', () => {
    const scored = scoreCandidate({
      key: 'phase3-authority-policy',
      title: 'Propose autonomous authority policy',
      riskClass: 'approval_required',
      factors: { S: 1, B: 1, W: 1, C: 1 },
    });

    expect(scored.score).toBe(1);
    expect(scored.authority).toEqual({
      mode: 'rank_only_no_permission',
      grantsPermission: false,
      dispatcherPhase: 'phase3_james_checkpoint',
      jamesCheckpointRequired: true,
    });
    const out = pickTopSalience({ candidates: [scored] });
    expect(out.picked[0].authority.grantsPermission).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/allowedActions|mayExecute|autoExecute|dispatchGranted/i);
  });

  test('closed WorkItems and below-threshold candidates remain auditable but unpicked', () => {
    const out = pickTopSalience({
      candidates: [
        candidateFromWorkItem({
          id: 'closed-work',
          state: 'closed',
          objective: 'Already closed',
          riskClass: 'caution',
          proofState: { missingRoles: [] },
        }),
        candidate('tiny-cleanup', 0.2),
      ],
    });

    expect(out.picked).toHaveLength(0);
    expect(out.swallowed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'work_item:closed-work',
        reason: 'factor_W_zero',
      }),
      expect.objectContaining({
        key: 'tiny-cleanup',
        reason: 'score_below_pick_threshold',
        threshold: 0.35,
      }),
    ]));
  });

  test('uses The Tell style geometric spine: any zero factor collapses score', () => {
    expect(geomean([0.8, 0.8, 0.8, 0.8])).toBeCloseTo(0.8);
    expect(geomean([1, 1, 1, 0])).toBe(0);
    expect(scoreCandidate({
      key: 'missing-confidence',
      factors: { S: 1, B: 1, W: 1, C: 0 },
    }).score).toBe(0);
  });
});
