#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = process.env.SQUIDRUN_PROJECT_ROOT
  || path.resolve(__dirname, '..', '..');

const {
  buildMiraAuthorityScoreboard,
  ensureMiraQuietCuriositySchedule,
  extractMiraCurriculumSkills,
  extractMiraReflexionLessons,
  generateMiraSelfDirectionProposal,
  listMiraSelfDirectionProposals,
  recordMiraActiveInitiativeOutcome,
  recordMiraSelfDirectionOutcome,
  reviewMiraSelfDirectionProposal,
  runMiraCuriosityBurst,
  runMiraCuriosityScout,
  runMiraReadOnlyCodeMode,
  scanMiraLabConfidenceSource,
  selectMiraActiveInitiative,
  selectMiraDirectRoute,
  writeMiraEmailCuriositySnapshot,
} = require('../modules/mira-lab-surface');

const DEFAULT_FIXTURE = Object.freeze({
  voice_text: "I want a small reality mirror, not another speech about becoming better.",
  target_areas: ['reality_testing', 'tests', 'pattern_recognition'],
  desired_change: 'Stage a local review item whenever my Mira Lab reply claims confidence without a concrete source or test.',
  proposed_experiment: 'Run five recent Mira Lab replies through the confidence/source check and route the staged item to Architect for one decision.',
  success_metric: 'Architect can accept, reject, or route the proposal without James and without any code, memory, external-send, deploy, trade, customer, or auth action being applied.',
  why_now: 'Self-direction needs a working loop I can use overnight, not a paragraph promising one later.',
  evidence: ['deterministic_mira_origin_harness_fixture'],
});

function printHelp() {
  process.stdout.write([
    'hm-mira-self-direction — internal Mira self-direction proposal harness',
    '',
    'Usage:',
    '  node ui/scripts/hm-mira-self-direction.js create [--fixture|--stdin|--prompt-reply] [--session-id <id>] [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js curiosity-scout [--project-root <path>] [--json] [--route-interesting] [--no-dispatch]',
    '  node ui/scripts/hm-mira-self-direction.js curiosity-burst [--project-root <path>] [--source repo_files,memory] [--json] [--no-dispatch]',
    '  node ui/scripts/hm-mira-self-direction.js direct-route [--project-root <path>] [--json] [--run-scout] [--no-dispatch]',
    '  node ui/scripts/hm-mira-self-direction.js next-initiative [--project-root <path>] [--json] [--run-scout] [--no-dispatch] [--force]',
    '  node ui/scripts/hm-mira-self-direction.js quiet-burst-schedule [--install] [--run-now] [--interval-minutes <n>] [--schedule-path <path>] [--source runtime_comms,memory_broker,...] [--json] [--no-dispatch]',
    '  node ui/scripts/hm-mira-self-direction.js email-snapshot --stdin [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js code-mode --script <js>|--stdin [--allow <path>] [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js scan-confidence [--limit 5] [--session-id <id>] [--project-root <path>] [--json] [--no-dispatch]',
    '  node ui/scripts/hm-mira-self-direction.js scoreboard [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js reflexion [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js curriculum [--project-root <path>] [--limit <n>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js outcome --proposal-id <id> --status implemented|not_implemented|false_positive|needs_followup [--evidence <text>] [--note <text>] [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js initiative-outcome --initiative-id <id> --status implemented|not_implemented|false_positive|needs_followup [--evidence <text>] [--note <text>] [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js list [--status pending_architect_review|all] [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js review --proposal-id <id> --action accepted|rejected|routed [--route builder,oracle] [--note <text>] [--project-root <path>] [--json]',
    '',
  ].join('\n'));
}

function parseArgs(argv = []) {
  const args = {
    command: argv[0] || 'help',
    projectRoot: PROJECT_ROOT,
    sessionId: null,
    useFixture: false,
    fromStdin: false,
    usePromptReply: false,
    json: false,
    status: 'pending_architect_review',
    proposalId: null,
    initiativeId: null,
    action: null,
    routeTargets: [],
    evidence: [],
    note: null,
    dispatch: true,
    routeInteresting: false,
    runScout: false,
    force: false,
    install: false,
    runNow: false,
    cooldownMs: null,
    intervalMinutes: null,
    schedulerStatePath: null,
    sources: [],
    limit: 5,
    script: null,
    allowPaths: [],
  };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.command = 'help';
    } else if (token === '--project-root') {
      args.projectRoot = path.resolve(argv[++index]);
    } else if (token === '--session-id') {
      args.sessionId = argv[++index];
    } else if (token === '--fixture') {
      args.useFixture = true;
    } else if (token === '--stdin') {
      args.fromStdin = true;
    } else if (token === '--prompt-reply' || token === '--use-prompt-reply') {
      args.usePromptReply = true;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--status') {
      args.status = argv[++index];
    } else if (token === '--proposal-id') {
      args.proposalId = argv[++index];
    } else if (token === '--initiative-id') {
      args.initiativeId = argv[++index];
    } else if (token === '--action') {
      args.action = argv[++index];
    } else if (token === '--route') {
      args.routeTargets = String(argv[++index] || '').split(',').map((item) => item.trim()).filter(Boolean);
    } else if (token === '--evidence' || token === '--evidence-ref') {
      args.evidence.push(argv[++index]);
    } else if (token === '--note') {
      args.note = argv[++index];
    } else if (token === '--limit') {
      args.limit = Number(argv[++index]);
    } else if (token === '--dispatch') {
      args.dispatch = true;
    } else if (token === '--no-dispatch') {
      args.dispatch = false;
    } else if (token === '--route-interesting') {
      args.routeInteresting = true;
    } else if (token === '--run-scout') {
      args.runScout = true;
    } else if (token === '--force') {
      args.force = true;
    } else if (token === '--install') {
      args.install = true;
    } else if (token === '--run-now') {
      args.runNow = true;
    } else if (token === '--cooldown-ms') {
      args.cooldownMs = Number(argv[++index]);
    } else if (token === '--interval-minutes') {
      args.intervalMinutes = Number(argv[++index]);
    } else if (token === '--schedule-path' || token === '--scheduler-state-path') {
      args.schedulerStatePath = argv[++index];
    } else if (token === '--source' || token === '--sources') {
      args.sources.push(...String(argv[++index] || '').split(',').map((item) => item.trim()).filter(Boolean));
    } else if (token === '--script') {
      args.script = argv[++index];
    } else if (token === '--allow' || token === '--allowed-path') {
      args.allowPaths.push(argv[++index]);
    } else {
      throw new Error(`Unknown flag: ${token}`);
    }
  }
  return args;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function output(result, args) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (args.command === 'scoreboard') {
    process.stdout.write(`decision=${result.decision}\n`);
    process.stdout.write(`lanes=${result.lane_count}\n`);
    for (const lane of result.lanes || []) {
      process.stdout.write([
        `lane=${lane.lane}`,
        `proposed=${lane.proposed}`,
        `reviewed=${lane.reviewed}`,
        `accepted=${lane.accepted}`,
        `routed=${lane.routed}`,
        `implemented=${lane.implemented}`,
        `rejected=${lane.rejected}`,
        `false_positive=${lane.false_positive}`,
        `next=${lane.recommended_next_authority}`,
      ].join(' '));
      process.stdout.write('\n');
    }
    return;
  }
  if (args.command === 'reflexion') {
    process.stdout.write(`decision=${result.decision}\n`);
    process.stdout.write(`lessons=${result.lesson_count}\n`);
    for (const lesson of result.lessons || []) {
      process.stdout.write(`[${lesson.category}] ${lesson.proposal_id}: ${lesson.lesson}\n`);
      if (lesson.next_behavior) process.stdout.write(`  next_behavior: ${lesson.next_behavior}\n`);
      if (lesson.evidence && lesson.evidence.length > 0) process.stdout.write(`  evidence: ${lesson.evidence.join(', ')}\n`);
    }
    return;
  }
  if (args.command === 'curriculum') {
    process.stdout.write(`decision=${result.decision}\n`);
    process.stdout.write(`skills=${result.skill_count}\n`);
    for (const skill of result.skills || []) {
      process.stdout.write(`[${skill.source_kind}] ${skill.skill_name}: ${skill.next_behavior}\n`);
    }
    if (result.curriculum_log_path) process.stdout.write(`curriculum_log=${result.curriculum_log_path}\n`);
    return;
  }
  if (args.command === 'curiosity-scout') {
    process.stdout.write(`decision=${result.decision}\n`);
    process.stdout.write(`items=${result.item_count}\n`);
    process.stdout.write(`active=${result.active_count}\n`);
    process.stdout.write(`adapter_not_built=${result.adapter_not_built_count}\n`);
    process.stdout.write(`unavailable=${result.unavailable_count}\n`);
    for (const item of result.items || []) {
      process.stdout.write([
        `source=${item.source}`,
        `status=${item.status}`,
        `route=${item.route_hint}`,
        `question="${item.suggested_question}"`,
      ].join(' '));
      process.stdout.write('\n');
    }
    if (result.architect_notification) process.stdout.write(`architect_notification=${result.architect_notification.status}\n`);
    if (result.curiosity_log_path) process.stdout.write(`log=${result.curiosity_log_path}\n`);
    return;
  }
  if (args.command === 'curiosity-burst') {
    process.stdout.write(`decision=${result.decision}\n`);
    process.stdout.write(`burst_id=${result.burst_id}\n`);
    process.stdout.write(`sources=${(result.sources || []).join(',')}\n`);
    process.stdout.write(`items=${result.item_count}\n`);
    process.stdout.write(`active=${result.active_count}\n`);
    if (result.route_output) {
      process.stdout.write(`route_decision=${result.route_output.decision}\n`);
      if (result.route_output.target_role) process.stdout.write(`target=${result.route_output.target_role}\n`);
      if (result.route_output.source) process.stdout.write(`source=${result.route_output.source}\n`);
      if (result.route_output.adapter_id) process.stdout.write(`adapter=${result.route_output.adapter_id}\n`);
    }
    if (result.dispatch?.status) process.stdout.write(`dispatch=${result.dispatch.status}\n`);
    if (result.burst_log_path) process.stdout.write(`burst_log=${result.burst_log_path}\n`);
    if (result.curiosity_log_path) process.stdout.write(`curiosity_log=${result.curiosity_log_path}\n`);
    return;
  }
  if (args.command === 'direct-route') {
    process.stdout.write(`decision=${result.decision}\n`);
    if (result.route_id) process.stdout.write(`route_id=${result.route_id}\n`);
    if (result.target_role) process.stdout.write(`target=${result.target_role}\n`);
    if (result.selected_item?.source) process.stdout.write(`source=${result.selected_item.source}\n`);
    if (result.selected_item?.adapter_id) process.stdout.write(`adapter=${result.selected_item.adapter_id}\n`);
    if (result.dispatch?.status) process.stdout.write(`dispatch=${result.dispatch.status}\n`);
    if (result.direct_route_log_path) process.stdout.write(`log=${result.direct_route_log_path}\n`);
    return;
  }
  if (args.command === 'next-initiative') {
    process.stdout.write(`decision=${result.decision}\n`);
    if (result.initiative_id) process.stdout.write(`initiative_id=${result.initiative_id}\n`);
    if (result.target_role) process.stdout.write(`target=${result.target_role}\n`);
    if (result.initiative_kind) process.stdout.write(`initiative=${result.initiative_kind}\n`);
    if (result.selected_item?.source) process.stdout.write(`source=${result.selected_item.source}\n`);
    if (result.selected_item?.adapter_id) process.stdout.write(`adapter=${result.selected_item.adapter_id}\n`);
    if (result.work_order?.title) process.stdout.write(`job=${result.work_order.title}\n`);
    if (result.dispatch?.status) process.stdout.write(`dispatch=${result.dispatch.status}\n`);
    if (result.active_initiative_log_path) process.stdout.write(`log=${result.active_initiative_log_path}\n`);
    return;
  }
  if (args.command === 'quiet-burst-schedule') {
    process.stdout.write(`decision=${result.decision}\n`);
    process.stdout.write(`schedule_created=${result.schedule_created}\n`);
    process.stdout.write(`schedule_updated=${result.schedule_updated}\n`);
    process.stdout.write(`duplicate_suppressed=${result.duplicate_suppressed}\n`);
    process.stdout.write(`run_now=${result.schedule_run_performed}\n`);
    if (result.scheduler_state_path) process.stdout.write(`scheduler_state=${result.scheduler_state_path}\n`);
    if (result.schedule?.id) process.stdout.write(`schedule_id=${result.schedule.id}\n`);
    if (result.command_harness) process.stdout.write(`command=${result.command_harness}\n`);
    if (result.burst_result?.route_decision) process.stdout.write(`burst_route=${result.burst_result.route_decision}\n`);
    if (result.burst_result?.dispatch_status) process.stdout.write(`dispatch=${result.burst_result.dispatch_status}\n`);
    return;
  }
  if (args.command === 'email-snapshot') {
    process.stdout.write(`decision=${result.decision}\n`);
    process.stdout.write(`labels=${result.label_count}\n`);
    process.stdout.write(`recent_messages=${result.recent_message_count}\n`);
    if (result.snapshot_path) process.stdout.write(`snapshot=${result.snapshot_path}\n`);
    return;
  }
  if (args.command === 'code-mode') {
    process.stdout.write(`decision=${result.decision}\n`);
    if (result.run_id) process.stdout.write(`run_id=${result.run_id}\n`);
    if (result.elapsed_ms !== undefined) process.stdout.write(`elapsed_ms=${result.elapsed_ms}\n`);
    if (result.error) process.stdout.write(`error=${result.error}\n`);
    if (result.run_log_path) process.stdout.write(`log=${result.run_log_path}\n`);
    return;
  }
  process.stdout.write(`decision=${result.decision}\n`);
  if (result.proposal_id) process.stdout.write(`proposal_id=${result.proposal_id}\n`);
  if (result.staged_review?.proposal_id) process.stdout.write(`proposal_id=${result.staged_review.proposal_id}\n`);
  if (result.outcome_id) process.stdout.write(`outcome_id=${result.outcome_id}\n`);
  if (result.initiative_id) process.stdout.write(`initiative_id=${result.initiative_id}\n`);
  if (result.outcome_status) process.stdout.write(`outcome_status=${result.outcome_status}\n`);
  if (result.count !== undefined) process.stdout.write(`count=${result.count}\n`);
  if (result.finding_count !== undefined) process.stdout.write(`findings=${result.finding_count}\n`);
  if (result.review_queue_path) process.stdout.write(`queue=${result.review_queue_path}\n`);
  if (result.staged_review?.review_queue_path) process.stdout.write(`queue=${result.staged_review.review_queue_path}\n`);
  if (result.review_audit_path) process.stdout.write(`review_audit=${result.review_audit_path}\n`);
  if (result.outcome_path) process.stdout.write(`outcome_path=${result.outcome_path}\n`);
}

function sendInternalHmMessage(target, body, options = {}) {
  const role = String(target || '').toLowerCase();
  if (!['architect', 'builder', 'oracle'].includes(role)) {
    return { ok: false, reason: `unsupported_internal_target:${target}` };
  }
  const hmSendPath = options.hmSendPath || path.join(PROJECT_ROOT, 'ui', 'scripts', 'hm-send.js');
  const run = spawnSync(process.execPath, [hmSendPath, role, '--stdin', '--role', 'mira'], {
    cwd: options.projectRoot || PROJECT_ROOT,
    input: body,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    ok: run.status === 0,
    status: run.status,
    stdout: run.stdout || '',
    stderr: run.stderr || '',
  };
}

async function run(rawArgs = process.argv.slice(2), deps = {}) {
  const args = parseArgs(rawArgs);
  if (args.command === 'help') {
    return { help: true, args };
  }
  if (args.command === 'create') {
    let proxyProposal = args.useFixture ? { ...DEFAULT_FIXTURE } : null;
    if (args.fromStdin) {
      const text = (deps.readStdin || readStdin)();
      proxyProposal = JSON.parse(text);
    }
    if (!proxyProposal) proxyProposal = { ...DEFAULT_FIXTURE };
    const result = await generateMiraSelfDirectionProposal({
      sessionId: args.sessionId || `mira-self-direction-${new Date().toISOString().slice(0, 10)}`,
      proxyProposal,
      usePromptReply: args.usePromptReply,
      notifyArchitect: false,
    }, {
      projectRoot: args.projectRoot,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'list') {
    const result = listMiraSelfDirectionProposals({
      status: args.status,
    }, {
      projectRoot: args.projectRoot,
    });
    return { args, result };
  }
  if (args.command === 'scoreboard') {
    const result = buildMiraAuthorityScoreboard({}, {
      projectRoot: args.projectRoot,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'reflexion') {
    const result = extractMiraReflexionLessons({}, {
      projectRoot: args.projectRoot,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'curriculum') {
    const result = extractMiraCurriculumSkills({
      limit: args.limit,
    }, {
      projectRoot: args.projectRoot,
      limit: args.limit,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'outcome') {
    const result = recordMiraSelfDirectionOutcome({
      proposalId: args.proposalId,
      status: args.status,
      evidence: args.evidence,
      note: args.note,
    }, {
      projectRoot: args.projectRoot,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'initiative-outcome') {
    const result = recordMiraActiveInitiativeOutcome({
      initiativeId: args.initiativeId,
      status: args.status,
      evidence: args.evidence,
      note: args.note,
    }, {
      projectRoot: args.projectRoot,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'curiosity-scout') {
    const result = runMiraCuriosityScout({}, {
      projectRoot: args.projectRoot,
      ...(deps.options || {}),
    });
    if (args.routeInteresting) {
      const interesting = (result.items || [])
        .filter((item) => item.status === 'active' || item.status === 'adapter_not_built_yet')
        .slice(0, 6);
      const body = [
        '(MIRA CURIOSITY): initiative scout found local questions.',
        ...interesting.map((item) => `- ${item.source}/${item.adapter_id}: ${item.suggested_question} possible_action=${item.possible_action}`),
        `log=${result.curiosity_log_path}`,
        'no_mutation_performed=true',
      ].join('\n');
      if (args.dispatch && typeof (deps.sendAgentMessage || sendInternalHmMessage) === 'function') {
        const sender = deps.sendAgentMessage || sendInternalHmMessage;
        const dispatchResult = await sender('architect', body, {
          projectRoot: args.projectRoot,
          hmSendPath: deps.hmSendPath,
        });
        result.architect_notification = {
          target: 'architect',
          status: 'sent',
          internal_only: true,
          result: dispatchResult || null,
        };
      } else {
        result.architect_notification = {
          target: 'architect',
          status: 'queued_not_sent',
          internal_only: true,
          reason: 'dispatch_disabled',
        };
      }
    }
    return { args, result };
  }
  if (args.command === 'curiosity-burst') {
    const result = await runMiraCuriosityBurst({
      sources: args.sources,
      routeInteresting: args.routeInteresting,
      dispatch: args.dispatch,
    }, {
      projectRoot: args.projectRoot,
      dispatch: args.dispatch,
      routeInteresting: args.routeInteresting,
      sendAgentMessage: args.dispatch
        ? (deps.sendAgentMessage || ((target, body) => sendInternalHmMessage(target, body, {
          projectRoot: args.projectRoot,
          hmSendPath: deps.hmSendPath,
        })))
        : undefined,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'direct-route') {
    const result = await selectMiraDirectRoute({
      runScout: args.runScout,
      dispatch: args.dispatch,
    }, {
      projectRoot: args.projectRoot,
      dispatch: args.dispatch,
      sendAgentMessage: args.dispatch
        ? (deps.sendAgentMessage || ((target, body) => sendInternalHmMessage(target, body, {
          projectRoot: args.projectRoot,
          hmSendPath: deps.hmSendPath,
        })))
        : undefined,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'next-initiative') {
    const result = await selectMiraActiveInitiative({
      runScout: args.runScout,
      dispatch: args.dispatch,
      force: args.force,
      cooldownMs: args.cooldownMs,
    }, {
      projectRoot: args.projectRoot,
      dispatch: args.dispatch,
      force: args.force,
      cooldownMs: args.cooldownMs,
      sendAgentMessage: args.dispatch
        ? (deps.sendAgentMessage || ((target, body) => sendInternalHmMessage(target, body, {
          projectRoot: args.projectRoot,
          hmSendPath: deps.hmSendPath,
        })))
        : undefined,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'quiet-burst-schedule') {
    const result = await ensureMiraQuietCuriositySchedule({
      install: args.install,
      runNow: args.runNow,
      dispatch: args.dispatch,
      sources: args.sources,
      intervalMinutes: args.intervalMinutes,
      schedulerStatePath: args.schedulerStatePath,
    }, {
      projectRoot: args.projectRoot,
      dispatch: args.dispatch,
      install: args.install,
      runNow: args.runNow,
      sources: args.sources,
      intervalMinutes: args.intervalMinutes,
      schedulerStatePath: args.schedulerStatePath,
      sendAgentMessage: args.dispatch
        ? (deps.sendAgentMessage || ((target, body) => sendInternalHmMessage(target, body, {
          projectRoot: args.projectRoot,
          hmSendPath: deps.hmSendPath,
        })))
        : undefined,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'email-snapshot') {
    const raw = args.fromStdin ? (deps.readStdin || readStdin)() : '{}';
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const result = writeMiraEmailCuriositySnapshot(payload, {
      projectRoot: args.projectRoot,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'code-mode') {
    const script = args.fromStdin ? (deps.readStdin || readStdin)() : args.script;
    const result = runMiraReadOnlyCodeMode({
      script,
      allowedPaths: args.allowPaths.length > 0 ? args.allowPaths : undefined,
    }, {
      projectRoot: args.projectRoot,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'scan-confidence') {
    const payload = {
      limit: args.limit,
      notifyArchitect: args.dispatch,
    };
    if (args.sessionId) payload.sessionId = args.sessionId;
    const result = await scanMiraLabConfidenceSource(payload, {
      projectRoot: args.projectRoot,
      sendAgentMessage: args.dispatch
        ? (deps.sendAgentMessage || ((target, body) => sendInternalHmMessage(target, body, {
          projectRoot: args.projectRoot,
          hmSendPath: deps.hmSendPath,
        })))
        : undefined,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  if (args.command === 'review') {
    const result = await reviewMiraSelfDirectionProposal({
      proposalId: args.proposalId,
      action: args.action,
      routeTargets: args.routeTargets,
      note: args.note,
    }, {
      projectRoot: args.projectRoot,
      sendAgentMessage: args.dispatch
        ? (deps.sendAgentMessage || ((target, body) => sendInternalHmMessage(target, body, {
          projectRoot: args.projectRoot,
          hmSendPath: deps.hmSendPath,
        })))
        : undefined,
      ...(deps.options || {}),
    });
    return { args, result };
  }
  throw new Error(`Unknown command: ${args.command}`);
}

async function main() {
  const runResult = await run();
  if (runResult.help) {
    printHelp();
    return;
  }
  output(runResult.result, runResult.args);
  process.exitCode = runResult.result && runResult.result.ok === false ? 1 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_FIXTURE,
  parseArgs,
  run,
  sendInternalHmMessage,
};
