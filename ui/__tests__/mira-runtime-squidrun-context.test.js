'use strict';

/* global afterAll, beforeAll, describe, expect, test */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

describe('Mira SquidRun command context', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
  const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
  const compiledContextPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'squidrun-context.js');
  const tempRoots = [];

  beforeAll(() => {
    execFileSync(process.execPath, [
      tscBin,
      '-p',
      runtimeTsconfig,
    ], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });

  afterAll(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  function writeFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, 'utf8');
  }

  function createTempSquidRunProject(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-squidrun-context-'));
    tempRoots.push(root);
    writeJson(path.join(root, '.squidrun', 'link.json'), {
      workspace: path.join(root, 'squidrun'),
      squidrun_root: root,
      session_id: 'app-session-378',
    });
    writeJson(path.join(root, '.squidrun', 'handoffs', 'current-lane.json'), {
      version: 1,
      generatedAt: '2026-05-22T09:51:49.610Z',
      sessionId: 'app-session-378',
      source: 'comms_journal',
      status: 'active',
      activeLane: {
        laneId: 'app-session-378:architect-11:hm-1779441027063-df1hg8',
        objective: 'finish the existing 3-file review/no-send gate dirty slice without broadening it:',
        kind: 'objective',
        priority: 70,
        status: 'active',
        sourceMessageId: 'hm-1779441027063-df1hg8',
        sourceRef: 'architect#11',
        sourceTimestampMs: 1779441027075,
        senderRole: 'architect',
        targetRole: 'builder',
      },
      continuity: {
        next_action: 'Continue active lane: finish the existing 3-file review/no-send gate dirty slice without broadening it:',
      },
    });
    writeJson(path.join(root, '.squidrun', 'runtime', 'agent-task-queue.json'), {
      agents: {},
    });
    writeFile(path.join(root, 'docs', 'mira-system-map.md'), [
      'Current New Mira is not holy-shit amazing yet.',
      'The current next slices are:',
      '- Mission Control v0: answer from local evidence.',
    ].join('\n'));
    writeFile(path.join(root, 'docs', 'mira-north-star-roadmap.md'), [
      'Current New Mira is not holy-shit amazing.',
      'Name: Mira Mission Control v0.',
      'Stop or pivot if Mission Control cannot answer from local evidence.',
    ].join('\n'));
    writeFile(path.join(root, 'ui', 'scripts', 'hm-comms.js'), `#!/usr/bin/env node
const staleCheckpointSpacerRows = Array.from({ length: 90 }, (_, index) => ({
  sender: 'architect',
  target: 'builder',
  timestampMs: 1779443380000 + index,
  rawBody: \`(ARCHITECT #\${1000 + index}): Status check: unrelated checkpoint chatter \${index}; proof PASS; JAMES ACTION: NONE.\`
}));
const rows = [
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779445700000,
    rawBody: '(ARCHITECT #87): Current-session delegation: next Mira map-backed slice is Mission Control v1 dry-run coordination plan alignment. Clean context after 1b6b841c advances summary.nextStep to Mission Control v1 dry-run coordination/follow-through route planning. Build the smallest no-side-effect slice so coordination drafts/preview align with v1. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779445600000,
    rawBody: '(ARCHITECT #79): Checkpoint: unrelated Mission Control context slice committed as abc1234 Advance later context. It references prior 6092a28a Harden Mission Control delegation selection selector proof; proof PASS; JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779445511259,
    rawBody: '(ARCHITECT #75): Current-session delegation: next Mira map-backed slice is a tiny post-commit next-move advancement in Mission Control command context. Evidence after 6092a28a: clean getSquidRunContext() no longer revives the old review/no-send objective, but summary.nextStep still says Builder should finish the continuation-aware command-context proof. Fix the context answer so after the committed continuation-selector proof is present, Mission Control advances to the next map-backed product step: Mission Control v1 dry-run coordination/follow-through route planning, no sends/execution. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779445450000,
    rawBody: '(ARCHITECT #73): Checkpoint: continuation selector follow-up committed as 6092a28a Harden Mission Control delegation selection. Committed scope: docs/mira-system-map.md, mira/runtime/src/squidrun-context.ts, ui/__tests__/mira-runtime-squidrun-context.test.js. Pre-commit passed all gates. Post-commit proof from clean HEAD: worktree clean, active source is a real instruction row rather than checkpoint/proof rows, summary.happening does not contain the old objective, and answer has exactly one JAMES ACTION line. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779444600000,
    rawBody: '(ARCHITECT #61): MODIFY / new tiny follow-up slice, caused by post-commit live evidence. Fix the continuation-aware Mission Control command context selector, not the handoff state: latestContinuationDelegation should select real delegation/request/task messages and exclude commit/checkpoint/PASS/proof/review/status reports like Architect #59/#60.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779444100000,
    rawBody: '(ARCHITECT #59): Committed the continuation-aware Mission Control context slice as \`361acec4 Add continuation-aware Mission Control context\`. Post-commit proof says summary.happening is continuation-aware Mission Control command context. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779443999000,
    rawBody: '(ARCHITECT #60): Committed this context slice as \`abc1234 Follow-up continuation context checkpoint\`. Post-commit proof says the visible answer is continuation-aware Mission Control command context. Proof PASS; working tree clean; pre-commit all checks passed. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779443470324,
    rawBody: '(ARCHITECT #48): Current-session delegation: next Mira map-backed slice is continuation-aware Mission Control command context, not a send/live/direct-channel/trading lane. Evidence from committed HEAD: \`getSquidRunContext()\` summary still says active lane is stale \`architect#11\` "finish the existing 3-file review/no-send gate dirty slice" even though latest comms include \`architect#46\` commit checkpoint for \`7ff9fe8d\` and working tree is clean. Build the smallest no-side-effect slice. JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779443341518,
    rawBody: '(BUILDER #14): ACK on \`7ff9fe8d Add Mira internal pane activation attempt seam\`. Local check matches: HEAD is 7ff9fe8d and working tree is clean. Standing by for the next map-backed Mira delegation; JAMES ACTION: NONE.'
  },
  ...staleCheckpointSpacerRows,
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779443328581,
    rawBody: '(ARCHITECT #46): Committed the internal-pane activation attempt seam as \`7ff9fe8d Add Mira internal pane activation attempt seam\`. Committed-HEAD proof: internal-pane activation PASS 7/7; bridge API PASS 43/43; UI read-only boot PASS 67/67; map guard PASS 15/15; runtime TSC PASS; pre-commit all checks passed; working tree clean. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779441027075,
    rawBody: '(ARCHITECT #11): TASK Current-session Mira lane. Objective: finish the existing 3-file review/no-send gate dirty slice without broadening it. JAMES ACTION: NONE'
  }
];
const lastIndex = process.argv.indexOf('--last');
const last = lastIndex >= 0 ? Number(process.argv[lastIndex + 1]) : rows.length;
process.stdout.write(JSON.stringify({ ok: true, rows: rows.slice(0, last) }));
`);
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'mira-test@example.invalid'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Mira Test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'fixture clean state'], { cwd: root, stdio: 'ignore' });
    if (options.dirty) {
      writeFile(path.join(root, 'notes', 'uncommitted-context-work.txt'), 'local continuation work remains open\n');
    }
    return root;
  }

  function readContext(root) {
    const compiledContextUrl = pathToFileURL(compiledContextPath).href;
    const script = `
      import { getSquidRunContext } from ${JSON.stringify(compiledContextUrl)};
      const context = getSquidRunContext({ SQUIDRUN_WORKSPACE: ${JSON.stringify(root)} }, ${JSON.stringify(root)});
      console.log(JSON.stringify(context));
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  }

  test('prefers later PASS/commit/delegation continuation evidence over a stale current-lane handoff', () => {
    const root = createTempSquidRunProject();
    const context = readContext(root);
    const answer = context.missionControl.answer;

    expect(context.git).toEqual(expect.objectContaining({
      loaded: true,
      dirtyCount: 0,
    }));
    expect(context.dirtyWork.summary).toBe('Worktree is clean.');
    expect(context.lane).toEqual(expect.objectContaining({
      sourceRef: 'architect#11',
      staleHandoff: expect.objectContaining({
        status: 'stale_superseded',
        sourceRef: 'architect#11',
        supersededBySourceRef: 'architect#87',
        supersededByCommit: '7ff9fe8d Add Mira internal pane activation attempt seam',
      }),
    }));
    expect(context.missionControl.continuationDecision).toEqual(expect.objectContaining({
      status: 'stale_handoff_superseded',
      preferredSourceRef: 'architect#87',
      committedSeam: '7ff9fe8d Add Mira internal pane activation attempt seam',
      staleSourceRef: 'architect#11',
    }));
    expect(context.recentComms.latestCommitCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#46',
      commitHash: '7ff9fe8d',
    }));
    expect(context.recentComms.latestContinuationDelegation).toEqual(expect.objectContaining({
      sourceRef: 'architect#87',
    }));
    expect(context.recentComms.latestContinuationSelectorCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#73',
      commitHash: '6092a28a',
    }));
    expect(answer).toContain('Project/lane: squidrun / architect#87.');
    expect(answer).toContain('Mission Control v1 dry-run coordination/follow-through route planning is the next map-backed product step');
    expect(answer).not.toContain('Builder should finish the continuation-aware Mission Control command-context proof');
    expect(answer).not.toContain('finish the continuation-aware command-context proof');
    expect(answer).toContain('Committed seam: 7ff9fe8d Add Mira internal pane activation attempt seam');
    expect(answer).toContain('Selector proof: architect#73 6092a28a is committed');
    expect(answer).toContain('Builder ACK builder#14');
    expect(answer).toContain('Stale handoff: architect#11');
    expect(answer).toContain('stale/superseded evidence only; it has no active authority');
    expect(answer).not.toContain('Project/lane: squidrun / architect#11. finish the existing 3-file review/no-send gate dirty slice');
    expect(context.missionControl.nextTeamMove).toBe('Builder should advance Mission Control v1 dry-run coordination/follow-through route planning from local evidence only; Oracle should review that it stays no-send/no-execution before commit.');
    expect(context.summary.nextStep).toBe(context.missionControl.nextTeamMove);
    expect(context.summary.nextStep).not.toContain('finish the continuation-aware Mission Control command-context proof');
    expect(context.missionControl.coordinationDrafts).toEqual([
      {
        target: 'builder',
        purpose: 'v1 dry-run planning',
        message: 'Advance Mission Control v1 dry-run coordination/follow-through route planning from local evidence only; keep it inspectable and no-send/no-execution.',
      },
      {
        target: 'oracle',
        purpose: 'v1 no-send review',
        message: 'Review Mission Control v1 for no-send/no-execution boundaries and useful next-move specificity before commit.',
      },
    ]);
    expect(context.missionControl.internalRoutePreview).toEqual(expect.objectContaining({
      status: 'reviewed_preview_only',
      selectedDraftTarget: 'oracle',
      selectedDraftPurpose: 'v1 no-send review',
      audit: expect.objectContaining({
        sendPerformed: false,
        runtimeExecutes: false,
        externalSend: false,
        routeFlip: false,
        providerInvoked: false,
      }),
    }));
    expect(context.missionControl.internalRoutePreview.plan).toEqual(expect.objectContaining({
      manualExecutionRequired: true,
      runtimeExecutes: false,
      target: expect.objectContaining({
        role: 'oracle',
      }),
      envelope: expect.objectContaining({
        body: {
          content: 'Review Mission Control v1 for no-send/no-execution boundaries and useful next-move specificity before commit.',
        },
      }),
    }));
    expect(context.summary.happening).toContain('continuation-aware Mission Control command context');
    expect(context.summary.happening).not.toContain('finish the existing 3-file review/no-send gate dirty slice');
    expect(answer.match(/^JAMES ACTION:/gm)).toHaveLength(1);
    expect(context.summary.jamesAction).toBe('NONE');
  });

  test('keeps a stale current-lane handoff authoritative while the worktree is dirty', () => {
    const root = createTempSquidRunProject({ dirty: true });
    const context = readContext(root);
    const answer = context.missionControl.answer;

    expect(context.git).toEqual(expect.objectContaining({
      loaded: true,
      dirtyCount: 1,
    }));
    expect(context.dirtyWork.summary).toContain('1 changed file(s)');
    expect(context.recentComms.latestContinuationDelegation).toEqual(expect.objectContaining({
      sourceRef: 'architect#87',
    }));
    expect(context.recentComms.latestContinuationSelectorCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#73',
    }));
    expect(context.missionControl.continuationDecision).toEqual(expect.objectContaining({
      status: 'current_handoff',
      preferredSourceRef: 'architect#87',
      staleSourceRef: null,
    }));
    expect(context.lane.staleHandoff).toBeNull();
    expect(context.summary.happening).toContain('finish the existing 3-file review/no-send gate dirty slice');
    expect(answer).toContain('Dirty work: 1 changed file(s)');
    expect(answer).not.toContain('Stale handoff: architect#11');
    expect(answer.match(/^JAMES ACTION:/gm)).toHaveLength(1);
  });
});
