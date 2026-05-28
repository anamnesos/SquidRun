#!/usr/bin/env node
'use strict';

const {
  TrustQuoteWorkRoomRouteOwner,
  buildTrustQuoteRouteOwnerPlan,
} = require('../modules/trustquote-work-room-route-owner');

function parseArgs(argv = []) {
  const options = {
    command: 'plan',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token) continue;
    if (!token.startsWith('--') && options.command === 'plan') {
      options.command = token;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--session' || token === '--main-session') {
      options.mainSessionScopeId = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token.startsWith('--session=')) {
      options.mainSessionScopeId = token.slice('--session='.length);
      continue;
    }
    if (token === '--project-path') {
      options.projectPath = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token.startsWith('--project-path=')) {
      options.projectPath = token.slice('--project-path='.length);
      continue;
    }
    if (token === '--squidrun-root') {
      options.squidrunRoot = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token.startsWith('--squidrun-root=')) {
      options.squidrunRoot = token.slice('--squidrun-root='.length);
      continue;
    }
    if (token === '--no-launch-agents') {
      options.launchAgents = false;
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
  }
  return options;
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'plan') {
    printJson(buildTrustQuoteRouteOwnerPlan(options));
    return;
  }

  if (options.command !== 'run') {
    throw new Error(`unknown command: ${options.command}`);
  }

  const owner = new TrustQuoteWorkRoomRouteOwner(options);
  const result = await owner.start();
  printJson({
    ok: true,
    command: 'run',
    plan: result.plan,
  });
  process.on('SIGINT', async () => {
    await owner.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await owner.stop();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
};
