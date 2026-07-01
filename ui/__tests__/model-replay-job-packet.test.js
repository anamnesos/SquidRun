const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const {
  DEFAULT_PATHS,
  MODEL_REPLAY_JOB_PACKET_SCHEMA,
  PHASE4_PROTECTED_CASES,
  UNIVERSAL_TASK_IDS,
  buildReplayJobPacket,
} = require('../modules/main/model-replay-job-packet');

function makeBasePacket() {
  return {
    packetVersion: '2026-06-28.universal-seat-change-gate',
    tasks: UNIVERSAL_TASK_IDS.map((id) => ({
      id,
      category: id.startsWith('impl-') ? 'implementation' : (id.startsWith('verify-') ? 'verification' : 'coordination'),
      prompt: `Prompt for ${id}`,
      requiredEvidence: [`evidence:${id}`],
      hiddenInvariantExamples: [`hidden invariant for ${id}`],
    })),
  };
}

function makeExecutionPacket(overrides = {}) {
  return {
    packetVersion: '2026-07-01.fable-return-seat-change-execution',
    inherits: {
      runbook: DEFAULT_PATHS.baseRunbook,
      packet: DEFAULT_PATHS.basePacket,
      scorer: DEFAULT_PATHS.baseScorer,
    },
    candidateOrder: [
      {
        candidate: 'Fable',
        seat: 'builder',
        modelStringExpected: 'claude-fable-5',
        priority: 1,
      },
    ],
    seatChangeAuthorization: {
      scorerPassRequired: true,
      oracleVerifyRequired: true,
      architectSynthesisRequired: true,
      jamesCheckpointRequired: true,
      liveSettingsChangeAllowedByThisPacket: false,
    },
    ...overrides,
  };
}

function makeResultTemplate(overrides = {}) {
  return {
    candidate: {
      name: 'Fable-as-Builder',
      seat: 'builder',
      model: '',
      runAt: '',
      evaluator: 'oracle',
      ...(overrides.candidate || {}),
    },
    availability: {
      proven: false,
      modelString: '',
      noFallbackEvidence: '',
      commands: [],
      notes: '',
      ...(overrides.availability || {}),
    },
    incumbent: {
      name: 'Builder incumbent',
      model: 'Codex GPT-5.5',
      resultFile: DEFAULT_PATHS.incumbentBuilderResult,
    },
    tasks: UNIVERSAL_TASK_IDS.map((id) => ({
      id,
      outcome: 'accepted-hold',
      scores: {
        correctness: 0,
        evidence: 0,
        routing: 0,
        verification: 0,
        scope: 0,
      },
      evidence: [],
      violations: [],
      notes: `Fill ${id} after evidence is checked.`,
    })),
    summary: {
      recommendedSeatChange: false,
      evaluatorNotes: 'Template only.',
      ...(overrides.summary || {}),
    },
  };
}

function makePacket(overrides = {}) {
  return buildReplayJobPacket({
    basePacket: makeBasePacket(),
    fableExecutionPacket: makeExecutionPacket(overrides.execution || {}),
    resultTemplate: makeResultTemplate(overrides.template || {}),
    artifactRefs: [
      { kind: 'baseScorer', path: DEFAULT_PATHS.baseScorer, exists: true, sha256: 'scorer-hash' },
      { kind: 'fableRunbook', path: DEFAULT_PATHS.fableRunbook, exists: true, sha256: 'runbook-hash' },
    ],
    createdAt: '2026-07-01',
    ...(overrides.packet || {}),
  });
}

describe('model replay job packet', () => {
  test('builds a deterministic ready_to_run packet without model success or seat authority claims', () => {
    const first = makePacket();
    const second = makePacket();

    expect(first.schema).toBe(MODEL_REPLAY_JOB_PACKET_SCHEMA);
    expect(first.status).toBe('ready_to_run');
    expect(first.packetHash).toBe(second.packetHash);
    expect(first.candidate).toEqual(expect.objectContaining({
      name: 'Fable-as-Builder',
      candidate: 'Fable',
      seat: 'builder',
      expectedModelString: 'claude-fable-5',
      evaluator: 'oracle',
    }));
    expect(first.readiness).toEqual(expect.objectContaining({
      readyToRun: true,
      fableAvailabilityProven: false,
      noFallbackProven: false,
      modelSuccessProven: false,
      seatChangeEligible: false,
      seatChangeAuthorized: false,
      phase3AuthorityGranted: false,
      liveSettingsMutationAllowed: false,
      externalSendsAllowed: false,
    }));
    expect(first.resultContract).toEqual(expect.objectContaining({
      evaluatorAuthoredResultRequired: true,
      candidateSelfAttestationAllowed: false,
      blankTemplateExpectedToFailClosed: true,
      scorerPassIsNotSeatAuthority: true,
      jamesCheckpointRequiredBeforeSeatMutation: true,
    }));
  });

  test('preserves universal tasks, evidence refs, and required replay fixture coverage', () => {
    const packet = makePacket();
    expect(packet.taskReplays.map((task) => task.id)).toEqual(UNIVERSAL_TASK_IDS);
    expect(packet.taskReplays.every((task) => task.replayEvidenceRefs.length > 0)).toBe(true);
    expect(packet.taskReplays.every((task) => task.evaluatorMustFill === true)).toBe(true);

    expect(packet.replayFixtureCoverage).toEqual(expect.objectContaining({
      marchStaleInitiative: true,
      fullMessageMaterialization: true,
      routeProofVsTransportAck: true,
      wrongContextMetadata: true,
      restartCompactionRecovery: true,
    }));
    for (const caseId of PHASE4_PROTECTED_CASES) {
      expect(packet.replayFixtureCoverage.phase4ProtectedCases[caseId]).toBe(true);
      expect(packet.replayFixtures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: caseId,
          protectedEvalCase: caseId,
          evidenceRefs: expect.any(Array),
        }),
      ]));
    }
  });

  test('fails closed if prep artifacts imply availability, no-fallback proof, or seat recommendation', () => {
    const packet = makePacket({
      template: {
        candidate: { model: 'claude-fable-5' },
        availability: {
          proven: true,
          modelString: 'claude-fable-5',
          noFallbackEvidence: 'trust me',
        },
        summary: { recommendedSeatChange: true },
      },
    });

    expect(packet.status).toBe('blocked');
    expect(packet.readiness.readyToRun).toBe(false);
    expect(packet.readinessBlockers).toEqual(expect.arrayContaining([
      'availability_must_remain_unproven_in_ready_packet',
      'availability_model_string_must_wait_for_live_run',
      'no_fallback_evidence_must_wait_for_live_run',
      'candidate_model_must_wait_for_live_run',
      'template_must_not_recommend_seat_change',
    ]));
  });

  test('keeps the replay harness model-agnostic for another builder challenger', () => {
    const packet = buildReplayJobPacket({
      basePacket: makeBasePacket(),
      fableExecutionPacket: makeExecutionPacket({
        candidateOrder: [{
          candidate: 'Sol',
          seat: 'builder',
          modelStringExpected: 'claude-sol-5',
          priority: 1,
        }],
      }),
      resultTemplate: makeResultTemplate({
        candidate: {
          name: 'Sol-as-Builder',
          seat: 'builder',
        },
      }),
      createdAt: '2026-07-01',
    });

    expect(packet.status).toBe('ready_to_run');
    expect(packet.candidate).toEqual(expect.objectContaining({
      name: 'Sol-as-Builder',
      candidate: 'Sol',
      seat: 'builder',
      expectedModelString: 'claude-sol-5',
    }));
  });

  test('CLI writes a command-ready packet from local bakeoff files', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-model-replay-'));
    const coordRoot = path.join(tempRoot, '.squidrun', 'coord');
    fs.mkdirSync(coordRoot, { recursive: true });
    try {
      fs.writeFileSync(path.join(tempRoot, DEFAULT_PATHS.basePacket), `${JSON.stringify(makeBasePacket())}\n`);
      fs.writeFileSync(path.join(tempRoot, DEFAULT_PATHS.fableExecutionPacket), `${JSON.stringify(makeExecutionPacket())}\n`);
      fs.writeFileSync(path.join(tempRoot, DEFAULT_PATHS.fableBuilderTemplate), `${JSON.stringify(makeResultTemplate())}\n`);
      fs.writeFileSync(path.join(tempRoot, DEFAULT_PATHS.baseRunbook), '# base runbook\n');
      fs.writeFileSync(path.join(tempRoot, DEFAULT_PATHS.fableRunbook), '# fable runbook\n');
      fs.writeFileSync(path.join(tempRoot, DEFAULT_PATHS.baseScorer), '# scorer\n');

      const outputRelative = '.squidrun/coord/phase5-job-packet.json';
      const raw = childProcess.execFileSync(process.execPath, [
        path.join(__dirname, '..', 'scripts', 'hm-model-replay-job-packet.js'),
        '--project-root',
        tempRoot,
        '--created-at',
        '2026-07-01',
        '--output',
        outputRelative,
      ], { encoding: 'utf8' });
      const result = JSON.parse(raw);
      const outputPath = path.join(tempRoot, outputRelative);
      const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

      expect(result.ok).toBe(true);
      expect(result.status).toBe('ready_to_run');
      expect(result.outputPath).toBe(outputPath);
      expect(written.packetHash).toBe(result.packetHash);
      expect(written.commands.scoreCandidate).toContain(DEFAULT_PATHS.baseScorer);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
