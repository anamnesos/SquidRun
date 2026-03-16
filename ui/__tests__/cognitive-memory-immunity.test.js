const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  IMMUNE_PROMOTION_CONFIDENCE,
  buildFailureDrivenAntibodies,
  buildImmediateTaskCandidate,
  stageImmediateTaskExtraction,
} = require('../modules/cognitive-memory-immunity');
const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');

describe('cognitive-memory immunity', () => {
  let tempDir;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-immunity-'));
    store = new CognitiveMemoryStore({
      workspaceDir: path.join(tempDir, 'workspace'),
      dbPath: path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db'),
      pendingPrPath: path.join(tempDir, '.squidrun', 'memory', 'pending-pr.json'),
    });
  });

  afterEach(() => {
    try { store?.close(); } catch {}
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('buildImmediateTaskCandidate extracts reusable post-task knowledge', () => {
    const candidate = buildImmediateTaskCandidate({
      status: 'completed',
      task: {
        id: 'T-7',
        subject: 'Fix delivery verification',
        description: 'Route hidden-pane ACKs through the daemon bridge',
        metadata: {
          domain: 'builder',
        },
      },
      metadata: {
        summary: 'Hidden pane ACK routing held once the daemon bridge stayed authoritative.',
        files: ['ui/modules/daemon-handlers.js'],
      },
    });

    expect(candidate).toEqual(expect.objectContaining({
      category: 'workflow',
      domain: 'builder',
      proposed_by: 'task-immunity',
      confidence_score: 0.72,
      source_payload: expect.objectContaining({
        type: 'POST_TASK_EXTRACTION',
        status: 'completed',
        taskId: 'T-7',
      }),
    }));
    expect(candidate.statement).toContain('What worked for "Fix delivery verification"');
    expect(candidate.statement).toContain('ui/modules/daemon-handlers.js');
  });

  test('stageImmediateTaskExtraction writes pending PRs for completed tasks', async () => {
    const result = await stageImmediateTaskExtraction({
      status: 'completed',
      task: {
        id: 'T-11',
        subject: 'Protect immune nodes',
        description: 'Preserve immunity during duplicate repair',
      },
      metadata: {
        files: ['ui/modules/memory-consistency-check.js'],
      },
    }, { store });

    expect(result.ok).toBe(true);
    expect(result.staged).toHaveLength(1);
    expect(store.listPendingPRs({ limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pr_id: result.staged[0],
        category: 'workflow',
      }),
    ]));
  });

  test('buildFailureDrivenAntibodies matches failed and successful trajectories by objective and files', () => {
    const candidates = buildFailureDrivenAntibodies([
      {
        taskId: 'task-fail',
        objective: 'Fix relay truncation',
        objectiveKey: 'fix relay truncation',
        status: 'failed',
        files: ['ui/modules/terminal/injection.js'],
        metadata: { domain: 'builder' },
        errorMessage: 'submit verification timed out',
        completedAtMs: 100,
        session: 227,
      },
      {
        taskId: 'task-ok',
        objective: 'Fix relay truncation',
        objectiveKey: 'fix relay truncation',
        status: 'complete',
        files: ['ui/modules/terminal/injection.js'],
        metadata: { domain: 'builder' },
        summary: 'chunk the payload before PTY submission and pace the final Enter dispatch',
        completedAtMs: 200,
        session: 229,
      },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(expect.objectContaining({
      confidence_score: IMMUNE_PROMOTION_CONFIDENCE,
      proposed_by: 'sleep-antibody',
      source_payload: expect.objectContaining({
        type: 'FAILURE_DRIVEN_ANTIBODY',
        failedTaskId: 'task-fail',
        successTaskId: 'task-ok',
      }),
    }));
    expect(candidates[0].statement).toContain('submit verification timed out');
    expect(candidates[0].statement).toContain('chunk the payload before PTY submission');
  });
});
