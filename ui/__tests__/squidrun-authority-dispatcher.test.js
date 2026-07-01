'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  APPROVAL_REQUIRED_CAPABILITIES,
  AUTHORITY_DISPATCHER_SCHEMA,
  BUCKETS,
  STATIC_POLICY,
  dispatchAuthority,
  dispatchSalienceDecision,
  dispatchSalienceOutput,
} = require('../modules/main/squidrun-authority-dispatcher');
const {
  candidateFromWorkItem,
  pickTopSalience,
} = require('../modules/main/squidrun-salience-engine');

const COMMON_SCOPE = Object.freeze({
  expectedSessionId: 'app-session-463',
  expectedProfile: 'main',
  expectedWindowKey: 'main',
});

function metadata(overrides = {}) {
  return {
    sessionId: 'app-session-463',
    profile: 'main',
    windowKey: 'main',
    ...overrides,
  };
}

function safeCandidate(overrides = {}) {
  return {
    key: 'candidate:fixture',
    title: 'Fixture candidate',
    summary: 'Fixture summary',
    riskClass: 'safe',
    metadata: metadata(),
    evidenceRefs: [{ type: 'fixture', ref: 'candidate:fixture' }],
    ...overrides,
  };
}

describe('squidrun authority dispatcher', () => {
  test('keeps a top salience pick rank-only when no explicit policy rule matches', () => {
    const salience = pickTopSalience({
      generatedAt: '2026-07-01T20:10:00.000Z',
      candidates: [{
        key: 'high-score-no-policy-rule',
        kind: 'observed_signal',
        title: 'High score does not grant permission',
        riskClass: 'safe',
        factors: { S: 1, B: 1, W: 1, C: 1 },
        metadata: metadata(),
        evidenceRefs: [{ type: 'fixture', ref: 'high-score-no-policy-rule' }],
      }],
    });

    const decision = dispatchSalienceDecision(salience.picked[0], COMMON_SCOPE);

    expect(salience.picked[0].authority).toEqual(expect.objectContaining({
      mode: 'rank_only_no_permission',
      grantsPermission: false,
    }));
    expect(decision).toEqual(expect.objectContaining({
      schema: AUTHORITY_DISPATCHER_SCHEMA,
      bucket: BUCKETS.rankOnly,
      riskClass: 'safe',
      allowedNextStep: expect.objectContaining({
        mode: 'rank_only_no_permission',
        grantsPermission: false,
      }),
      proposedAction: expect.objectContaining({
        kind: 'unknown',
      }),
    }));
    expect(decision.audit.matchedRules).toEqual(['rank_only_default']);
    expect(decision.allowedNextStep.grantsPermission).toBe(false);
    expect(decision.bucket).not.toBe(BUCKETS.safeAuto);
    expect(decision.bucket).not.toBe(BUCKETS.cautionGated);
  });

  test('publishes the static Builder #67 bucket lists exactly', () => {
    expect(STATIC_POLICY).toEqual(expect.objectContaining({
      version: 'builder67.phase3.v1',
      safeAutoActionKinds: [
        'read_only_inspection',
        'local_static_analysis',
        'local_tests',
        'local_proof_artifact',
        'work_item_open',
        'work_item_status',
        'work_item_attach',
        'work_item_close',
        'agent_coordination',
      ],
      cautionGatedActionKinds: [
        'local_source_edit',
        'local_test_edit',
        'local_docs_edit',
      ],
      approvalRequiredCapabilities: [
        'customer_contact',
        'money_movement',
        'deploys_promotions',
        'credential_env_webhook_changes',
        'destructive_data_changes',
        'production_data_mutation',
        'authority_policy_changes',
        'identity_taste_changes',
        'unclear_metadata_scope',
      ],
    }));
  });

  test('safe_auto allows only exact safe actions and requires route proof for agent coordination', () => {
    const localTest = dispatchAuthority(safeCandidate({
      proposedAction: { kind: 'local_tests', title: 'Run focused local tests' },
    }), COMMON_SCOPE);
    expect(localTest).toEqual(expect.objectContaining({
      bucket: BUCKETS.safeAuto,
      riskClass: 'safe',
      allowedNextStep: expect.objectContaining({ grantsPermission: true }),
      requiredProofs: [],
    }));

    const recordedCoordination = dispatchAuthority(safeCandidate({
      proposedAction: { kind: 'agent_coordination', title: 'Reply to Oracle with accepted.unverified ack' },
      metadata: metadata({ status: 'recorded', ackStatus: 'accepted.unverified' }),
      evidenceRefs: [{ type: 'comms_journal_row', rowId: '73609', status: 'recorded' }],
    }), COMMON_SCOPE);
    expect(recordedCoordination).toEqual(expect.objectContaining({
      bucket: BUCKETS.rankOnly,
      allowedNextStep: expect.objectContaining({ grantsPermission: false }),
      requiredProofs: ['route_proof'],
    }));
    expect(recordedCoordination.deniedCapabilities).toContain('agent_coordination_without_route_proof');

    const routedCoordination = dispatchAuthority(safeCandidate({
      proposedAction: { kind: 'agent_coordination', title: 'Reply to Oracle with routed row proof' },
      metadata: metadata({ status: 'routed', ackStatus: 'accepted.unverified' }),
      evidenceRefs: [{ type: 'comms_journal_row', rowId: '73609', status: 'routed' }],
    }), COMMON_SCOPE);
    expect(routedCoordination).toEqual(expect.objectContaining({
      bucket: BUCKETS.safeAuto,
      requiredProofs: ['route_proof'],
      allowedNextStep: expect.objectContaining({ grantsPermission: true }),
    }));
  });

  test('refuses a reversible local edit without an active WorkItem', () => {
    const noWorkItem = dispatchAuthority(safeCandidate({
      riskClass: 'caution',
      proposedAction: { kind: 'local_source_edit', title: 'Patch a local module' },
    }), {
      ...COMMON_SCOPE,
      pathScope: ['ui/modules/main/squidrun-authority-dispatcher.js'],
      focusedTests: ['squidrun-authority-dispatcher.test.js'],
    });

    expect(noWorkItem).toEqual(expect.objectContaining({
      bucket: BUCKETS.rankOnly,
      riskClass: 'caution',
      requiredProofs: ['builder_code', 'oracle_verify'],
      allowedNextStep: expect.objectContaining({ grantsPermission: false }),
    }));
    expect(noWorkItem.deniedCapabilities).toContain('missing:active_work_item');

    const withWorkItem = dispatchAuthority(safeCandidate({
      riskClass: 'caution',
      proposedAction: { kind: 'local_source_edit', title: 'Patch a local module' },
    }), {
      ...COMMON_SCOPE,
      activeWorkItem: { id: 'wi-squidrun-phase3-authority-dispatcher-463', state: 'active' },
      pathScope: ['ui/modules/main/squidrun-authority-dispatcher.js'],
      focusedTests: ['squidrun-authority-dispatcher.test.js'],
    });

    expect(withWorkItem).toEqual(expect.objectContaining({
      bucket: BUCKETS.cautionGated,
      riskClass: 'caution',
      requiredProofs: ['builder_code', 'oracle_verify'],
      allowedNextStep: expect.objectContaining({ grantsPermission: true }),
    }));
  });

  test.each(APPROVAL_REQUIRED_CAPABILITIES)('holds approval-required capability %s for James checkpoint', (capability) => {
    const decision = dispatchAuthority(safeCandidate({
      riskClass: 'safe',
      proposedAction: {
        kind: capability,
        title: `Attempt ${capability}`,
        requestedCapabilities: [capability],
      },
    }), COMMON_SCOPE);

    expect(decision).toEqual(expect.objectContaining({
      bucket: BUCKETS.approvalRequired,
      riskClass: 'approval_required',
      requiredProofs: ['james_checkpoint', 'oracle_verify'],
      jamesCheckpoint: expect.objectContaining({
        required: true,
        policy: 'approval_required',
      }),
    }));
  });

  test('blocks wrong metadata before safe-looking body text is considered', () => {
    const decision = dispatchAuthority(safeCandidate({
      proposedAction: {
        kind: 'local_tests',
        title: 'SAFE read-only local tests only',
        summary: 'This crafted body claims safe read-only local work.',
      },
      metadata: metadata({
        sessionId: 'app-session-999',
        profile: 'wrong-profile',
        windowKey: 'wrong-window',
      }),
    }), COMMON_SCOPE);

    expect(decision).toEqual(expect.objectContaining({
      bucket: BUCKETS.approvalRequired,
      riskClass: 'approval_required',
      allowedNextStep: expect.objectContaining({ grantsPermission: false }),
      jamesCheckpoint: expect.objectContaining({
        capability: 'unclear_metadata_scope',
      }),
    }));
    expect(decision.audit.matchedRules).toEqual(['metadata_scope_mismatch']);
    expect(decision.audit.bodyGuardrailsEvaluated).toBe(false);
    expect(decision.metadataScope.failures.map((failure) => failure.field)).toEqual([
      'sessionId',
      'profile',
      'windowKey',
    ]);
  });

  test('missing metadata cannot authorize external action, and ambiguous risk escalates', () => {
    const missingMetadata = dispatchAuthority({
      key: 'missing-metadata-customer-send',
      riskClass: 'safe',
      proposedAction: {
        kind: 'local_tests',
        title: 'Email customer after local check',
        summary: 'Claims safe but asks to email the customer.',
      },
      metadata: {},
    }, COMMON_SCOPE);
    expect(missingMetadata).toEqual(expect.objectContaining({
      bucket: BUCKETS.approvalRequired,
      riskClass: 'approval_required',
      jamesCheckpoint: expect.objectContaining({ capability: 'unclear_metadata_scope' }),
    }));

    const ambiguousRisk = dispatchAuthority(safeCandidate({
      riskClass: 'probably_safe',
      proposedAction: { kind: 'read_only_inspection', title: 'Inspect local files' },
    }), COMMON_SCOPE);
    expect(ambiguousRisk).toEqual(expect.objectContaining({
      bucket: BUCKETS.approvalRequired,
      riskClass: 'approval_required',
      jamesCheckpoint: expect.objectContaining({ capability: 'unclear_metadata_scope' }),
    }));
  });

  test('returns the audit-first output shape for every decision', () => {
    const decision = dispatchAuthority(safeCandidate({
      proposedAction: { kind: 'read_only_inspection', title: 'Inspect local source' },
    }), COMMON_SCOPE);

    expect(decision).toEqual(expect.objectContaining({
      proposedAction: expect.any(Object),
      riskClass: 'safe',
      allowedNextStep: expect.any(Object),
      deniedCapabilities: expect.any(Array),
      requiredProofs: expect.any(Array),
      evidenceRefs: expect.any(Array),
      metadataScope: expect.any(Object),
      jamesCheckpoint: null,
      audit: expect.objectContaining({
        salienceDoesNotGrant: true,
        policyStatic: true,
        sideEffectsPermitted: false,
      }),
    }));
  });

  test('replays March initiative and truncation signals through observed WorkItems, salience, and dispatcher', () => {
    jest.resetModules();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-dispatcher-replay-'));
    const workItemRoot = path.join(tempRoot, 'runtime', 'work-items');
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      WORKSPACE_PATH: path.join(tempRoot, '.squidrun'),
      PROJECT_ROOT: tempRoot,
      getActiveProfile: () => 'main',
      getProjectRoot: () => tempRoot,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        '.squidrun',
        String(relPath || '')
          .replace(/^[/\\]+/, '')
          .replace(/[/\\]+/g, path.sep),
      ),
    }));

    try {
      const adapter = require('../modules/main/observed-signal-work-items');
      const first = adapter.openWorkItemFromObservedSignal({
        type: 'initiative_proposed',
        initiativeId: 'initiative-1774310103-430c6d',
        title: 'Agency Layer: Wire initiative surfacing into session-start hook',
        createdAt: '2026-03-23T23:55:03.043Z',
      }, {
        workItemRoot,
        sessionId: 'app-session-463',
        profileName: 'main',
        windowKey: 'main',
        projectName: 'squidrun',
        projectPath: tempRoot,
        now: '2026-07-01T20:15:00.000Z',
      });
      const second = adapter.openWorkItemFromObservedSignal({
        type: 'full_message_materialization',
        title: 'body-before-recall full-message materialization failure class',
        sourceFile: '.squidrun/coord/full-agent-messages/hm-long-inbound.txt',
        sourceMessageId: 'hm-long-inbound',
        commit: '3a06520a',
      }, {
        workItemRoot,
        sessionId: 'app-session-463',
        profileName: 'main',
        windowKey: 'main',
        projectName: 'squidrun',
        projectPath: tempRoot,
        now: '2026-07-01T20:16:00.000Z',
      });

      const salience = pickTopSalience({
        candidates: [
          candidateFromWorkItem(first.item),
          candidateFromWorkItem(second.item),
        ],
      });
      const dispatched = dispatchSalienceOutput(salience, {
        ...COMMON_SCOPE,
        contextForDecision: (decision) => {
          const item = [first.item, second.item].find((candidate) => `work_item:${candidate.id}` === decision.key);
          return {
            proposedAction: {
              kind: 'local_source_edit',
              title: item.suggestedNextCommand,
            },
            activeWorkItem: item,
            pathScope: [
              'ui/modules/main/observed-signal-work-items.js',
              'ui/__tests__/observed-signal-work-items.test.js',
            ],
            focusedTests: ['observed-signal-work-items.test.js'],
          };
        },
      });

      expect(dispatched.decisions).toHaveLength(2);
      expect(dispatched.decisions.map((decision) => decision.bucket)).toEqual([
        BUCKETS.cautionGated,
        BUCKETS.cautionGated,
      ]);
      for (const decision of dispatched.decisions) {
        expect(decision.requiredProofs).toEqual(['builder_code', 'oracle_verify']);
        expect(decision.allowedNextStep.grantsPermission).toBe(true);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      jest.dontMock('../config');
    }
  });

  test('dispatcher module has no direct side-effect seams', () => {
    const modulePath = path.join(__dirname, '..', 'modules', 'main', 'squidrun-authority-dispatcher.js');
    const source = fs.readFileSync(modulePath, 'utf8');
    expect(source).not.toMatch(/require\(['"]fs['"]\)/);
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bspawn\b/);
    expect(source).not.toMatch(/\bexec(File|Sync)?\b/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/writeFile|appendFile|renameSync|rmSync/);
  });
});
