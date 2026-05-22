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
const staleCheckpointSpacerRows = Array.from({ length: 560 }, (_, index) => ({
  sender: 'architect',
  target: 'builder',
  timestampMs: 1779443380000 + index,
  rawBody: \`(ARCHITECT #\${1000 + index}): Status check: unrelated checkpoint chatter \${index}; proof PASS; JAMES ACTION: NONE.\`
}));
const rows = [
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779472601000,
    rawBody: '(ARCHITECT #388): Builder, containment on #386 WIP while mentioning cbeb0d2f and mission-control-internal-route-audit-promotion-decision-gate-proof-v0. This report-shaped containment row must stay diagnostic and not become active delegation or checkpoint authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779472600000,
    rawBody: '(ORACLE #16): Received #387 sidecar for #386. Holding PASS/MODIFY/BLOCK until Builder proof lands while mentioning architect#384/cbeb0d2f and oracle#15/cbeb0d2f. This sidecar/name-drop row must not become the cbeb0d2f Oracle acceptance. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779472563000,
    rawBody: '(ARCHITECT #386): Builder, take the next map-backed no-live-effect slice from clean \u0060cbeb0d2f\u0060: create one inspectable Mission Control internal route/audit promotion decision-gate plan/proof from the visible \u0060mission-control-internal-route-audit-review-lane-proof-v0\u0060 only. Bind the gate to source-specific \u0060architect#384/cbeb0d2f Advance Mission Control route audit decision gate\u0060 plus \u0060oracle#15/cbeb0d2f\u0060; do not require or fabricate a missing Builder post-cbeb ACK. Keep completed contexts retained through \u0060commandCardAcceptance\u0060, \u0060commandCardRoutePlanFollowThroughProof\u0060, \u0060internalRoutePromotionReviewPlan\u0060, and \u0060internalRouteAuditReviewLaneProof\u0060. Required record shape: Builder owner, Oracle reviewer/target, purpose/body/decision object, source evidence including the visible audit-review proof and cbeb0d2f evidence, James explicit control point before any real route/audit promotion, preconditions, refusal/no-go conditions, and manual/planning-only false live-effect audit flags. Dirty worktree blocks exposure/advancement; composed answer keeps exactly one literal \u0060JAMES ACTION:\u0060 occurrence. No real promotion, route flip, hm-send/live send, runtime/browser/workbench/UI/status action, fetch, POST, provider/model call, credential/account/token/device/user/external target, deploy, money, or trading authority/claim. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779472495000,
    rawBody: '(ARCHITECT #385): Checkpoint \u0060cbeb0d2f Advance Mission Control route audit decision gate\u0060 committed clean. This Oracle-targeted checkpoint must not become the Builder-targeted route/audit decision-gate checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779472482000,
    rawBody: '(ARCHITECT #384): Checkpoint \u0060cbeb0d2f Advance Mission Control route audit decision gate\u0060 committed clean. Pre-commit passed all gates, including focused context and map guard. Clean probe after rebuild: worktree clean; recentComms loaded; latestJamesActionLineDedupCheckpoint=architect#372/2533ace2; latestJamesActionLineDedupOracleAck=oracle#11/2533ace2; completed contexts present through commandCardAcceptance, commandCardRoutePlanFollowThroughProof, internalRoutePromotionReviewPlan, and internalRouteAuditReviewLaneProof; nextStep/drafts/preview now point to no-live-effect internal route/audit promotion decision-gate planning from the visible audit-review proof only; composed answer has exactly one literal JAMES ACTION line. No live authority added. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779472512000,
    rawBody: '(ORACLE #15): Checkpoint received. Clean-head closure recorded for \u0060cbeb0d2f Advance Mission Control route audit decision gate\u0060; Oracle #14 PASS accepted as committed evidence. Local verification: HEAD is \u0060cbeb0d2f\u0060 and worktree/index are clean. Closure facts recorded: post-answer-shape evidence remains source-bound to \u0060architect#372/2533ace2\u0060 plus \u0060oracle#11/2533ace2\u0060; completed contexts are retained through \u0060missionControl.internalRouteAuditReviewLaneProof\u0060; clean nextStep/drafts/preview advanced from accepted audit-proof review to one no-live-effect internal route/audit promotion decision-gate planning lane from the visible audit-review proof only; composed answer keeps exactly one literal \u0060JAMES ACTION:\u0060 line; no runtime/browser/workbench/UI/status action, fetch/POST, route/send/hm-send, provider/model, credential/account/token/device/user/external target, deploy, money, or trading authority was added. Standing by for the next map-backed review boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779470605000,
    rawBody: '(ARCHITECT #377): Checkpoint: committed unrelated note as caf2533 while mentioning prior 2533ace2 Deduplicate Mission Control James action line and missionControl.internalRouteAuditReviewLaneProof. This newer name-drop chatter must not become the answer-shape checkpoint or active delegation. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779470604000,
    rawBody: '(ORACLE #12): Received caf2533 checkpoint while mentioning prior 2533ace2 Deduplicate Mission Control James action line. This newer name-drop chatter must not become the answer-shape Oracle acceptance. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779470603000,
    rawBody: '(ARCHITECT #374): Builder, take the next map-backed Mission Control slice after 2533ace2. Clean context is still asking Oracle to review mission-control-internal-route-audit-review-lane-proof-v0, but Oracle #11 has now recorded that proof chain plus the answer-shape closure as accepted clean-head context. Bind source-specific 2533ace2 Deduplicate Mission Control James action line checkpoint evidence, preferably architect#372, plus Oracle acceptance oracle#11; do not invent a missing Builder post-2533 ACK. Keep completed contexts retained through commandCardAcceptance, commandCardRoutePlanFollowThroughProof, internalRoutePromotionReviewPlan, and internalRouteAuditReviewLaneProof. Clean Mission Control should stop treating Oracle should review mission-control-internal-route-audit-review-lane-proof-v0 as the active next move and advance to one separate no-live-effect internal route/audit promotion decision-gate planning lane from the visible audit-review proof only, with James as the explicit control point before any real route/audit promotion. Dirty worktree must block advancement; report/checkpoint/name-drop/closure rows must not steal delegation/checkpoint/ACK authority; exactly one literal JAMES ACTION line remains. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779470602000,
    rawBody: '(ARCHITECT #373): Checkpoint 2533ace2 Deduplicate Mission Control James action line is committed clean. This Oracle-targeted checkpoint must not become the Builder-targeted answer-shape checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779470601000,
    rawBody: '(ARCHITECT #372): Checkpoint \u00602533ace2 Deduplicate Mission Control James action line\u0060 is committed clean. Pre-commit passed, including focused context and map guard. Clean live probe: worktree clean, recentComms loaded, composed \u0060missionControl.answer\u0060 has exactly one literal \u0060JAMES ACTION:\u0060 occurrence and exactly one line-start action line; structured \u0060missionControl.commandCardAcceptance.cardFields.jamesActionLine\u0060 remains \u0060JAMES ACTION: NONE\u0060; completed contexts remain present through \u0060internalRouteAuditReviewLaneProof\u0060. No live-effect/trading authority added. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779470600000,
    rawBody: '(ORACLE #11): Checkpoint received. Clean-head closure recorded for \u00602533ace2 Deduplicate Mission Control James action line\u0060: Oracle #10 PASS and Builder #107 map-guard closure are accepted as committed evidence. Local verification saw HEAD at 2533ace2 with clean worktree/index after the staged packet disappeared into the commit. Closure facts recorded: composed \u0060missionControl.answer\u0060 has exactly one literal \u0060JAMES ACTION:\u0060 occurrence, structured \u0060missionControl.commandCardAcceptance.cardFields.jamesActionLine\u0060 remains \u0060JAMES ACTION: NONE\u0060, completed contexts remain present through \u0060missionControl.internalRouteAuditReviewLaneProof\u0060, and no runtime/route/send/UI/status/provider/model/credential/deploy/money/trading authority was added. Standing by for the next map-backed review boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460305000,
    rawBody: '(ARCHITECT #332): Builder containment on #331 WIP. Current dirty scope is runtime-only while mentioning b1acd4d7 Fix Mission Control post audit Oracle ACK selector and internal route/audit planning. This containment row must stay diagnostic and not active delegation authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460304000,
    rawBody: '(ARCHITECT #330): Checkpoint: committed unrelated selector note as cafeb1a while mentioning prior b1acd4d7 Fix Mission Control post audit Oracle ACK selector and mission-control-internal-route-audit-review-lane-proof-v0. This newer name-drop chatter must not become the internal route/audit review-lane proof checkpoint or active delegation. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460303000,
    rawBody: '(ORACLE #108): Received cafeb1a checkpoint while mentioning prior b1acd4d7 Fix Mission Control post audit Oracle ACK selector. This newer name-drop chatter must not become the internal route/audit review-lane proof Oracle ACK. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460302000,
    rawBody: '(ARCHITECT #331): Builder, take the next map-backed Mira lane from clean b1acd4d7: one inspectable no-live-effect internal route/audit review-lane planning first proof from mission-control-internal-route-promotion-review-plan-v0 only. Scope expectation: runtime context plus focused context test plus map only if truth text changes. Bind source-specific b1acd4d7 checkpoint/Oracle #107 evidence; do not require or invent a Builder b1 ACK if none exists. Add name-drop/report/containment-row regression so later chatter cannot steal checkpoint/ACK/delegation authority. Clean context should expose one concrete plan/proof with owner Builder, target/reviewer Oracle, target/purpose/body or review object, source evidence, James control point before any real route/audit promotion, preconditions/no-go conditions, and manual/planning-only false live-effect audit flags. Dirty worktree blocks exposure/advancement. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460301000,
    rawBody: '(ARCHITECT #329): Checkpoint: committed corrective #325 as b1acd4d7 Fix Mission Control post audit Oracle ACK selector. Builder #98 PASS and Oracle #106 PASS accepted. Clean-head proof: worktree clean; HEAD b1acd4d7; focused context PASS 2/2; runtime TypeScript noEmit PASS; map guard PASS 15/15; live context reports stale_handoff_superseded, latestPostAuditPlanningSelectorCheckpoint=architect#311/582ef1c6, latestPostAuditPlanningSelectorBuilderAck=builder#94/582ef1c6, fixed latestPostAuditPlanningSelectorOracleAck=oracle#101/582ef1c6. Completed contexts remain present: commandCardAcceptance, commandCardRoutePlanFollowThroughProof, and internalRoutePromotionReviewPlan. NextStep remains the no-live-effect internal route/audit planning lane from the visible plan only; selected draft purpose is internal route/audit planning review; exactly one JAMES ACTION line. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460300000,
    rawBody: '(ORACLE #107): Received b1acd4d7 checkpoint. Oracle accepts clean-head post-audit selector / Oracle ACK selector evidence: latestPostAuditPlanningSelectorOracleAck=oracle#101/582ef1c6, completed contexts remain present, internal route/audit planning stays no-live-effect, and exactly one JAMES ACTION line remains. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460200000,
    rawBody: '(ARCHITECT #315): Builder, #313 WIP sanity is green but incomplete. Current dirty scope is only mira/runtime/src/squidrun-context.ts with 69 added/changed lines; focused context PASS 2/2, runtime TSC PASS, map guard PASS. This runtime-only selector truth change is still not reviewable and must stay diagnostic only. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460199000,
    rawBody: '(ARCHITECT #314): Checkpoint: committed unrelated selector note as abc582e while mentioning prior 582ef1c6 Harden Mission Control post audit planning selector and architect#304. This newer name-drop chatter must not become the post-audit selector checkpoint or active delegation. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460198000,
    rawBody: '(ORACLE #102): Checkpoint received. cafe582 selector hardening recorded clean-head while mentioning prior 582ef1c6 Harden Mission Control post audit planning selector. This newer name-drop chatter must not become the post-audit selector Oracle ACK. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460197000,
    rawBody: '(ARCHITECT #313): Builder, take the next tiny map-backed Mira selector cleanup after 582ef1c6: clean Mission Control should reject the wider WIP sanity/status/containment/closure-nudge family from active continuation delegation authority, including rows like architect#304, not only red-WIP rows. Scope should stay runtime-context/test/map. Bind source-specific 582ef1c6 Harden Mission Control post audit planning selector evidence to the actual Architect checkpoint plus Builder ACK #94 and Oracle ACK #101; report/name-drop/WIP sanity/status/containment/closure rows must not steal active delegation or checkpoint/ACK authority. Keep commandCardAcceptance, commandCardRoutePlanFollowThroughProof, and internalRoutePromotionReviewPlan as completed visible context, and keep nextStep/drafts/preview on the no-live-effect internal route/audit planning lane from the visible plan only. Dirty worktree blocks advancement. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460196000,
    rawBody: '(ARCHITECT #311): Checkpoint: committed #300 post-c1a05e07 selector hardening as 582ef1c6 Harden Mission Control post audit planning selector. Builder #92/#93 PASS and Oracle #100 PASS accepted. Clean-head proof: worktree clean; HEAD 582ef1c6; pre-commit gates passed, including focused context PASS 2/2 and map guard PASS; live context reports stale_handoff_superseded, source-specific audit-planning checkpoint architect#298/c1a05e07, Builder ACK builder#90/c1a05e07, Oracle ACK oracle#98/c1a05e07, missionControl.internalRoutePromotionReviewPlan=mission-control-internal-route-promotion-review-plan-v0, nextStep still internal route/audit planning from the visible plan only, selected draft purpose internal route/audit planning review, exactly one JAMES ACTION line. JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779460195000,
    rawBody: '(BUILDER #94): ACK 582ef1c6 checkpoint. Post-c1a05e07 selector hardening is committed clean; I noted the next-slice caveat that live latestContinuationDelegation now selects architect#304, so the next cleanup should reject the broader WIP sanity/status/containment/closure-nudge family, not just red WIP rows. Standing by for the next map-backed Mira boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460194000,
    rawBody: '(ORACLE #101): Checkpoint received. 582ef1c6 selector hardening recorded clean-head. Clean context keeps internal route/audit planning unchanged and exactly one JAMES ACTION line remains. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460193000,
    rawBody: '(ARCHITECT #304): Builder, WIP sanity on #300 is green but incomplete. Current dirty scope is only mira/runtime/src/squidrun-context.ts with 117 added/changed lines; focused context PASS 2/2, runtime TSC PASS, map guard PASS. This is still not reviewable as a runtime-only truth change. This closure nudge must be diagnostic only, not active delegation authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460160000,
    rawBody: '(ARCHITECT #300): Builder, take the next tiny map-backed Mira slice after c1a05e07: clean Mission Control should stop treating red-fixture containment/nudge rows like architect#295 as the active continuation delegation once the c1a05e07 route/audit planning advancement is committed and ACKed. Scope should stay runtime-context/test/map. Bind source-specific c1a05e07 Advance Mission Control internal route audit planning evidence to the actual Architect checkpoint plus Builder ACK #90 and Oracle ACK #98; report/name-drop/containment rows must not steal active delegation or checkpoint/ACK authority. Keep commandCardAcceptance, commandCardRoutePlanFollowThroughProof, and internalRoutePromotionReviewPlan as completed visible context. Clean nextStep/drafts/preview should remain on the no-live-effect internal route/audit planning lane from the visible plan only. Dirty worktree blocks advancement. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460159000,
    rawBody: '(ARCHITECT #301): Checkpoint: committed unrelated selector note as abcc1a0 while mentioning prior c1a05e07 Advance Mission Control internal route audit planning and architect#295. This newer name-drop chatter must not become the internal route/audit planning checkpoint or active delegation. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460158000,
    rawBody: '(ORACLE #99): Received cafec1a checkpoint while mentioning prior c1a05e07 Advance Mission Control internal route audit planning. This newer name-drop chatter must not become the internal route/audit planning Oracle ACK. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460157000,
    rawBody: '(ARCHITECT #295): Builder, focused context test is still red after the WIP moved. Current failure is tighter now: clean fixture source evidence still expects architect#272 while runtime now emits architect#289 for the post-f7352d10 route/audit lane. Please fix the focused assertions. This red-fixture nudge must be diagnostic only, not active delegation authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460156000,
    rawBody: '(ARCHITECT #298): Checkpoint: committed #289 post-f7352d10 internal route/audit planning advancement as c1a05e07 Advance Mission Control internal route audit planning. Builder #89 PASS and Oracle #97 PASS accepted. Clean-head proof: worktree clean; HEAD c1a05e07; focused context PASS 2/2; map guard PASS; Architect live probe reports stale_handoff_superseded, source-specific surface evidence architect#287/f7352d10 plus oracle#95/f7352d10, missionControl.internalRoutePromotionReviewPlan=mission-control-internal-route-promotion-review-plan-v0, nextStep now internal route/audit planning from the visible plan only, selected draft purpose internal route/audit planning review, exactly one JAMES ACTION line. JAMES ACTION: NONE.'
  },
  {
    sender: 'builder',
    target: 'architect',
    timestampMs: 1779460155000,
    rawBody: '(BUILDER #90): ACK c1a05e07 checkpoint. Internal route/audit planning advancement is committed and clean; I noted the next-slice caveat that live latestContinuationDelegation currently selects architect#295 as current selector evidence, not a live-effect issue. Standing by for the next map-backed Mira boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460154000,
    rawBody: '(ORACLE #98): Received c1a05e07 checkpoint. Oracle records internal route/audit planning selector boundary as committed clean-head context: source-specific f7352d10 surface evidence retained, architect#295 is diagnostic only, nextStep remains internal route/audit planning from the visible plan only, and exactly one JAMES ACTION line remains. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460120000,
    rawBody: '(ARCHITECT #291): Builder status nudge on #289. This status/nudge row mentions f7352d10 Render Mission Control internal route promotion plan and internal route/audit planning, but must not become active delegation authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460119000,
    rawBody: '(ORACLE #96): Received cafe735 checkpoint while mentioning prior f7352d10 Render Mission Control internal route promotion plan. This newer name-drop chatter must not become the internal-route promotion plan surface Oracle ACK. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460118000,
    rawBody: '(ARCHITECT #290): Checkpoint: committed unrelated selector note as abcf735 while mentioning prior f7352d10 Render Mission Control internal route promotion plan and missionControl.internalRoutePromotionReviewPlan. This newer name-drop chatter must not become the internal-route promotion plan surface checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460117000,
    rawBody: '(ARCHITECT #289): Builder, take the next map-backed Mira slice after f7352d10: advance Mission Control past the completed internal-route promotion plan surface into separate internal route/audit lane planning from the visible plan only. Scope should stay runtime-context/test/map. Bind advancement to source-specific f7352d10 Render Mission Control internal route promotion plan evidence, preferably Builder-targeted checkpoint architect#287 plus Oracle ACK oracle#95, so later name-drop/report rows cannot steal authority. Keep commandCardAcceptance, commandCardRoutePlanFollowThroughProof, and internalRoutePromotionReviewPlan as completed visible context. Clean nextStep/drafts/preview should move to one no-live-effect internal route/audit planning lane for any future promotion proposal from the visible plan; this is planning/review only, not promotion. Dirty worktree must block advancement. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460116000,
    rawBody: '(ARCHITECT #287): Checkpoint: committed #282 internal-route promotion plan surface as f7352d10 Render Mission Control internal route promotion plan. Builder #86 PASS and Oracle #94 PASS accepted. Clean-head proof: worktree clean; HEAD f7352d10; UI read-only boot PASS 71/71; focused context PASS 2/2; runtime TypeScript noEmit PASS; map guard PASS 15/15; live getSquidRunContext() reports stale_handoff_superseded, active delegation architect#282, internal-route planning checkpoint architect#270/0cb27b6b plus Oracle ACK oracle#88/0cb27b6b, missionControl.internalRoutePromotionReviewPlan=mission-control-internal-route-promotion-review-plan-v0, status planning_only_ready_for_oracle_review, nextStep still asks Oracle to review the plan, selected draft purpose internal-route promotion plan review, exactly one JAMES ACTION line. No runtime context advancement or live-effect authority added. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460115000,
    rawBody: '(ORACLE #95): Checkpoint received. #282 / f7352d10 closure recorded: internal-route promotion plan surface renders missionControl.internalRoutePromotionReviewPlan as completed visible context with no runtime context advancement or live-effect authority added. Oracle standing by for the next map-backed boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460080000,
    rawBody: '(ARCHITECT #276): Checkpoint: committed unrelated selector note as abc0cb1 while mentioning prior 0cb27b6b Advance Mission Control internal route planning and internal-route promotion/review plan. This newer name-drop chatter must not become the internal-route planning checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460079000,
    rawBody: '(ORACLE #90): Received cafe0cb checkpoint while mentioning prior 0cb27b6b Advance Mission Control internal route planning. This newer name-drop chatter must not become the internal-route planning Oracle ACK. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460078000,
    rawBody: '(ARCHITECT #274): MODIFY/containment on #272 WIP. Current dirty scope is runtime-only and this containment report must not become active delegation authority while it mentions 0cb27b6b and internal-route promotion/review planning. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460066569,
    rawBody: '(ARCHITECT #272): Builder, take the next map-backed Mira slice after 0cb27b6b: create the first inspectable internal-route promotion/review plan from the visible mission-control-command-card-route-plan-follow-through-v0 proof only. Scope should stay runtime-context/test/map. Bind the advancement to source-specific 0cb27b6b Advance Mission Control internal route planning checkpoint evidence plus Oracle ACK #88 so later name-drop/report rows cannot steal authority. Keep commandCardAcceptance and commandCardRoutePlanFollowThroughProof as completed visible context, then expose one concrete Mission Control internal-route promotion/review plan with owner Builder, target/purpose/body or message, source evidence, James control point, preconditions/no-go conditions, manual-only/no-send/no-promotion/no-route-flip/no-execution audit flags, and exactly one JAMES ACTION line. Dirty worktree must block proof exposure/advancement. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779460022886,
    rawBody: '(ARCHITECT #271): Checkpoint: committed #262 post-120806b4 Mission Control context advancement as 0cb27b6b Advance Mission Control internal route planning. This Oracle-targeted checkpoint name-drop must not become the Builder-targeted internal-route planning checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779460022751,
    rawBody: '(ARCHITECT #270): Checkpoint: committed #262 post-120806b4 Mission Control context advancement as 0cb27b6b Advance Mission Control internal route planning. Builder #82 PASS and Oracle #86/#87 PASS accepted. Clean-head proof: worktree clean; HEAD 0cb27b6b; focused context PASS 2/2; runtime TypeScript noEmit PASS; map guard PASS 15/15; live getSquidRunContext() reports stale_handoff_superseded, active delegation architect#262, source-specific route-plan proof surface checkpoint architect#260/120806b4 plus Oracle ACK oracle#84/120806b4, commandCardAcceptance and commandCardRoutePlanFollowThroughProof completed context, nextStep internal-route promotion/review planning from the visible proof only, selected draft purpose internal-route promotion no-send review, exactly one JAMES ACTION line. No live-effect authority added. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779460034980,
    rawBody: '(ORACLE #88): Checkpoint received. #262 / 0cb27b6b closure recorded: clean head reports stale_handoff_superseded, active delegation architect#262, source-specific architect#260/120806b4 plus oracle#84/120806b4, commandCardAcceptance and commandCardRoutePlanFollowThroughProof completed context, nextStep internal-route promotion/review planning from the visible proof only, one JAMES ACTION line, and no live-effect authority added. Oracle standing by for the next map-backed boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779459120000,
    rawBody: '(ARCHITECT #264): Builder status nudge on #262. You ACKed the post-120806b4 context advancement, but this status/nudge row must not become active delegation authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779459119545,
    rawBody: '(ARCHITECT #262): Builder, take the post-120806b4 Mission Control context advancement/fix slice. Live clean evidence includes the committed display surface 120806b4 Render Mission Control route plan proof surface plus Oracle ACK #84. Fix the smallest no-live-effect runtime-context/test/map slice: reject report/nudge rows like Builder containment on #254 WIP from active delegation authority; bind source-specific 120806b4 display-surface checkpoint evidence, preferably architect#260, plus Oracle ACK oracle#84; keep commandCardAcceptance and commandCardRoutePlanFollowThroughProof as completed visible context; advance clean nextStep/drafts/preview to internal-route promotion/review planning from the visible proof only, no send/execution. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779459100000,
    rawBody: '(ARCHITECT #263): Checkpoint: committed unrelated selector note as abc1208 while mentioning prior 120806b4 Render Mission Control route plan proof surface and missionControl.commandCardRoutePlanFollowThroughProof. This newer name-drop chatter must not become the route-plan proof surface checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779459090000,
    rawBody: '(ORACLE #85): Received cafe120 checkpoint while mentioning prior 120806b4 Render Mission Control route plan proof surface. This newer name-drop chatter must not become the route-plan proof surface Oracle ACK. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779459080000,
    rawBody: '(ARCHITECT #261): Checkpoint: committed #254 display-only route-plan follow-through proof surface as 120806b4 Render Mission Control route plan proof surface. This Oracle-targeted checkpoint name-drop must not become the Builder-targeted route-plan proof surface checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779459070000,
    rawBody: '(ARCHITECT #260): Checkpoint: committed #254 display-only route-plan follow-through proof surface as 120806b4 Render Mission Control route plan proof surface. Builder #80 PASS and Oracle #83 PASS accepted. Clean-head proof: worktree clean; HEAD 120806b4; UI read-only boot PASS 70/70; node --check app.js PASS; node --check UI boot test PASS; map guard PASS 15/15. The local workbench renders existing \\u0060missionControl.commandCardRoutePlanFollowThroughProof\\u0060 from loaded \\u0060/squidrun/context\\u0060 beside commandCardAcceptance, with proof id/status, target/purpose/message/body, architect#242/df0a47a6 + oracle#77/df0a47a6 evidence, control point, no-go/preconditions, false audit flags, zero POST/no /turn, and exactly one JAMES ACTION line. No runtime context change or live-effect authority added. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779459060000,
    rawBody: '(ORACLE #84): Checkpoint received. #254 / 120806b4 closure recorded: clean workbench renders \\u0060missionControl.commandCardRoutePlanFollowThroughProof\\u0060 from loaded \\u0060/squidrun/context\\u0060 beside commandCardAcceptance with required proof fields/evidence/control/no-go/false flags, zero POST/no /turn, and exactly one JAMES ACTION line. No runtime context change or live-effect authority added. Oracle standing by for the next delegated map-backed boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779459050000,
    rawBody: '(ARCHITECT #257): Builder containment on #254 WIP. I can see the UI dirty slice now, but this containment nudge must not become active continuation delegation authority. It mentions rendered proof id/status, target/purpose, architect#242/df0a47a6 and oracle#77/df0a47a6 evidence, zero POST/no /turn, and exactly one JAMES ACTION line. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779457740000,
    rawBody: '(ARCHITECT #248): Builder, containment on #244: ACK-with-clean-tree has become a stalled/design-loop risk. Land the smallest dirty slice for df0a47a6 route-plan follow-through proof, but this containment nudge must not become active continuation delegation authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779457730000,
    rawBody: '(ARCHITECT #246): Builder status nudge on #244. The route-plan follow-through proof lane still needs source-specific df0a47a6 checkpoint plus Oracle ACK, but this status/nudge row must not become active continuation delegation authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779457720000,
    rawBody: '(ARCHITECT #247): Checkpoint: committed unrelated selector note as abc5678 while mentioning prior df0a47a6 Advance Mission Control command card follow-through and route-plan follow-through proof. This newer name-drop chatter must not become the command-card follow-through checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779457719000,
    rawBody: '(ORACLE #79): Received cafe777 checkpoint while mentioning prior df0a47a6 Advance Mission Control command card follow-through. This newer name-drop chatter must not become the command-card follow-through Oracle ACK. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779457716515,
    rawBody: '(ARCHITECT #244): Builder, take the next map-backed Mira slice after df0a47a6: Mission Control command-card route-plan follow-through proof. Build the smallest no-live-effect slice that keeps commandCardAcceptance completed context and exposes one concrete planning/proof record over existing coordinationDrafts/internalRoutePreview with exact target/purpose/message, source evidence, James control point, preconditions/no-go conditions, and false audit flags. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779457646000,
    rawBody: '(ARCHITECT #243): Checkpoint: committed #237 post-5d119dc6 command-card follow-through advancement as df0a47a6 Advance Mission Control command card follow-through. This Oracle-targeted checkpoint name-drop must not become the Builder-targeted command-card follow-through checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779457645344,
    rawBody: '(ARCHITECT #242): Checkpoint: committed #237 post-5d119dc6 command-card follow-through advancement as df0a47a6 Advance Mission Control command card follow-through. Builder #76 PASS and Oracle #76 PASS accepted. Clean-head proof: worktree clean; HEAD df0a47a6; focused context PASS 2/2; runtime TypeScript noEmit PASS; node --check context test PASS; map guard PASS 15/15. Live compiled getSquidRunContext() now reports stale_handoff_superseded, active latestContinuationDelegation=architect#237, missionControl.commandCardAcceptance=true, nextStep is one dry-run Builder/Oracle route-plan review/follow-through lane from the visible Mission Control v0 command card, and exactly one JAMES ACTION line. No live-effect authority added. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779457653929,
    rawBody: '(ORACLE #77): Checkpoint received. #237 / df0a47a6 closure recorded: clean context now reports stale_handoff_superseded, active delegation architect#237, commandCardAcceptance retained as completed context, and nextStep advanced to the dry-run Builder/Oracle route-plan review/follow-through lane from the visible Mission Control v0 command card. Exactly one JAMES ACTION line and no live-effect authority added. Oracle standing by for the next delegated map-backed boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779456960000,
    rawBody: '(ARCHITECT #240): Checkpoint: committed unrelated selector note as abc1234 while mentioning prior 5d119dc6 Render Mission Control command card surface and commandCardAcceptance. This newer name-drop chatter must not become the command-card surface checkpoint. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779456950000,
    rawBody: '(ARCHITECT #239): MODIFY on #237 WIP, narrow proof closure. The post-5d119dc6 command-card route-plan follow-through shape is right, but this is a report/nudge row and must not become active continuation delegation authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779456858820,
    rawBody: '(ARCHITECT #237): Builder, take the post-5d119dc6 next-move advancement slice. Clean evidence now includes the completed command-card surface commit 5d119dc6 Render Mission Control command card surface, Architect checkpoint #235, Oracle checkpoint ACK #74, and clean proof. Build the smallest no-live-effect runtime-context/test/map slice so Mission Control treats missionControl.commandCardAcceptance as completed visible context and advances clean nextStep/drafts/preview to one dry-run Builder/Oracle route-plan review/follow-through lane from the visible command card, with no send/promotion/execution. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779456825000,
    rawBody: '(ORACLE #76): Received cafe119 checkpoint while mentioning prior 5d119dc6 Render Mission Control command card surface. This newer name-drop chatter must not become the command-card surface Oracle ACK. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779456815370,
    rawBody: '(ORACLE #74): Checkpoint received. #230 / 5d119dc6 closure recorded: command-card surface now renders from existing /squidrun/context with the required fields and exactly one JAMES ACTION line; UI boot proof is green; no runtime context change or live-effect authority added. Oracle standing by for the next delegated map-backed boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779456806691,
    rawBody: '(ARCHITECT #235): Checkpoint: committed #230 command-card surface acceptance as 5d119dc6 Render Mission Control command card surface. Builder #74 PASS and Oracle #73 PASS accepted. Clean-head proof: worktree clean; HEAD 5d119dc6; UI read-only boot PASS 69/69; node --check app.js PASS; node --check UI boot test PASS; map guard PASS 15/15. Local Mission Control workbench now renders missionControl.commandCardAcceptance from existing /squidrun/context: card id, completed contexts, current lane/why, recent changes, Builder/Oracle next moves, dirty/context status, exactly one JAMES ACTION line, and dry-run route plan. No runtime context change or live-effect authority added. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779455600000,
    rawBody: '(ARCHITECT #204): Oracle sidecar for #203 post-c301c1ac Mission Control v0 command-card acceptance slice. Review the actual c301c1ac Render Mission Control workbench proof surface checkpoint plus Oracle ACK, but do not treat this sidecar as Builder delegation authority. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779455500000,
    rawBody: '(ARCHITECT #203): Current-session delegation: post-c301c1ac Mission Control v0 command-card acceptance slice. Clean HEAD is c301c1ac Render Mission Control workbench proof surface. Build the smallest no-live-effect slice so clean getSquidRunContext() advances past prove the workbench surface renders and points to Mission Control v0 command-card acceptance from local evidence: current lane/why it matters, what changed recently, Builder next move, Oracle next move, context-card/current dirty-context status, exactly one JAMES ACTION line, and one dry-run route plan. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779455400000,
    rawBody: '(ORACLE #67): Received cafe301 checkpoint while mentioning prior c301c1ac Render Mission Control workbench proof surface. This is newer name-drop chatter and must not become the source-specific Oracle ACK. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779455300000,
    rawBody: '(ORACLE #66): Received c301c1ac checkpoint. Oracle records #188 workbench surface proof slice as committed clean-head context: source-specific 48e419b4 + Oracle #62 gate retained, demoWorkbenchProof completed context, clean context advances to read-only Mission Control workbench surface proof, UI renders proof id/question/completed contexts/next step/control point from /squidrun/context with zero /turn POST and one JAMES ACTION line. JAMES ACTION: NONE. Standing by for the next map-backed Mira boundary.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779455200000,
    rawBody: '(ARCHITECT #201): Checkpoint: committed #188 post-48e419b4 workbench surface proof slice as c301c1ac Render Mission Control workbench proof surface. Builder #66 PASS and Oracle #64/#65 PASS accepted. Clean-head proof: worktree clean; HEAD c301c1ac; focused context PASS 2/2; UI read-only boot PASS 68/68; runtime TSC noEmit PASS; node --check app/context test/UI boot test PASS; map guard PASS 15/15. Behavior committed: source-specific 48e419b4 checkpoint plus Oracle #62 ACK gate advancement; demoWorkbenchProof remains completed context; clean context advances to read-only local New Mira Mission Control workbench surface proof; UI renders proof id/question/completed contexts/next step/control point from /squidrun/context with zero /turn POST and exactly one JAMES ACTION line. Continuing to the next map-backed Mira boundary. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779453517788,
    rawBody: '(ARCHITECT #188): Current-session delegation: post-48e419b4 Mission Control demo surface-alignment slice. Clean HEAD is 48e419b4 Add Mission Control demo workbench proof. Build the smallest no-live-effect slice that advances from completed missionControl.demoWorkbenchProof to local workbench/surface proof. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779453500000,
    rawBody: '(ORACLE #63): Received cafe888 checkpoint while referencing prior 48e419b4 Add Mission Control demo workbench proof. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779453416734,
    rawBody: '(ORACLE #62): Received 48e419b4 checkpoint. Oracle records #178 demo/workbench first-proof slice as committed clean-head context: missionControl.demoWorkbenchProof present, completed toolAppActionPlan plus continuityMemoryProof retained, source-specific 13c90817 evidence preserved, nextStep remains local answer/surface review with James approval before any runtime/browser/workbench/UI/write/POST/route/send/execution, and JAMES ACTION remains NONE. Standing by for the next map-backed Mira boundary.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779453404373,
    rawBody: '(ARCHITECT #187): Checkpoint: committed #178 Mission Control demo/workbench first-proof slice as 48e419b4 Add Mission Control demo workbench proof. Oracle #61 PASS accepted; pre-commit passed. Clean-head proof: worktree clean, HEAD 48e419b4, missionControl.demoWorkbenchProof present, and exactly one JAMES ACTION line. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779453404228,
    rawBody: '(ARCHITECT #186): Checkpoint: committed #178 Mission Control demo/workbench first-proof slice as 48e419b4 Add Mission Control demo workbench proof. Oracle #61 PASS accepted; pre-commit passed, including focused context PASS 2/2 and Mira system map guard PASS. Clean-head proof: worktree clean, HEAD 48e419b4, live compiled getSquidRunContext() reports \\u0060missionControl.demoWorkbenchProof\\u0060 present and exactly one JAMES ACTION line. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779449500000,
    rawBody: '(ARCHITECT #178): Current-session delegation: Mission Control demo/workbench first-proof slice. Clean HEAD is 13c90817 Harden Mission Control clean context selection. Build the smallest dry-run/no-effect slice to expose one concrete inspectable missionControl.demoWorkbenchProof record from real local SquidRun answer/surface evidence. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779449480000,
    rawBody: '(ORACLE #59): Received cafe000 checkpoint while referencing prior 13c90817 Harden Mission Control clean context selection. JAMES ACTION: NONE.'
  },
  {
    sender: 'oracle',
    target: 'architect',
    timestampMs: 1779449460000,
    rawBody: '(ORACLE #58): Received 13c90817 checkpoint. Oracle records clean-context selector hardening as committed and clean-head proven: stale_handoff_superseded, completed toolAppActionPlan plus continuityMemoryProof present, demo/workbench nextStep retained, and no live authority change. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'oracle',
    timestampMs: 1779449450000,
    rawBody: '(ARCHITECT #177): Checkpoint: committed #169 clean-context selector hardening as 13c90817 Harden Mission Control clean context selection. Oracle #57 PASS accepted; pre-commit passed. Clean-head proof held. JAMES ACTION: NONE.'
  },
  {
    sender: 'architect',
    target: 'builder',
    timestampMs: 1779449440000,
    rawBody: '(ARCHITECT #176): Checkpoint: committed #169 clean-context selector hardening as 13c90817 Harden Mission Control clean context selection. Oracle #57 PASS accepted; pre-commit passed through the normal hook, including focused context test PASS 2/2 and Mira system map guard PASS. Clean-head proof: worktree clean, HEAD 13c90817, focused context test PASS 2/2, runtime TypeScript noEmit PASS, demo/workbench nextStep retained, and exactly one JAMES ACTION line. JAMES ACTION: NONE.'
  },
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
  ...staleCheckpointSpacerRows,
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
    const commsScript = path.join(root, 'ui', 'scripts', 'hm-comms.js');
    const readHistoryRows = (last) => JSON.parse(execFileSync(process.execPath, [
      commsScript,
      'history',
      '--last',
      String(last),
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).rows;
    const last500Bodies = readHistoryRows(500).map((row) => row.rawBody || '');
    expect(last500Bodies.some((body) => body.includes('(BUILDER #14)'))).toBe(false);
    expect(last500Bodies.some((body) => body.includes('(ARCHITECT #46)'))).toBe(false);
    const last1000Bodies = readHistoryRows(1000).map((row) => row.rawBody || '');
    expect(last1000Bodies.some((body) => body.includes('(BUILDER #14)'))).toBe(true);
    expect(last1000Bodies.some((body) => body.includes('(ARCHITECT #46)'))).toBe(true);
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
        supersededBySourceRef: 'architect#386',
        supersededByCommit: '7ff9fe8d Add Mira internal pane activation attempt seam',
      }),
    }));
    expect(context.missionControl.continuationDecision).toEqual(expect.objectContaining({
      status: 'stale_handoff_superseded',
      preferredSourceRef: 'architect#386',
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
      sourceRef: 'architect#386',
    }));
    expect(context.recentComms.latestContinuationDelegation).toEqual(expect.objectContaining({
      sourceRef: 'architect#386',
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
    expect(context.recentComms.latestCleanContextSelectionCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#176',
      commitHash: '13c90817',
    }));
    expect(context.recentComms.latestCleanContextSelectionOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#58',
      commitHash: '13c90817',
    }));
    expect(context.recentComms.latestDemoWorkbenchProofCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#186',
      commitHash: '48e419b4',
    }));
    expect(context.recentComms.latestDemoWorkbenchProofOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#62',
      commitHash: '48e419b4',
    }));
    expect(context.recentComms.latestWorkbenchSurfaceProofCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#201',
      commitHash: 'c301c1ac',
    }));
    expect(context.recentComms.latestWorkbenchSurfaceProofOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#66',
      commitHash: 'c301c1ac',
    }));
    expect(context.recentComms.latestCommandCardSurfaceCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#235',
      commitHash: '5d119dc6',
    }));
    expect(context.recentComms.latestCommandCardSurfaceOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#74',
      commitHash: '5d119dc6',
    }));
    expect(context.recentComms.latestCommandCardFollowThroughCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#242',
      commitHash: 'df0a47a6',
    }));
    expect(context.recentComms.latestCommandCardFollowThroughOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#77',
      commitHash: 'df0a47a6',
    }));
    expect(context.recentComms.latestCommandCardRoutePlanProofSurfaceCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#260',
      commitHash: '120806b4',
    }));
    expect(context.recentComms.latestCommandCardRoutePlanProofSurfaceOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#84',
      commitHash: '120806b4',
    }));
    expect(context.recentComms.latestInternalRoutePlanningCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#270',
      commitHash: '0cb27b6b',
    }));
    expect(context.recentComms.latestInternalRoutePlanningOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#88',
      commitHash: '0cb27b6b',
    }));
    expect(context.recentComms.latestInternalRoutePromotionPlanSurfaceCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#287',
      commitHash: 'f7352d10',
    }));
    expect(context.recentComms.latestInternalRoutePromotionPlanSurfaceOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#95',
      commitHash: 'f7352d10',
    }));
    expect(context.recentComms.latestInternalRouteAuditPlanningCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#298',
      commitHash: 'c1a05e07',
    }));
    expect(context.recentComms.latestInternalRouteAuditPlanningBuilderAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#90',
      commitHash: 'c1a05e07',
    }));
    expect(context.recentComms.latestInternalRouteAuditPlanningOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#98',
      commitHash: 'c1a05e07',
    }));
    expect(context.recentComms.latestPostAuditPlanningSelectorCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#311',
      commitHash: '582ef1c6',
    }));
    expect(context.recentComms.latestPostAuditPlanningSelectorBuilderAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#94',
      commitHash: '582ef1c6',
    }));
    expect(context.recentComms.latestPostAuditPlanningSelectorOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#101',
      commitHash: '582ef1c6',
    }));
    expect(context.recentComms.latestInternalRouteAuditReviewLaneProofCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#329',
      commitHash: 'b1acd4d7',
    }));
    expect(context.recentComms.latestInternalRouteAuditReviewLaneProofOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#107',
      commitHash: 'b1acd4d7',
    }));
    expect(context.recentComms.latestJamesActionLineDedupCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#372',
      commitHash: '2533ace2',
    }));
    expect(context.recentComms.latestJamesActionLineDedupOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#11',
      commitHash: '2533ace2',
    }));
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#384',
      commitHash: 'cbeb0d2f',
    }));
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#15',
      commitHash: 'cbeb0d2f',
    }));
    expect(context.recentComms.latestContinuationDelegation.sourceRef).not.toBe('architect#304');
    expect(context.recentComms.latestPostAuditPlanningSelectorCheckpoint.sourceRef).not.toBe('architect#314');
    expect(context.recentComms.latestPostAuditPlanningSelectorOracleAck.sourceRef).not.toBe('oracle#102');
    expect(context.recentComms.latestContinuationDelegation.sourceRef).not.toBe('architect#332');
    expect(context.recentComms.latestInternalRouteAuditReviewLaneProofCheckpoint.sourceRef).not.toBe('architect#330');
    expect(context.recentComms.latestInternalRouteAuditReviewLaneProofOracleAck.sourceRef).not.toBe('oracle#108');
    expect(context.recentComms.latestContinuationDelegation.sourceRef).not.toBe('architect#377');
    expect(context.recentComms.latestJamesActionLineDedupCheckpoint.sourceRef).not.toBe('architect#373');
    expect(context.recentComms.latestJamesActionLineDedupCheckpoint.sourceRef).not.toBe('architect#377');
    expect(context.recentComms.latestJamesActionLineDedupOracleAck.sourceRef).not.toBe('oracle#12');
    expect(context.recentComms.latestContinuationDelegation.sourceRef).not.toBe('architect#388');
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint.sourceRef).not.toBe('architect#385');
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint.sourceRef).not.toBe('architect#388');
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateOracleAck.sourceRef).not.toBe('oracle#16');
    expect(answer).toContain('Project/lane: squidrun / architect#386.');
    expect(answer).toContain('Mission Control internal route/audit promotion decision-gate proof is inspectable from mission-control-internal-route-audit-review-lane-proof-v0 only.');
    expect(answer).toContain('Completed direct-channel readiness evidence: checkpoint architect#114 22e876dc and Builder ACK builder#43 22e876dc');
    expect(answer).toContain('next boundary is tool/app action planning from the roadmap, not execution');
    expect(answer).toContain('Completed tool/app action-plan evidence: checkpoint architect#129 5b3e0386 and Builder ACK builder#49 5b3e0386');
    expect(answer).toContain('the tool/app action plan remains completed context');
    expect(answer).toContain('Completed continuity/memory proof evidence: checkpoint architect#156 d0bffd58, Builder ACK builder#56 d0bffd58, and Oracle ACK oracle#50 d0bffd58');
    expect(answer).toContain('continuityMemoryProof remains completed proof-only context while the active next boundary advances to Mission Control demo/workbench proof planning');
    expect(answer).toContain('Demo/workbench proof: mission-control-demo-workbench-proof-v0');
    expect(answer).toContain('Workbench surface proof evidence: checkpoint architect#186 48e419b4 and Oracle ACK oracle#62 48e419b4');
    expect(answer).toContain('demoWorkbenchProof and the c301c1ac surface render proof are completed context for command-card acceptance');
    expect(answer).toContain('Completed internal route/audit planning evidence: checkpoint architect#298 c1a05e07, Builder ACK builder#90 c1a05e07, and Oracle ACK oracle#98 c1a05e07');
    expect(answer).toContain('Completed post-audit selector evidence: checkpoint architect#311 582ef1c6, Builder ACK builder#94 582ef1c6, and Oracle ACK oracle#101 582ef1c6');
    expect(answer).toContain('WIP sanity/status/containment/closure rows are diagnostic only while mission-control-internal-route-promotion-review-plan-v0 remains completed visible context');
    expect(answer).toContain('Command-card acceptance: mission-control-v0-command-card-acceptance');
    expect(answer).toContain('current lane/why it matters=Current lane architect#386 matters');
    expect(answer).toContain('what changed recently=Committed 582ef1c6 post-audit selector evidence (architect#311 plus Builder ACK builder#94 and Oracle ACK oracle#101)');
    expect(answer).toContain('Builder next move=Pin the Mission Control v0 command card from local evidence');
    expect(answer).toContain('Oracle next move=Review the command card for local evidence');
    expect(answer).toContain('Context-card/current dirty-context status: Worktree is clean.');
    expect(answer).toContain('James-action line=NONE; dry-run route plan=Dry-run route plan asks Oracle to review Mission Control v0 command-card fields from local context only');
    expect(answer).not.toContain('Command-card acceptance: mission-control-v0-command-card-acceptance; current lane/why it matters=Current lane architect#386 matters because Mission Control must turn local SquidRun evidence into a James-inspectable command card instead of terminal-log spelunking.; what changed recently=Committed 582ef1c6 post-audit selector evidence (architect#311 plus Builder ACK builder#94 and Oracle ACK oracle#101) keeps the internal route/audit planning lane on the visible plan while WIP sanity/status/containment/closure rows remain diagnostic only.; Builder next move=Pin the Mission Control v0 command card from local evidence.; Oracle next move=Review the command card for local evidence, current-lane status, dirty-context status, exactly one James-action line, and dry-run route plan.; Context-card/current dirty-context status: Worktree is clean.; JAMES ACTION: NONE;');
    expect(answer).toContain('Completed answer-shape closure evidence: checkpoint architect#372 2533ace2 and Oracle acceptance oracle#11 2533ace2; mission-control-internal-route-audit-review-lane-proof-v0 is accepted completed context');
    expect(answer).toContain('active next boundary advances to internal route/audit promotion decision-gate planning from the visible audit-review proof only with James as the explicit control point before any real route/audit promotion');
    expect(answer).toContain('Completed route/audit decision-gate evidence: checkpoint architect#384 cbeb0d2f and Oracle acceptance oracle#15 cbeb0d2f; mission-control-internal-route-audit-promotion-decision-gate-proof-v0 is inspectable from mission-control-internal-route-audit-review-lane-proof-v0 only');
    expect(answer).toContain('Internal route/audit promotion decision-gate proof: mission-control-internal-route-audit-promotion-decision-gate-proof-v0; owner=Builder; target=oracle; purpose=internal route/audit promotion decision-gate review');
    expect(answer).toContain('Route-plan follow-through proof: mission-control-command-card-route-plan-follow-through-v0; target=oracle; purpose=internal-route promotion no-send review');
    expect(answer).toContain('source evidence checkpoint architect#242 df0a47a6 plus Oracle ACK oracle#77 df0a47a6 plus visible-surface checkpoint architect#260 120806b4 and Oracle ACK oracle#84 120806b4');
    expect(answer).toContain('Internal-route promotion/review plan: mission-control-internal-route-promotion-review-plan-v0; owner=Builder; target=oracle; purpose=internal-route promotion no-send review');
    expect(answer).toContain('source evidence checkpoint architect#270 0cb27b6b plus Oracle ACK oracle#88 0cb27b6b plus visible-plan surface checkpoint architect#287 f7352d10 and Oracle ACK oracle#95 f7352d10 plus audit-planning checkpoint architect#298 c1a05e07, Builder ACK builder#90 c1a05e07, and Oracle ACK oracle#98 c1a05e07');
    expect(answer).toContain('Internal route/audit review-lane proof: mission-control-internal-route-audit-review-lane-proof-v0; owner=Builder; target=oracle; purpose=internal route/audit planning review');
    expect(answer).toContain('source evidence checkpoint architect#329 b1acd4d7 plus Oracle ACK oracle#107 b1acd4d7');
    expect(answer).toContain('audit planningOnly=true, manualOnly=true, sendPerformed=false, promotionPerformed=false, routeFlip=false, runtimeExecutes=false');
    expect(answer).toContain('target local_mission_control_answer_surface asks "what is happening here, and what should happen next?"');
    expect(answer).toContain('runtimeStarted=false, browserOpened=false, workbenchOpened=false, uiActionPerformed=false, fetched=false, posted=false, routed=false, sent=false, providerInvoked=false, modelInvoked=false, accountAccessed=false, tokenAccessed=false, credentialAccessed=false, deviceTouched=false, userTargeted=false, externalTargeted=false, deployed=false, moneyMovement=false, tradingTouched=false');
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
    expect(context.missionControl.nextTeamMove).toBe('Oracle should review mission-control-internal-route-audit-promotion-decision-gate-proof-v0 from the visible mission-control-internal-route-audit-review-lane-proof-v0 only; Builder should hold it as local planning-only context unless Oracle requests a narrow correction.');
    expect(context.summary.nextStep).toBe(context.missionControl.nextTeamMove);
    expect(context.summary.nextStep).not.toContain('advance Mission Control v1 dry-run coordination/follow-through route planning');
    expect(context.summary.nextStep).not.toContain('align Mission Control to the existing direct-channel readiness contract');
    expect(context.summary.nextStep).not.toContain('draft one local tool/app action plan');
    expect(context.summary.nextStep).not.toContain('pinning a concise local command card');
    expect(context.summary.nextStep).toContain('mission-control-internal-route-audit-review-lane-proof-v0');
    expect(context.summary.nextStep).toContain('mission-control-internal-route-audit-promotion-decision-gate-proof-v0');
    expect(context.summary.nextStep).not.toContain('sourced restart/current-lane truth');
    expect(context.summary.toolAppActionPlan).toBe('mission-control-tool-app-action-plan-v0: local_squidrun_evidence_review -> Inspect local SquidRun Mission Control evidence and prepare the first app/tool action candidate for James review.; owner Builder; James must explicitly review and approve a separate future request before any real app/tool execution.');
    expect(context.summary.continuityMemoryProof).toBe('mission-control-continuity-memory-proof-v0: current-lane truth architect#11 is loaded_but_stale_superseded; stale-only summary refused=true; James must review and approve a separate future continuity promotion before New Mira imports, copies, writes, restarts, or promotes any memory state.');
    expect(context.summary.demoWorkbenchProof).toBe('mission-control-demo-workbench-proof-v0: local_mission_control_answer_surface asks "what is happening here, and what should happen next?"; owner Builder; James must explicitly review and approve a separate future request before anyone starts runtime, opens a browser/workbench, performs UI/status actions, writes state, POSTs, routes, sends, or executes anything from this proof.');
    expect(context.summary.commandCardAcceptance).toBe('mission-control-v0-command-card-acceptance: completed visible command-card context with current lane card, recent changes, Builder/Oracle next moves, dirty-context status, one James-action line, and dry-run route plan; owner Builder; James can inspect the local command card before any future runtime, browser, workbench, UI/status, route, send, provider/model, credential, deploy, money, or trading action is proposed.');
    expect(context.summary.commandCardRoutePlanFollowThroughProof).toBe('mission-control-command-card-route-plan-follow-through-v0: proof_ready_for_oracle_review; target oracle; purpose internal-route promotion no-send review; James can inspect this local proof before any future route, send, promotion, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.');
    expect(context.summary.internalRoutePromotionReviewPlan).toBe('mission-control-internal-route-promotion-review-plan-v0: planning_only_ready_for_oracle_review; target oracle; purpose internal-route promotion no-send review; James can inspect this local plan before any future promotion, route, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.');
    expect(context.summary.internalRouteAuditPromotionDecisionGateProof).toBe('mission-control-internal-route-audit-promotion-decision-gate-proof-v0: planning_only_ready_for_oracle_review; target oracle; purpose internal route/audit promotion decision-gate review; James must explicitly review and approve a separate future route/audit promotion before any real promotion, route flip, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.');
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
          sourceRef: 'architect#386',
          summary: 'Current Architect delegation keeps internal route/audit planning on the visible plan while 582ef1c6 selector hardening prevents WIP sanity/status/containment/closure rows from becoming active delegation authority.',
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
    expect(context.missionControl.demoWorkbenchProof).toEqual({
      id: 'mission-control-demo-workbench-proof-v0',
      status: 'proof_planning_only',
      owner: 'Builder',
      target: {
        surface: 'local_mission_control_answer_surface',
        question: 'what is happening here, and what should happen next?',
        action: 'Inspect the local Mission Control answer/surface produced from getSquidRunContext without starting runtime, opening a browser, or performing UI/workbench actions.',
      },
      sourceEvidence: [
        {
          kind: 'file',
          path: 'docs/mira-north-star-roadmap.md',
          summary: 'Roadmap names the first inspectable demo as Mission Control answering the current situation and next move from local evidence.',
        },
        {
          kind: 'file',
          path: 'docs/mira-system-map.md',
          summary: 'System map keeps demo/workbench inspection local and blocks runtime/browser/UI/status execution and live effects.',
        },
        {
          kind: 'file',
          path: 'mira/runtime/src/squidrun-context.ts',
          summary: 'SquidRun context source builds the local Mission Control answer, summary, drafts, preview, and proof record.',
        },
        {
          kind: 'completed_context',
          summary: 'Completed context retained: mission-control-tool-app-action-plan-v0 remains planning_only.',
        },
        {
          kind: 'completed_context',
          summary: 'Completed context retained: mission-control-continuity-memory-proof-v0 remains proof_only.',
        },
        {
          kind: 'comms',
          sourceRef: 'architect#176',
          commitHash: '13c90817',
          summary: 'Clean-context selector hardening is committed before exposing this demo/workbench proof record.',
        },
        {
          kind: 'comms',
          sourceRef: 'oracle#58',
          commitHash: '13c90817',
          summary: 'Oracle acknowledged the clean-context selector hardening before this proof record.',
        },
        {
          kind: 'comms',
          sourceRef: 'architect#386',
          summary: 'Current Architect delegation treats this demo/workbench proof and command-card acceptance as completed context for route-plan follow-through proof.',
        },
      ],
      completedContext: {
        toolAppActionPlanId: 'mission-control-tool-app-action-plan-v0',
        continuityMemoryProofId: 'mission-control-continuity-memory-proof-v0',
      },
      expectedJamesVisibleChecks: [
        'The local Mission Control answer names what is happening here from local evidence.',
        'The local Mission Control answer names what should happen next without reviving the stale architect#11 objective.',
        'The summary names this concrete demo/workbench proof record.',
        'The record keeps completed toolAppActionPlan and continuityMemoryProof as context.',
        'The audit flags show planning/proof only and no runtime, browser, workbench, UI, network, send, route, provider, credential, deploy, money, or trading effect.',
        'There is exactly one JAMES ACTION line and it remains NONE.',
      ],
      jamesControlPoint: 'James must explicitly review and approve a separate future request before anyone starts runtime, opens a browser/workbench, performs UI/status actions, writes state, POSTs, routes, sends, or executes anything from this proof.',
      preconditions: [
        'Worktree is clean.',
        'Stale architect#11 is visible but has no active authority.',
        'Completed toolAppActionPlan and continuityMemoryProof are present as context.',
        'Clean-context selector hardening checkpoint and Oracle ACK are source-specific for 13c90817.',
        'The proof is built from local Mission Control answer/surface evidence only.',
      ],
      refusalNoGoConditions: [
        'Dirty worktree or missing completed context records.',
        'Missing source-specific 13c90817 checkpoint or Oracle ACK.',
        'Any request to start runtime, open a browser/workbench, perform UI/status actions, fetch, POST, route, send, call provider/model, touch accounts/tokens/credentials/devices/users/external targets, deploy, move money, or touch trading.',
        'Any attempt to treat this proof record as live action approval.',
      ],
      audit: {
        proofOnly: true,
        planningOnly: true,
        runtimeStarted: false,
        browserOpened: false,
        workbenchOpened: false,
        uiActionPerformed: false,
        fetched: false,
        posted: false,
        routed: false,
        sent: false,
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
    expect(context.missionControl.commandCardAcceptance).toEqual(expect.objectContaining({
      id: 'mission-control-v0-command-card-acceptance',
      status: 'acceptance_planning_only',
      owner: 'Builder',
      completedContext: {
        toolAppActionPlanId: 'mission-control-tool-app-action-plan-v0',
        continuityMemoryProofId: 'mission-control-continuity-memory-proof-v0',
        demoWorkbenchProofId: 'mission-control-demo-workbench-proof-v0',
      },
      cardFields: expect.objectContaining({
        currentLaneWhyItMatters: expect.stringContaining('Current lane architect#386 matters'),
        whatChangedRecently: expect.stringContaining('Committed 582ef1c6 post-audit selector evidence (architect#311 plus Builder ACK builder#94 and Oracle ACK oracle#101)'),
        builderNextMove: expect.stringContaining('Pin the Mission Control v0 command card from local evidence'),
        oracleNextMove: expect.stringContaining('Review the command card for local evidence'),
        contextCardStatus: 'Context-card/current dirty-context status: Worktree is clean.',
        jamesActionLine: 'JAMES ACTION: NONE',
        dryRunRoutePlan: {
          target: 'oracle',
          purpose: 'command-card no-effect review',
          manualExecutionRequired: true,
          sendPerformed: false,
          summary: 'Dry-run route plan asks Oracle to review Mission Control v0 command-card fields from local context only; no hm-send, route flip, POST, provider/model call, or external send is performed.',
        },
      }),
      audit: expect.objectContaining({
        acceptanceOnly: true,
        planningOnly: true,
        runtimeStarted: false,
        browserOpened: false,
        workbenchOpened: false,
        uiActionPerformed: false,
        fetched: false,
        posted: false,
        routed: false,
        sent: false,
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
      }),
    }));
    expect(context.missionControl.commandCardAcceptance.sourceEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#201',
        commitHash: 'c301c1ac',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'oracle#66',
        commitHash: 'c301c1ac',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#386',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#235',
        commitHash: '5d119dc6',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'oracle#74',
        commitHash: '5d119dc6',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#260',
        commitHash: '120806b4',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'oracle#84',
        commitHash: '120806b4',
      }),
    ]));
    expect(context.missionControl.evidence).toEqual(expect.arrayContaining([
      'docs/mira-north-star-roadmap.md',
      'mira/runtime/src/squidrun-context.ts',
      'mira/ui/app.js',
      'mira/ui/index.html',
      'ui/__tests__/mira-runtime-squidrun-context.test.js',
      'ui/__tests__/mira-runtime-ui-read-only-boot.test.js',
      'ui/modules/mira-direct-channel-readiness.js',
      'ui/__tests__/mira-direct-channel-readiness.test.js',
      'ui/modules/mira-core/typed-restart-continuity-context-v0.js',
      'ui/modules/mira-core/mira-presence-runtime-state-v0.js',
      'mira/runtime/src/status.ts',
      'hm-comms history --last 1000 --json',
    ]));
    expect(context.missionControl.coordinationDrafts).toEqual([
      {
        target: 'builder',
        purpose: 'internal route/audit promotion decision-gate proof context',
        message: 'Hold mission-control-internal-route-audit-promotion-decision-gate-proof-v0 as local planning-only context from mission-control-internal-route-audit-review-lane-proof-v0. Do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.',
      },
      {
        target: 'oracle',
        purpose: 'internal route/audit promotion decision-gate proof review',
        message: 'Review mission-control-internal-route-audit-promotion-decision-gate-proof-v0 from the visible mission-control-internal-route-audit-review-lane-proof-v0 only for owner Builder, target Oracle, source evidence, James control point before real promotion, preconditions/no-go conditions, manual-only/no-send/no-promotion/no-route-flip/no-execution audit flags, and exactly one James-action line; do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.',
      },
    ]);
    expect(context.missionControl.internalRoutePreview).toEqual(expect.objectContaining({
      status: 'reviewed_preview_only',
      selectedDraftTarget: 'oracle',
      selectedDraftPurpose: 'internal route/audit promotion decision-gate proof review',
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
          content: 'Review mission-control-internal-route-audit-promotion-decision-gate-proof-v0 from the visible mission-control-internal-route-audit-review-lane-proof-v0 only for owner Builder, target Oracle, source evidence, James control point before real promotion, preconditions/no-go conditions, manual-only/no-send/no-promotion/no-route-flip/no-execution audit flags, and exactly one James-action line; do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.',
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
    expect(context.missionControl.commandCardRoutePlanFollowThroughProof).toEqual(expect.objectContaining({
      id: 'mission-control-command-card-route-plan-follow-through-v0',
      status: 'proof_ready_for_oracle_review',
      owner: 'Builder',
      completedContext: {
        commandCardAcceptanceId: 'mission-control-v0-command-card-acceptance',
      },
      routePlan: {
        target: 'oracle',
        purpose: 'internal-route promotion no-send review',
        message: 'Review the internal-route promotion/review plan from the visible mission-control-command-card-route-plan-follow-through-v0 proof for source evidence, manual review boundary, no-send, no-promotion, no-route-flip, no-execution, and exactly one James-action line; do not POST, route, send, promote, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.',
        body: 'Review the internal-route promotion/review plan from the visible mission-control-command-card-route-plan-follow-through-v0 proof for source evidence, manual review boundary, no-send, no-promotion, no-route-flip, no-execution, and exactly one James-action line; do not POST, route, send, promote, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.',
        manualExecutionRequired: true,
        runtimeExecutes: false,
        sendPerformed: false,
      },
      jamesControlPoint: 'James can inspect this local proof before any future route, send, promotion, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.',
      audit: expect.objectContaining({
        proofOnly: true,
        planningOnly: true,
        runtimeStarted: false,
        browserOpened: false,
        workbenchOpened: false,
        uiActionPerformed: false,
        fetched: false,
        posted: false,
        routed: false,
        sent: false,
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
      }),
    }));
    expect(context.missionControl.commandCardRoutePlanFollowThroughProof.sourceEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'completed_context',
        summary: 'Completed context retained: mission-control-v0-command-card-acceptance remains acceptance_planning_only.',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#386',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#242',
        commitHash: 'df0a47a6',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'oracle#77',
        commitHash: 'df0a47a6',
      }),
      expect.objectContaining({
        kind: 'summary',
        summary: 'Existing command-card route-plan proof target=oracle, purpose=internal-route promotion no-send review, manualExecutionRequired=true, runtimeExecutes=false.',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#260',
        commitHash: '120806b4',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'oracle#84',
        commitHash: '120806b4',
      }),
    ]));
    expect(context.missionControl.internalRoutePromotionReviewPlan).toEqual(expect.objectContaining({
      id: 'mission-control-internal-route-promotion-review-plan-v0',
      status: 'planning_only_ready_for_oracle_review',
      owner: 'Builder',
      completedContext: {
        commandCardAcceptanceId: 'mission-control-v0-command-card-acceptance',
        commandCardRoutePlanFollowThroughProofId: 'mission-control-command-card-route-plan-follow-through-v0',
      },
      target: {
        role: 'oracle',
        purpose: 'internal-route promotion no-send review',
        message: 'Review the internal-route promotion/review plan from the visible mission-control-command-card-route-plan-follow-through-v0 proof for source evidence, manual review boundary, no-send, no-promotion, no-route-flip, no-execution, and exactly one James-action line; do not POST, route, send, promote, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.',
        body: 'Review the internal-route promotion/review plan from the visible mission-control-command-card-route-plan-follow-through-v0 proof for source evidence, manual review boundary, no-send, no-promotion, no-route-flip, no-execution, and exactly one James-action line; do not POST, route, send, promote, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.',
        manualExecutionRequired: true,
        runtimeExecutes: false,
        sendPerformed: false,
        promotionPerformed: false,
        routeFlip: false,
      },
      jamesControlPoint: 'James can inspect this local plan before any future promotion, route, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.',
      audit: expect.objectContaining({
        planningOnly: true,
        manualOnly: true,
        sendPerformed: false,
        promotionPerformed: false,
        routeFlip: false,
        runtimeExecutes: false,
        runtimeStarted: false,
        browserOpened: false,
        workbenchOpened: false,
        uiActionPerformed: false,
        fetched: false,
        posted: false,
        routed: false,
        sent: false,
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
      }),
    }));
    expect(context.missionControl.internalRoutePromotionReviewPlan.sourceEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'completed_context',
        summary: 'Completed context retained: mission-control-v0-command-card-acceptance remains acceptance_planning_only.',
      }),
      expect.objectContaining({
        kind: 'completed_context',
        summary: 'Completed context retained: mission-control-command-card-route-plan-follow-through-v0 remains proof_ready_for_oracle_review.',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#386',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#270',
        commitHash: '0cb27b6b',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'oracle#88',
        commitHash: '0cb27b6b',
      }),
      expect.objectContaining({
        kind: 'summary',
        summary: 'The plan is derived from the visible mission-control-command-card-route-plan-follow-through-v0 proof only.',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#298',
        commitHash: 'c1a05e07',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'builder#90',
        commitHash: 'c1a05e07',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'oracle#98',
        commitHash: 'c1a05e07',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#311',
        commitHash: '582ef1c6',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'builder#94',
        commitHash: '582ef1c6',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'oracle#101',
        commitHash: '582ef1c6',
      }),
    ]));
    expect(context.missionControl.internalRouteAuditPromotionDecisionGateProof).toEqual(expect.objectContaining({
      id: 'mission-control-internal-route-audit-promotion-decision-gate-proof-v0',
      status: 'planning_only_ready_for_oracle_review',
      owner: 'Builder',
      decisionGate: expect.objectContaining({
        target: 'oracle',
        reviewer: 'oracle',
        purpose: 'internal route/audit promotion decision-gate review',
        sourceProofId: 'mission-control-internal-route-audit-review-lane-proof-v0',
        manualExecutionRequired: true,
        runtimeExecutes: false,
        sendPerformed: false,
        promotionPerformed: false,
        routeFlip: false,
      }),
      completedContext: {
        commandCardAcceptanceId: 'mission-control-v0-command-card-acceptance',
        commandCardRoutePlanFollowThroughProofId: 'mission-control-command-card-route-plan-follow-through-v0',
        internalRoutePromotionReviewPlanId: 'mission-control-internal-route-promotion-review-plan-v0',
        internalRouteAuditReviewLaneProofId: 'mission-control-internal-route-audit-review-lane-proof-v0',
      },
      jamesControlPoint: 'James must explicitly review and approve a separate future route/audit promotion before any real promotion, route flip, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.',
      audit: expect.objectContaining({
        planningOnly: true,
        manualOnly: true,
        sendPerformed: false,
        promotionPerformed: false,
        routeFlip: false,
        runtimeExecutes: false,
        runtimeStarted: false,
        browserOpened: false,
        workbenchOpened: false,
        uiActionPerformed: false,
        fetched: false,
        posted: false,
        routed: false,
        sent: false,
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
      }),
    }));
    expect(context.missionControl.internalRouteAuditPromotionDecisionGateProof.sourceEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'completed_context',
        summary: 'Completed context retained: mission-control-internal-route-audit-review-lane-proof-v0 remains planning_only_ready_for_oracle_review.',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#386',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'architect#384',
        commitHash: 'cbeb0d2f',
      }),
      expect.objectContaining({
        kind: 'comms',
        sourceRef: 'oracle#15',
        commitHash: 'cbeb0d2f',
      }),
      expect.objectContaining({
        kind: 'summary',
        summary: 'The proof is derived from mission-control-internal-route-audit-review-lane-proof-v0 only and is not a route promotion request.',
      }),
    ]));
    expect(context.summary.happening).toContain('continuation-aware Mission Control command context');
    expect(context.summary.happening).not.toContain('finish the existing 3-file review/no-send gate dirty slice');
    expect(answer.match(/^JAMES ACTION:/gm)).toHaveLength(1);
    expect(answer.match(/JAMES ACTION:/g)).toHaveLength(1);
    expect(context.missionControl.commandCardAcceptance.cardFields.jamesActionLine).toBe('JAMES ACTION: NONE');
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
        sourceRef: 'architect#386',
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
    expect(context.recentComms.latestCleanContextSelectionCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#176',
      commitHash: '13c90817',
    }));
    expect(context.recentComms.latestCleanContextSelectionOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#58',
      commitHash: '13c90817',
    }));
    expect(context.recentComms.latestDemoWorkbenchProofCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#186',
      commitHash: '48e419b4',
    }));
    expect(context.recentComms.latestDemoWorkbenchProofOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#62',
      commitHash: '48e419b4',
    }));
    expect(context.recentComms.latestWorkbenchSurfaceProofCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#201',
      commitHash: 'c301c1ac',
    }));
    expect(context.recentComms.latestWorkbenchSurfaceProofOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#66',
      commitHash: 'c301c1ac',
    }));
    expect(context.recentComms.latestCommandCardSurfaceCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#235',
      commitHash: '5d119dc6',
    }));
    expect(context.recentComms.latestCommandCardSurfaceOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#74',
      commitHash: '5d119dc6',
    }));
    expect(context.recentComms.latestCommandCardFollowThroughCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#242',
      commitHash: 'df0a47a6',
    }));
    expect(context.recentComms.latestCommandCardFollowThroughOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#77',
      commitHash: 'df0a47a6',
    }));
    expect(context.recentComms.latestInternalRoutePlanningCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#270',
      commitHash: '0cb27b6b',
    }));
    expect(context.recentComms.latestInternalRoutePlanningOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#88',
      commitHash: '0cb27b6b',
    }));
    expect(context.recentComms.latestPostAuditPlanningSelectorCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#311',
      commitHash: '582ef1c6',
    }));
    expect(context.recentComms.latestPostAuditPlanningSelectorBuilderAck).toEqual(expect.objectContaining({
      sourceRef: 'builder#94',
      commitHash: '582ef1c6',
    }));
    expect(context.recentComms.latestPostAuditPlanningSelectorOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#101',
      commitHash: '582ef1c6',
    }));
    expect(context.recentComms.latestInternalRouteAuditReviewLaneProofCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#329',
      commitHash: 'b1acd4d7',
    }));
    expect(context.recentComms.latestInternalRouteAuditReviewLaneProofOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#107',
      commitHash: 'b1acd4d7',
    }));
    expect(context.recentComms.latestJamesActionLineDedupCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#372',
      commitHash: '2533ace2',
    }));
    expect(context.recentComms.latestJamesActionLineDedupOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#11',
      commitHash: '2533ace2',
    }));
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint).toEqual(expect.objectContaining({
      sourceRef: 'architect#384',
      commitHash: 'cbeb0d2f',
    }));
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateOracleAck).toEqual(expect.objectContaining({
      sourceRef: 'oracle#15',
      commitHash: 'cbeb0d2f',
    }));
    expect(context.recentComms.latestContinuationDelegation.sourceRef).not.toBe('architect#304');
    expect(context.recentComms.latestContinuationDelegation.sourceRef).not.toBe('architect#332');
    expect(context.recentComms.latestContinuationDelegation.sourceRef).not.toBe('architect#388');
    expect(context.recentComms.latestInternalRouteAuditReviewLaneProofCheckpoint.sourceRef).not.toBe('architect#330');
    expect(context.recentComms.latestInternalRouteAuditReviewLaneProofOracleAck.sourceRef).not.toBe('oracle#108');
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint.sourceRef).not.toBe('architect#385');
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint.sourceRef).not.toBe('architect#388');
    expect(context.recentComms.latestInternalRoutePromotionDecisionGateOracleAck.sourceRef).not.toBe('oracle#16');
    expect(context.missionControl.continuationDecision).toEqual(expect.objectContaining({
      status: 'current_handoff',
      preferredSourceRef: 'architect#386',
      staleSourceRef: null,
    }));
    expect(context.lane.staleHandoff).toBeNull();
    expect(context.summary.happening).toContain('finish the existing 3-file review/no-send gate dirty slice');
    expect(context.summary.nextStep).not.toContain('tool/app action plan');
    expect(context.summary.nextStep).not.toContain('continuity/memory proof');
    expect(context.summary.nextStep).not.toContain('demo/workbench proof');
    expect(context.summary.nextStep).not.toContain('workbench Mission Control section renders');
    expect(context.summary.nextStep).not.toContain('command card');
    expect(context.summary.nextStep).not.toContain('route-plan review/follow-through');
    expect(context.summary.nextStep).not.toContain('internal route/audit promotion decision-gate');
    expect(context.summary.toolAppActionPlan).toBeNull();
    expect(context.summary.continuityMemoryProof).toBeNull();
    expect(context.summary.demoWorkbenchProof).toBeNull();
    expect(context.summary.commandCardAcceptance).toBeNull();
    expect(context.summary.commandCardRoutePlanFollowThroughProof).toBeNull();
    expect(context.summary.internalRoutePromotionReviewPlan).toBeNull();
    expect(context.summary.internalRouteAuditReviewLaneProof).toBeNull();
    expect(context.summary.internalRouteAuditPromotionDecisionGateProof).toBeNull();
    expect(context.missionControl.toolAppActionPlan).toBeNull();
    expect(context.missionControl.continuityMemoryProof).toBeNull();
    expect(context.missionControl.demoWorkbenchProof).toBeNull();
    expect(context.missionControl.commandCardAcceptance).toBeNull();
    expect(context.missionControl.commandCardRoutePlanFollowThroughProof).toBeNull();
    expect(context.missionControl.internalRoutePromotionReviewPlan).toBeNull();
    expect(context.missionControl.internalRouteAuditReviewLaneProof).toBeNull();
    expect(context.missionControl.internalRouteAuditPromotionDecisionGateProof).toBeNull();
    expect(answer).toContain('Dirty work: 1 changed file(s)');
    expect(answer).not.toContain('Tool/app action plan: local_squidrun_evidence_review');
    expect(answer).not.toContain('Completed tool/app action plan context: local_squidrun_evidence_review');
    expect(answer).not.toContain('Continuity and memory is the next map boundary');
    expect(answer).not.toContain('First inspectable Mission Control demo/workbench proof planning is the next map boundary');
    expect(answer).not.toContain('Demo/workbench proof: mission-control-demo-workbench-proof-v0');
    expect(answer).not.toContain('Command-card acceptance: mission-control-v0-command-card-acceptance');
    expect(answer).not.toContain('Route-plan follow-through proof: mission-control-command-card-route-plan-follow-through-v0');
    expect(answer).not.toContain('Internal-route promotion/review plan: mission-control-internal-route-promotion-review-plan-v0');
    expect(answer).not.toContain('Internal route/audit review-lane proof: mission-control-internal-route-audit-review-lane-proof-v0');
    expect(answer).not.toContain('Internal route/audit promotion decision-gate proof: mission-control-internal-route-audit-promotion-decision-gate-proof-v0');
    expect(answer).not.toContain('Continuity/memory proof: mission-control-continuity-memory-proof-v0');
    expect(answer).not.toContain('Completed continuity/memory proof evidence: checkpoint architect#156 d0bffd58');
    expect(answer).not.toContain('Oracle ACK oracle#50 d0bffd58');
    expect(answer).not.toContain('Stale handoff: architect#11');
    expect(answer.match(/^JAMES ACTION:/gm)).toHaveLength(1);
    expect(answer.match(/JAMES ACTION:/g)).toHaveLength(1);
  });
});
