#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.SQUIDRUN_PROJECT_ROOT
  || path.resolve(__dirname, '..', '..');

const {
  generateMiraSelfDirectionProposal,
  listMiraSelfDirectionProposals,
  reviewMiraSelfDirectionProposal,
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
    '  node ui/scripts/hm-mira-self-direction.js create [--fixture|--stdin] [--session-id <id>] [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js list [--status pending_architect_review|all] [--project-root <path>] [--json]',
    '  node ui/scripts/hm-mira-self-direction.js review --proposal-id <id> --action accepted|rejected|routed [--route builder,oracle] [--note <text>] [--project-root <path>] [--json]',
    '',
  ].join('\n'));
}

function parseArgs(argv = []) {
  const args = {
    command: argv[0] || 'help',
    projectRoot: PROJECT_ROOT,
    sessionId: `mira-self-direction-${new Date().toISOString().slice(0, 10)}`,
    useFixture: false,
    fromStdin: false,
    json: false,
    status: 'pending_architect_review',
    proposalId: null,
    action: null,
    routeTargets: [],
    note: null,
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
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--status') {
      args.status = argv[++index];
    } else if (token === '--proposal-id') {
      args.proposalId = argv[++index];
    } else if (token === '--action') {
      args.action = argv[++index];
    } else if (token === '--route') {
      args.routeTargets = String(argv[++index] || '').split(',').map((item) => item.trim()).filter(Boolean);
    } else if (token === '--note') {
      args.note = argv[++index];
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
  process.stdout.write(`decision=${result.decision}\n`);
  if (result.proposal_id) process.stdout.write(`proposal_id=${result.proposal_id}\n`);
  if (result.count !== undefined) process.stdout.write(`count=${result.count}\n`);
  if (result.review_queue_path) process.stdout.write(`queue=${result.review_queue_path}\n`);
  if (result.review_audit_path) process.stdout.write(`review_audit=${result.review_audit_path}\n`);
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
      sessionId: args.sessionId,
      proxyProposal,
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
  if (args.command === 'review') {
    const result = await reviewMiraSelfDirectionProposal({
      proposalId: args.proposalId,
      action: args.action,
      routeTargets: args.routeTargets,
      note: args.note,
    }, {
      projectRoot: args.projectRoot,
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
};
