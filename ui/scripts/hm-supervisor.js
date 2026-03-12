#!/usr/bin/env node

const path = require('path');

const { SupervisorStore } = require('../modules/supervisor');

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const positional = [];
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !String(next).startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positional, flags };
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node scripts/hm-supervisor.js status [--db-path <path>]',
    '  node scripts/hm-supervisor.js list [--status <status>] [--limit <n>] [--db-path <path>]',
    '  node scripts/hm-supervisor.js requeue-expired [--db-path <path>]',
    '  node scripts/hm-supervisor.js enqueue --objective "<text>" [--priority <n>] [--owner-pane <pane>] [--cwd <dir>] [--shell-command "<cmd>"] [--command <exe> --args-json "[...]"] [--env-json "{...}"] [--timeout-ms <n>] [--db-path <path>]',
    '',
  ].join('\n'));
}

function openStore(dbPath) {
  const store = new SupervisorStore({
    dbPath: dbPath ? path.resolve(String(dbPath)) : undefined,
  });
  const initResult = store.init();
  if (!initResult.ok) {
    throw new Error(initResult.error || initResult.reason || 'supervisor_init_failed');
  }
  return store;
}

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || flags.help) {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const store = openStore(flags['db-path']);
  try {
    if (command === 'status') {
      process.stdout.write(`${JSON.stringify({
        store: store.getStatus(),
        counts: store.getTaskCounts(),
        tasks: store.listTasks({ limit: 20 }),
      }, null, 2)}\n`);
      return;
    }

    if (command === 'list') {
      process.stdout.write(`${JSON.stringify(store.listTasks({
        status: flags.status,
        limit: flags.limit,
      }), null, 2)}\n`);
      return;
    }

    if (command === 'requeue-expired') {
      process.stdout.write(`${JSON.stringify(store.requeueExpiredTasks({ nowMs: Date.now() }), null, 2)}\n`);
      return;
    }

    if (command === 'enqueue') {
      const objective = typeof flags.objective === 'string' ? flags.objective.trim() : '';
      if (!objective) {
        throw new Error('enqueue requires --objective');
      }

      const argsJson = safeJsonParse(flags['args-json'], []);
      const envJson = safeJsonParse(flags['env-json'], {});
      const contextSnapshot = {
        kind: 'shell',
        cwd: flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd(),
        timeoutMs: flags['timeout-ms'] ? Number.parseInt(flags['timeout-ms'], 10) : 0,
      };

      if (typeof flags['shell-command'] === 'string' && flags['shell-command'].trim()) {
        contextSnapshot.shellCommand = flags['shell-command'];
      } else if (typeof flags.command === 'string' && flags.command.trim()) {
        contextSnapshot.command = flags.command;
        contextSnapshot.args = Array.isArray(argsJson) ? argsJson : [];
        contextSnapshot.shell = flags.shell === true;
      } else {
        throw new Error('enqueue requires --shell-command or --command');
      }

      if (envJson && typeof envJson === 'object') {
        contextSnapshot.env = envJson;
      }

      const result = store.enqueueTask({
        objective,
        ownerPane: flags['owner-pane'] || null,
        priority: flags.priority ? Number.parseInt(flags.priority, 10) : 100,
        contextSnapshot,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
