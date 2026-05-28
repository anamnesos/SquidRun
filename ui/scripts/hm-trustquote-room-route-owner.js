#!/usr/bin/env node
'use strict';

const {
  TrustQuoteWorkRoomRouteOwner,
  buildTrustQuoteRouteOwnerPlan,
} = require('../modules/trustquote-work-room-route-owner');
const {
  probeTrustQuoteRouteOwner,
  readRouteOwnerStatus,
  startTrustQuoteRouteOwner,
  stopTrustQuoteRouteOwner,
  writeSupervisorStatus,
} = require('../modules/trustquote-work-room-route-owner-supervisor');

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
    if (token === '--status-file') {
      options.statusPath = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token.startsWith('--status-file=')) {
      options.statusPath = token.slice('--status-file='.length);
      continue;
    }
    if (token === '--launch-agents') {
      options.launchAgents = true;
      continue;
    }
    if (token === '--allow-live-agents') {
      options.allowLiveAgents = true;
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
    if (token === '--stale-after-ms') {
      options.staleAfterMs = Number.parseInt(String(argv[index + 1] || ''), 10);
      index += 1;
      continue;
    }
    if (token.startsWith('--stale-after-ms=')) {
      options.staleAfterMs = Number.parseInt(token.slice('--stale-after-ms='.length), 10);
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

  if (options.command === 'status') {
    printJson(readRouteOwnerStatus(options));
    return;
  }

  if (options.command === 'start') {
    printJson(startTrustQuoteRouteOwner(options));
    return;
  }

  if (options.command === 'stop') {
    printJson(await stopTrustQuoteRouteOwner(options));
    return;
  }

  if (options.command === 'probe') {
    printJson(await probeTrustQuoteRouteOwner(options));
    return;
  }

  if (options.command !== 'run') {
    throw new Error(`unknown command: ${options.command}`);
  }

  const owner = new TrustQuoteWorkRoomRouteOwner(options);
  let result;
  try {
    result = await owner.start();
  } catch (err) {
    if (options.statusPath) {
      writeSupervisorStatus(options, {
        state: 'failed',
        running: false,
        pid: process.pid,
        pidAlive: false,
        error: err.message,
      });
    }
    throw err;
  }
  if (options.statusPath) {
    writeSupervisorStatus(options, {
      state: 'running',
      running: true,
      pid: process.pid,
      pidAlive: true,
      routeOwnerVersion: result.plan?.version || null,
      launchAgents: options.launchAgents !== false,
      dryRun: options.dryRun === true,
      plan: result.plan,
      stoppedAt: null,
      stopReason: null,
      terminalCleanup: null,
      error: null,
    });
  }
  printJson({
    ok: true,
    command: 'run',
    plan: result.plan,
  });
  process.on('SIGINT', async () => {
    await owner.stop();
    if (options.statusPath) {
      writeSupervisorStatus(options, {
        state: 'stopped',
        running: false,
        pid: process.pid,
        pidAlive: false,
        stoppedAt: new Date().toISOString(),
        stopReason: 'SIGINT',
      });
    }
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await owner.stop();
    if (options.statusPath) {
      writeSupervisorStatus(options, {
        state: 'stopped',
        running: false,
        pid: process.pid,
        pidAlive: false,
        stoppedAt: new Date().toISOString(),
        stopReason: 'SIGTERM',
      });
    }
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
