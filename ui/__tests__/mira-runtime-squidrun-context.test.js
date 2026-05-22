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
const staleCheckpointSpacerRows = Array.from({ length: 240 }, (_, index) => ({
  sender: 'architect',
  target: 'builder',
  timestampMs: 1779443380000 + index,
  rawBody: \`(ARCHITECT #\${1000 + index}): Status check: unrelated checkpoint chatter \${index}; proof PASS; JAMES ACTION: NONE.\`
}));
const rows = [
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779449400000,
    rawBody: '(ARCHITECT #167): Checkpoint: Mission Control demo/workbench boundary advancement committed as 208d7ad7 Advance Mission Control demo workbench boundary. Oracle #52 PASS accepted; pre-commit checks passed. Clean-head proof: worktree clean, context test PASS 2/2, runtime TypeScript noEmit PASS. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779449380000,
    rawBody: '(ARCHITECT #169): Current-session delegation: post-208d7ad7 clean-context regression. Clean HEAD is 208d7ad7 and the demo/workbench boundary is committed, but live getSquidRunContext() now regresses. Fix the smallest read-only/no-side-effect slice: reject checkpoint/PASS/proof/status/report-shaped rows from latestBuilderInstruction and delegation authority, preserve prior 7ff9fe8d seam evidence despite the old 200-row read miss, accept Oracle #50 continuity/memory first-proof ACK wording, and keep demo/workbench planning. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779449300000,
    rawBody: '(ARCHITECT #158): Current-session delegation: post-d0bffd58 next-move advancement. Clean Mission Control should no longer ask Builder to plan the continuity/memory proof now that d0bffd58 Add Mission Control continuity memory proof is committed and ACKed by Builder #56 / Oracle #50. Build the smallest read-only/no-side-effect slice so Mission Control keeps missionControl.continuityMemoryProof as completed proof-only context and advances to first inspectable Mission Control demo/workbench proof planning. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779449250000,
    rawBody: '(ARCHITECT #157): Checkpoint: unrelated Mission Control note committed as cafe999 Later note. It mentions prior d0bffd58 Add Mission Control continuity memory proof; proof PASS; JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779449220000,
    rawBody: '(BUILDER #58): ACK checkpoint cafe999 Later note while referencing prior d0bffd58 Add Mission Control continuity memory proof. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779449210000,
    rawBody: '(ORACLE #51): Received cafe999 checkpoint while referencing prior d0bffd58 Add Mission Control continuity memory proof. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779449180000,
    rawBody: '(ARCHITECT #156): Checkpoint: Mission Control continuity/memory first proof committed as d0bffd58 Add Mission Control continuity memory proof. Oracle #48/#49 PASS accepted; pre-commit checks passed. Clean-head proof: worktree clean, context test PASS 2/2, runtime TypeScript noEmit PASS. JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779449170000,
    rawBody: '(BUILDER #56): ACK checkpoint d0bffd58 Add Mission Control continuity memory proof. Clean-head proof noted: missionControl.continuityMemoryProof has typed restart/current-lane/status provenance, stale-only architect#11 refusal, James continuity-promotion control point, and false live-effect flags. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779449160000,
    rawBody: '(ORACLE #50): Received d0bffd58 checkpoint. Oracle records Mission Control continuity/memory first proof as committed clean-head context shaping, with continuityMemoryProof provenance and no-live-effect flags accepted for this completed proof. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779449000000,
    rawBody: '(ARCHITECT #141): Current-session delegation: Mission Control continuity/memory first proof, next Mira map-backed slice. Build the smallest dry-run/no-side-effect proof that New Mira command context can load sourced restart/current-lane truth and reject stale-only summaries. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779448950000,
    rawBody: '(ARCHITECT #140): Checkpoint: unrelated Mission Control note committed as cafe123 Later note. It mentions prior bf82cea4 Advance Mission Control continuity memory boundary; proof PASS; JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779448920000,
    rawBody: '(BUILDER #54): ACK checkpoint cafe123 Later note while referencing prior bf82cea4 Advance Mission Control continuity memory boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779448880000,
    rawBody: '(ARCHITECT #139): Checkpoint: post-5b3e0386 continuity/memory next-move advancement committed as bf82cea4 Advance Mission Control continuity memory boundary. Oracle #43 PASS accepted; pre-commit gates passed. Clean-head proof: worktree clean, context test PASS 2/2, runtime TypeScript noEmit PASS. JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779448870000,
    rawBody: '(BUILDER #52): ACK checkpoint bf82cea4 Advance Mission Control continuity memory boundary. Clean-head proof noted: nextStep/drafts/preview advance to continuity/memory sourced restart/current-lane planning, and dirty fixture blocks advancement. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779448600000,
    rawBody: '(ARCHITECT #131): Current-session delegation: post-5b3e0386 next-move advancement. Clean Mission Control should treat the completed tool/app action plan as context and advance to the next roadmap/map boundary: continuity and memory, specifically New Mira command context loading sourced restart/current-lane truth and rejecting stale-only summaries. No live memory import, blind .squidrun copy, writes/state import, restart/process start, browsing, sends, routes, POST, UI/status execution, runtime start, provider/model call, credential access, deploy, or money. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779448550000,
    rawBody: '(ARCHITECT #130): Checkpoint: unrelated Mission Control note committed as deadbee Later note. It mentions prior 5b3e0386 Add Mission Control tool app action plan proof; proof PASS; JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779448520000,
    rawBody: '(BUILDER #50): ACK checkpoint deadbee Later note while referencing prior 5b3e0386 Add Mission Control tool app action plan proof. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779448480000,
    rawBody: '(ARCHITECT #129): Checkpoint: Mission Control tool/app action-plan first proof committed as 5b3e0386 Add Mission Control tool app action plan proof. Oracle #40 PASS accepted; pre-commit gates passed. Clean-head proof: worktree clean, context test PASS 2/2, runtime TypeScript noEmit PASS, planningOnly true, executed false. JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779448470000,
    rawBody: '(BUILDER #49): ACK checkpoint 5b3e0386 Add Mission Control tool app action plan proof. Clean-head proof noted: missionControl.toolAppActionPlan is planning-only, source-evidenced, Builder-owned, James-gated, dirty-fixture-blocked, and no execution/live-effect flags remain false. Standing by for the next map-backed Mira boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779448200000,
    rawBody: '(ARCHITECT #116): Current-session delegation: post-22e876dc next-move advancement. Clean Mission Control should advance to tool/app action planning from real local evidence only, with owner Builder and a James-control point before any execution. This is local planning only; no browsing, sends, routes, POST, UI/status execution, runtime start, Telegram setup/send, provider/model call, account/token/credential access, device/user/external target, deploy, money, or trading. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779448150000,
    rawBody: '(ARCHITECT #115): Checkpoint: unrelated Mission Control planning note committed as abcdef1 Later note. It mentions prior 22e876dc Align Mission Control direct-channel readiness contract; proof PASS; JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779448120000,
    rawBody: '(BUILDER #44): ACK checkpoint abcdef1 Later note while referencing prior 22e876dc Align Mission Control direct-channel readiness contract. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779448080000,
    rawBody: '(ARCHITECT #114): Checkpoint: direct-channel readiness contract alignment committed as 22e876dc Align Mission Control direct-channel readiness contract. Oracle #34 PASS accepted; pre-commit gates passed. Clean-head proof: worktree clean, context test PASS 2/2, readiness contract test PASS 10/10, currentOwner squidrun-telegram-guard-stack, proposedFutureOwner new-mira-direct-channel, candidate_ready dry-run only with sendReady=false and liveActivationReady=false. JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779448070000,
    rawBody: '(BUILDER #43): ACK checkpoint 22e876dc Align Mission Control direct-channel readiness contract. Clean-head proof noted: currentOwner squidrun-telegram-guard-stack, proposedFutureOwner new-mira-direct-channel, candidate_ready remains dry-run only with sendReady=false/liveActivationReady=false. Standing by for the next map-backed Mira boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779447040000,
    rawBody: '(ARCHITECT #103): Checkpoint: unrelated Mira context cleanup committed as abc5678 Later checkpoint. It references prior e82f1a54 Align Mission Control v1 route preview drafts and prior 4bfe771c Harden Mission Control comms evidence window; proof PASS; JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779446945234,
    rawBody: '(ARCHITECT #99): Current-session delegation: next Mira map-backed slice is post-v1 next-boundary advancement in Mission Control command context. Clean HEAD after e82f1a54 Align Mission Control v1 route preview drafts and 4bfe771c Harden Mission Control comms evidence window still says summary.nextStep is "Builder should advance Mission Control v1 dry-run coordination/follow-through route planning," but that v1 planning/alignment is now committed and stabilized. Build the smallest read-only/no-side-effect slice so clean Mission Control advances past completed v1 planning to separate New Mira direct-channel readiness/dry-run planning only, behind the existing guard truth, with no setup/send/route-owner flip. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779446851000,
    rawBody: '(ARCHITECT #98): Checkpoint: continuation evidence-window hardening committed as 4bfe771c Harden Mission Control comms evidence window. Oracle PASS accepted; prior seam evidence is retained after checkpoint chatter; clean-head proof held. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779446850000,
    rawBody: '(ARCHITECT #97): Checkpoint: continuation evidence-window hardening committed as 4bfe771c Harden Mission Control comms evidence window. Clean-head proof: worktree clean, context test PASS 2/2, getSquidRunContext() now reports stale_handoff_superseded, latestCommitCheckpoint=architect#46/7ff9fe8d, latestContinuationDelegation=architect#87, v1 nextStep/drafts/preview retained, and exactly one JAMES ACTION line. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779446128000,
    rawBody: '(ARCHITECT #92): Checkpoint: Mission Control v1 draft/preview alignment committed as e82f1a54 Align Mission Control v1 route preview drafts. Oracle PASS accepted; draft/preview alignment proof held clean. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779446127000,
    rawBody: '(ARCHITECT #91): Checkpoint: Mission Control v1 draft/preview alignment committed as e82f1a54 Align Mission Control v1 route preview drafts. Clean-head proof: worktree clean; summary.nextStep is v1 dry-run coordination/follow-through planning; coordinationDrafts use Builder purpose v1 dry-run planning and Oracle purpose v1 no-send review; internalRoutePreview selects Oracle with reviewed_preview_only and manualExecutionRequired true. JAMES ACTION: NONE.'
  },
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
        supersededBySourceRef: 'architect#169',
        supersededByCommit: '7ff9fe8d Add Mira internal pane activation attempt seam',
      }),
    }));
    expect(context.missionControl.continuationDecision).toEqual(expect.objectContaining({
      status: 'stale_handoff_superseded',
      preferredSourceRef: 'architect#169',
      committedSeam: '7ff9fe8d Add Mira internal pane activation attempt seam',
      staleSourceRef: 'architect#11',
    }));
    expect(context.recentComms.latestCommitCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#46',
      commitHash: '7ff9fe8d',
    }));
    expect(context.recentComms.latestBuilderAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#14',
      commitHash: '7ff9fe8d',
    }));
    expect(context.recentComms.latestBuilderInstruction).toEqual(expect.objectContaining({
      sourceRef: 'architect#169',
    }));
    expect(context.recentComms.latestContinuationDelegation).toEqual(expect.objectContaining({
      sourceRef: 'architect#169',
    }));
    expect(context.recentComms.latestContinuationSelectorCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#73',
      commitHash: '6092a28a',
    }));
    expect(context.recentComms.latestV1AlignmentDelegation).toEqual(expect.objectContaining({
      sourceRef: 'architect#87',
    }));
    expect(context.recentComms.latestV1AlignmentCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#92',
      commitHash: 'e82f1a54',
    }));
    expect(context.recentComms.latestEvidenceWindowCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#98',
      commitHash: '4bfe771c',
    }));
    expect(context.recentComms.latestDirectChannelReadinessCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#114',
      commitHash: '22e876dc',
    }));
    expect(context.recentComms.latestDirectChannelReadinessAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#43',
      commitHash: '22e876dc',
    }));
    expect(context.recentComms.latestToolAppActionPlanCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#129',
      commitHash: '5b3e0386',
    }));
    expect(context.recentComms.latestToolAppActionPlanAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#49',
      commitHash: '5b3e0386',
    }));
    expect(context.recentComms.latestContinuityMemoryBoundaryCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#139',
      commitHash: 'bf82cea4',
    }));
    expect(context.recentComms.latestContinuityMemoryBoundaryAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#52',
      commitHash: 'bf82cea4',
    }));
    expect(context.recentComms.latestContinuityMemoryProofCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#156',
      commitHash: 'd0bffd58',
    }));
    expect(context.recentComms.latestContinuityMemoryProofAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#56',
      commitHash: 'd0bffd58',
    }));
    expect(context.recentComms.latestContinuityMemoryProofOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#50',
      commitHash: 'd0bffd58',
    }));
    expect(answer).toContain('Project/lane: squidrun / architect#169.');
    expect(answer).toContain('First inspectable Mission Control demo/workbench proof planning is the next map boundary');
    expect(answer).toContain('local Mission Control answer/surface for what is happening here and what should happen next from local evidence');
    expect(answer).toContain('Completed direct-channel readiness evidence: checkpoint architect#114 22e876dc and Builder ACK builder#43 22e876dc');
    expect(answer).toContain('next boundary is tool/app action planning from the roadmap, not execution');
    expect(answer).toContain('Completed tool/app action-plan evidence: checkpoint architect#129 5b3e0386 and Builder ACK builder#49 5b3e0386');
    expect(answer).toContain('the tool/app action plan remains completed context');
    expect(answer).toContain('Completed continuity/memory proof evidence: checkpoint architect#156 d0bffd58, Builder ACK builder#56 d0bffd58, and Oracle ACK oracle#50 d0bffd58');
    expect(answer).toContain('continuityMemoryProof remains completed proof-only context while the active next boundary advances to Mission Control demo/workbench proof planning');
    expect(answer).toContain('Continuity/memory proof: mission-control-continuity-memory-proof-v0');
    expect(answer).toContain('current-lane truth architect#11 is loaded_but_stale_superseded');
    expect(answer).toContain('stale-only summary refused=true');
    expect(answer).toContain('audit proofOnly=true, imported=false, copied=false, wrote=false, restarted=false, processStarted=false, browsed=false, sent=false, routed=false, posted=false, runtimeStarted=false, providerInvoked=false, modelInvoked=false, accountAccessed=false, tokenAccessed=false, credentialAccessed=false, deviceTouched=false, userTargeted=false, externalTargeted=false, deployed=false, moneyMovement=false, tradingTouched=false');
    expect(answer).toContain('Completed tool/app action plan context: local_squidrun_evidence_review -> Inspect local SquidRun Mission Control evidence and prepare the first app/tool action candidate for James review.');
    expect(answer).toContain('audit planningOnly=true, executed=false, browsed=false, appToolCalled=false, routed=false, sent=false, runtimeStarted=false, credentialAccessed=false, deployed=false, moneyMovement=false');
    expect(answer).not.toContain('Mission Control v1 dry-run coordination/follow-through route planning is the next map-backed product step');
    expect(answer).not.toContain('Builder should advance Mission Control v1 dry-run coordination/follow-through route planning');
    expect(answer).not.toContain('Advance Mission Control v1 dry-run coordination/follow-through route planning from local evidence only');
    expect(answer).not.toContain('Review Mission Control v1 for no-send/no-execution boundaries');
    expect(answer).not.toContain('Builder should align Mission Control to the existing direct-channel readiness contract');
    expect(answer).not.toContain('Align Mission Control with the existing direct-channel readiness contract');
    expect(answer).not.toContain('Review Mission Control against mira-direct-channel-readiness.test.js');
    expect(answer).not.toContain('Builder should draft one local tool/app action plan');
    expect(answer).not.toContain('Draft one Mission Control tool/app action plan');
    expect(answer).not.toContain('Review that the tool/app action plan names a real local-evidence basis');
    expect(answer).not.toContain('active next boundary is continuity/memory sourced restart/current-lane proof planning');
    expect(answer).not.toContain('Builder should plan the continuity/memory proof for New Mira command context');
    expect(answer).not.toContain('Plan one New Mira command-context continuity/memory proof');
    expect(answer).not.toContain('Review that the continuity/memory plan loads sourced restart/current-lane truth');
    expect(answer).not.toContain('Builder should finish the continuation-aware Mission Control command-context proof');
    expect(answer).not.toContain('finish the continuation-aware command-context proof');
    expect(answer).toContain('Committed seam: 7ff9fe8d Add Mira internal pane activation attempt seam');
    expect(answer).toContain('Builder ACK builder#14');
    expect(answer).toContain('Stale handoff: architect#11');
    expect(answer).toContain('stale/superseded evidence only; it has no active authority');
    expect(answer).not.toContain('Project/lane: squidrun / architect#11. finish the existing 3-file review/no-send gate dirty slice');
    expect(context.missionControl.nextTeamMove).toBe('Builder should plan the first inspectable Mission Control demo/workbench proof from the local answer/surface: show what is happening here and what should happen next from local evidence, keep completed toolAppActionPlan and continuityMemoryProof as context, and do not start runtime, open a browser, write, POST, route, send, or execute.');
    expect(context.summary.nextStep).toBe(context.missionControl.nextTeamMove);
    expect(context.summary.nextStep).not.toContain('advance Mission Control v1 dry-run coordination/follow-through route planning');
    expect(context.summary.nextStep).not.toContain('align Mission Control to the existing direct-channel readiness contract');
    expect(context.summary.nextStep).not.toContain('draft one local tool/app action plan');
    expect(context.summary.nextStep).toContain('demo/workbench proof');
    expect(context.summary.nextStep).toContain('local answer/surface');
    expect(context.summary.nextStep).toContain('what is happening here and what should happen next');
    expect(context.summary.nextStep).not.toContain('sourced restart/current-lane truth');
    expect(context.summary.toolAppActionPlan).toBe('mission-control-tool-app-action-plan-v0: local_squidrun_evidence_review -> Inspect local SquidRun Mission Control evidence and prepare the first app/tool action candidate for James review.; owner Builder; James must explicitly review and approve a separate future request before any real app/tool execution.');
    expect(context.summary.continuityMemoryProof).toBe('mission-control-continuity-memory-proof-v0: current-lane truth architect#11 is loaded_but_stale_superseded; stale-only summary refused=true; James must review and approve a separate future continuity promotion before New Mira imports, copies, writes, restarts, or promotes any memory state.');
    expect(context.missionControl.toolAppActionPlan).toEqual({
      id: 'mission-control-tool-app-action-plan-v0',
      status: 'planning_only',
      owner: 'Builder',
      target: {
        actionCategory: 'local_squidrun_evidence_review',
        action: 'Inspect local SquidRun Mission Control evidence and prepare the first app/tool action candidate for James review.',
      },
      sourceEvidence: [
        {
          kind: 'file',
          path: 'docs/mira-north-star-roadmap.md',
          summary: 'Roadmap says tool/app action planning must show one local tool/action plan with a clear owner and James-control point.',
        },
        {
          kind: 'file',
          path: 'docs/mira-system-map.md',
          summary: 'System map keeps this lane read-only/no-execution and requires real local evidence before any tool/app action planning.',
        },
        {
          kind: 'comms',
          sourceRef: 'architect#169',
          summary: 'Current Architect delegation asks Mission Control to keep the completed proof context and advance to demo/workbench planning.',
        },
        {
          kind: 'comms',
          sourceRef: 'architect#114',
          commitHash: '22e876dc',
          summary: 'Direct-channel readiness alignment is already committed, so this plan does not create or configure a channel.',
        },
        {
          kind: 'comms',
          sourceRef: 'builder#43',
          commitHash: '22e876dc',
          summary: 'Builder acknowledged the completed readiness contract before this planning boundary.',
        },
        {
          kind: 'comms',
          sourceRef: 'architect#129',
          commitHash: '5b3e0386',
          summary: 'Tool/app action-plan first proof is committed, so this plan is completed Mission Control context.',
        },
        {
          kind: 'comms',
          sourceRef: 'builder#49',
          commitHash: '5b3e0386',
          summary: 'Builder acknowledged the completed tool/app action-plan proof before the continuity/memory boundary.',
        },
      ],
      jamesControlPoint: 'James must explicitly review and approve a separate future request before any real app/tool execution.',
      preconditions: [
        'Worktree is clean.',
        'Stale architect#11 handoff is visible but superseded by the committed Mission Control evidence chain.',
        'Direct-channel readiness checkpoint and Builder ACK are source-specific for 22e876dc.',
        'The plan remains a local Mission Control inspection record, not an execution request.',
      ],
      refusalNoGoConditions: [
        'Dirty worktree or missing committed evidence chain.',
        'Any attempt to browse, call an app/tool, POST, route, send, start runtime, touch credentials, deploy, or move money.',
        'Any target that is not a local SquidRun evidence-planning record for Builder review.',
        "Any request to skip James's explicit approval before real execution.",
      ],
      audit: {
        planningOnly: true,
        executed: false,
        browsed: false,
        appToolCalled: false,
        posted: false,
        routed: false,
        sent: false,
        runtimeStarted: false,
        credentialAccessed: false,
        deployed: false,
        moneyMovement: false,
      },
    });
    expect(context.missionControl.continuityMemoryProof).toEqual({
      id: 'mission-control-continuity-memory-proof-v0',
      status: 'proof_only',
      owner: 'Builder',
      sourceEvidence: [
        {
          kind: 'file',
          path: 'ui/modules/mira-core/typed-restart-continuity-context-v0.js',
          summary: 'Typed restart continuity context is the current sourced restart/current-lane truth contract.',
        },
        {
          kind: 'file',
          path: 'ui/modules/mira-core/mira-presence-runtime-state-v0.js',
          summary: 'Presence runtime state is current SquidRun continuity state, not a New Mira live import.',
        },
        {
          kind: 'file',
          path: 'ui/modules/startup-ai-briefing.js',
          summary: 'Startup briefing materializes sourced restart context and stale markers for current SquidRun startup.',
        },
        {
          kind: 'file',
          path: 'mira/runtime/src/status.ts',
          summary: 'New Mira runtime status exposes continuityLoaded/liveDataImported truth as read-only status provenance.',
        },
        {
          kind: 'test',
          path: 'ui/__tests__/mira-core-typed-restart-continuity-context-v0.test.js',
          summary: 'Focused continuity test coverage anchors sourced restart/current-lane behavior.',
        },
        {
          kind: 'comms',
          sourceRef: 'architect#139',
          commitHash: 'bf82cea4',
          summary: 'Continuity/memory boundary advancement is committed before this proof is exposed.',
        },
        {
          kind: 'comms',
          sourceRef: 'builder#52',
          commitHash: 'bf82cea4',
          summary: 'Builder acknowledged the continuity/memory boundary before this proof record.',
        },
        {
          kind: 'comms',
          sourceRef: 'architect#156',
          commitHash: 'd0bffd58',
          summary: 'Continuity/memory first proof is committed, so this proof record is completed Mission Control context.',
        },
        {
          kind: 'comms',
          sourceRef: 'builder#56',
          commitHash: 'd0bffd58',
          summary: 'Builder acknowledged the completed continuity/memory proof before the demo/workbench boundary.',
        },
        {
          kind: 'comms',
          sourceRef: 'oracle#50',
          commitHash: 'd0bffd58',
          summary: 'Oracle acknowledged the completed continuity/memory proof before the demo/workbench boundary.',
        },
      ],
      currentLaneTruth: {
        sourcePath: '.squidrun/handoffs/current-lane.json',
        loaded: true,
        sourceRef: 'architect#11',
        objective: 'finish the existing 3-file review/no-send gate dirty slice without broadening it:',
        nextAction: 'Continue active lane: finish the existing 3-file review/no-send gate dirty slice without broadening it:',
        generatedAt: '2026-05-22T09:51:49.610Z',
        authority: 'loaded_but_stale_superseded',
      },
      staleOnlySummaryRefusal: {
        refused: true,
        staleSourceRef: 'architect#11',
        staleObjective: 'finish the existing 3-file review/no-send gate dirty slice without broadening it:',
        reason: 'The current-lane file is loaded and visible, but Mission Control refuses to treat that stale-only summary as active because clean later checkpoint/ACK/delegation evidence supersedes architect#11.',
      },
      jamesControlPoint: 'James must review and approve a separate future continuity promotion before New Mira imports, copies, writes, restarts, or promotes any memory state.',
      preconditions: [
        'Worktree is clean.',
        'Stale architect#11 current-lane truth is loaded with provenance.',
        'Later committed Mission Control chain through bf82cea4 is source-specific and acknowledged.',
        'Continuity/memory proof checkpoint plus Builder and Oracle ACKs are source-specific for d0bffd58.',
        'Continuity evidence is read as local proof context only.',
      ],
      refusalNoGoConditions: [
        'Dirty worktree or missing source-specific bf82cea4 checkpoint/ACK evidence.',
        'Any stale-only summary without later sourced checkpoint/ACK/delegation support.',
        'Any request to import state, copy .squidrun, write memory, restart a process, browse, route, send, POST, call runtime/provider/model, touch credentials, deploy, move money, or touch trading.',
        "Any continuity promotion without James's explicit review and approval.",
      ],
      audit: {
        proofOnly: true,
        planningOnly: true,
        imported: false,
        copied: false,
        wrote: false,
        restarted: false,
        processStarted: false,
        browsed: false,
        appToolCalled: false,
        sent: false,
        routed: false,
        posted: false,
        runtimeStarted: false,
        providerInvoked: false,
        modelInvoked: false,
        accountAccessed: false,
        tokenAccessed: false,
        credentialAccessed: false,
        deviceTouched: false,
        userTargeted: false,
        externalTargeted: false,
        deployed: false,
        moneyMovement: false,
        tradingTouched: false,
      },
    });
    expect(context.missionControl.evidence).toEqual(expect.arrayContaining([
      'docs/mira-north-star-roadmap.md',
      'mira/runtime/src/squidrun-context.ts',
      'ui/__tests__/mira-runtime-squidrun-context.test.js',
      'ui/modules/mira-direct-channel-readiness.js',
      'ui/__tests__/mira-direct-channel-readiness.test.js',
      'ui/modules/mira-core/typed-restart-continuity-context-v0.js',
      'ui/modules/mira-core/mira-presence-runtime-state-v0.js',
      'mira/runtime/src/status.ts',
      'hm-comms history --last 500 --json',
    ]));
    expect(context.missionControl.coordinationDrafts).toEqual([
      {
        target: 'builder',
        purpose: 'demo/workbench proof planning',
        message: 'Plan the first inspectable Mission Control demo/workbench proof from local answer/surface evidence: show what is happening here and what should happen next, keep completed toolAppActionPlan and continuityMemoryProof as context, and do not start runtime, open browser, perform UI/status actions, POST, route, send, write, import, or execute.',
      },
      {
        target: 'oracle',
        purpose: 'demo/workbench no-effect review',
        message: 'Review that the demo/workbench plan is inspectable from the local Mission Control answer/surface, keeps completed proof records as context, and claims no runtime start, browser open, UI/status execution, write, POST, route, send, import, or live effect.',
      },
    ]);
    expect(context.missionControl.internalRoutePreview).toEqual(expect.objectContaining({
      status: 'reviewed_preview_only',
      selectedDraftTarget: 'oracle',
      selectedDraftPurpose: 'demo/workbench no-effect review',
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
          content: 'Review that the demo/workbench plan is inspectable from the local Mission Control answer/surface, keeps completed proof records as context, and claims no runtime start, browser open, UI/status execution, write, POST, route, send, import, or live effect.',
        },
      }),
    }));
    expect(context.missionControl.internalRoutePreview.plan.envelope.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file',
        path: 'mira/runtime/src/squidrun-context.ts',
      }),
      expect.objectContaining({
        kind: 'file',
        path: 'ui/__tests__/mira-runtime-squidrun-context.test.js',
      }),
    ]));
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
      sourceRef: 'architect#169',
    }));
    expect(context.recentComms.latestContinuationSelectorCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#73',
    }));
    expect(context.recentComms.latestV1AlignmentDelegation).toEqual(expect.objectContaining({
      sourceRef: 'architect#87',
    }));
    expect(context.recentComms.latestV1AlignmentCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#92',
    }));
    expect(context.recentComms.latestEvidenceWindowCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#98',
    }));
    expect(context.recentComms.latestDirectChannelReadinessCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#114',
    }));
    expect(context.recentComms.latestDirectChannelReadinessAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#43',
    }));
    expect(context.recentComms.latestToolAppActionPlanCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#129',
      commitHash: '5b3e0386',
    }));
    expect(context.recentComms.latestToolAppActionPlanAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#49',
      commitHash: '5b3e0386',
    }));
    expect(context.recentComms.latestContinuityMemoryBoundaryCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#139',
      commitHash: 'bf82cea4',
    }));
    expect(context.recentComms.latestContinuityMemoryBoundaryAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#52',
      commitHash: 'bf82cea4',
    }));
    expect(context.recentComms.latestContinuityMemoryProofCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#156',
      commitHash: 'd0bffd58',
    }));
    expect(context.recentComms.latestContinuityMemoryProofAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#56',
      commitHash: 'd0bffd58',
    }));
    expect(context.recentComms.latestContinuityMemoryProofOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#50',
      commitHash: 'd0bffd58',
    }));
    expect(context.missionControl.continuationDecision).toEqual(expect.objectContaining({
      status: 'current_handoff',
      preferredSourceRef: 'architect#169',
      staleSourceRef: null,
    }));
    expect(context.lane.staleHandoff).toBeNull();
    expect(context.summary.happening).toContain('finish the existing 3-file review/no-send gate dirty slice');
    expect(context.summary.nextStep).not.toContain('tool/app action plan');
    expect(context.summary.nextStep).not.toContain('continuity/memory proof');
    expect(context.summary.nextStep).not.toContain('demo/workbench proof');
    expect(context.summary.toolAppActionPlan).toBeNull();
    expect(context.summary.continuityMemoryProof).toBeNull();
    expect(context.missionControl.toolAppActionPlan).toBeNull();
    expect(context.missionControl.continuityMemoryProof).toBeNull();
    expect(answer).toContain('Dirty work: 1 changed file(s)');
    expect(answer).not.toContain('Tool/app action plan: local_squidrun_evidence_review');
    expect(answer).not.toContain('Completed tool/app action plan context: local_squidrun_evidence_review');
    expect(answer).not.toContain('Continuity and memory is the next map boundary');
    expect(answer).not.toContain('First inspectable Mission Control demo/workbench proof planning is the next map boundary');
    expect(answer).not.toContain('Continuity/memory proof: mission-control-continuity-memory-proof-v0');
    expect(answer).not.toContain('Completed continuity/memory proof evidence: checkpoint architect#156 d0bffd58');
    expect(answer).not.toContain('Oracle ACK oracle#50 d0bffd58');
    expect(answer).not.toContain('Stale handoff: architect#11');
    expect(answer.match(/^JAMES ACTION:/gm)).toHaveLength(1);
  });
});
