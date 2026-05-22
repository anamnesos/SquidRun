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

  function createTempSquidRunProject() {
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
const rows = [
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779443999000,
    rawBody: '(ARCHITECT #60): Committed this context slice as \`abc1234 Follow-up continuation context checkpoint\`. Proof PASS; working tree clean; pre-commit all checks passed. JAMES ACTION: NONE.'
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
process.stdout.write(JSON.stringify({ ok: true, rows }));
`);
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'mira-test@example.invalid'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Mira Test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'fixture clean state'], { cwd: root, stdio: 'ignore' });
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
        supersededBySourceRef: 'architect#48',
        supersededByCommit: '7ff9fe8d Add Mira internal pane activation attempt seam',
      }),
    }));
    expect(context.missionControl.continuationDecision).toEqual(expect.objectContaining({
      status: 'stale_handoff_superseded',
      preferredSourceRef: 'architect#48',
      committedSeam: '7ff9fe8d Add Mira internal pane activation attempt seam',
      staleSourceRef: 'architect#11',
    }));
    expect(context.recentComms.latestCommitCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#46',
      commitHash: '7ff9fe8d',
    }));
    expect(answer).toContain('Project/lane: squidrun / architect#48.');
    expect(answer).toContain('continuation-aware Mission Control command context');
    expect(answer).toContain('Committed seam: 7ff9fe8d Add Mira internal pane activation attempt seam');
    expect(answer).toContain('Builder ACK builder#14');
    expect(answer).toContain('Stale handoff: architect#11');
    expect(answer).toContain('stale/superseded evidence only; it has no active authority');
    expect(answer).not.toContain('Project/lane: squidrun / architect#11. finish the existing 3-file review/no-send gate dirty slice');
    expect(context.summary.happening).toContain('continuation-aware Mission Control command context');
    expect(context.summary.happening).not.toContain('finish the existing 3-file review/no-send gate dirty slice');
    expect(answer.match(/^JAMES ACTION:/gm)).toHaveLength(1);
    expect(context.summary.jamesAction).toBe('NONE');
  });
});
