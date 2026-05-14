#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROTOCOL = 'mira.hm_comms_read_adapter.v0';
const ALLOWED_TEAM_ROLES = Object.freeze(['architect', 'builder', 'oracle']);

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveProjectLink(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const linkPath = options.linkPath ? path.resolve(options.linkPath) : path.join(cwd, '.squidrun', 'link.json');
  return { linkPath, link: readJsonFile(linkPath) };
}

function resolveSquidRunRoot(options = {}) {
  const { link } = resolveProjectLink(options);
  const fromLink = typeof link?.squidrun_root === 'string' ? link.squidrun_root.trim() : '';
  return path.resolve(options.squidrunRoot || fromLink || options.cwd || process.cwd());
}

function resolveHmCommsPath(options = {}) {
  const { link } = resolveProjectLink(options);
  const fromLink = typeof link?.comms?.hm_comms === 'string' ? link.comms.hm_comms.trim() : '';
  return path.resolve(options.hmCommsPath || fromLink || path.join(resolveSquidRunRoot(options), 'ui', 'scripts', 'hm-comms.js'));
}

function normalizeTeamRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALLOWED_TEAM_ROLES.includes(normalized) ? normalized : null;
}

function assertTeamRole(value) {
  const role = normalizeTeamRole(value);
  if (role) return role;

  const normalized = String(value || '').trim().toLowerCase();
  const externalTargets = new Set(['telegram', 'user', 'external', 'web', 'browser']);
  const code = externalTargets.has(normalized)
    || normalized.startsWith('@')
    || /^https?:\/\//i.test(normalized)
    ? 'external_target_refused'
    : 'invalid_team_role';

  throw Object.assign(new Error(`Mira receive bridge only reads between Mira and team panes: architect, builder, oracle. Refused '${value}'.`), {
    code,
    role: value,
  });
}

function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

function buildReadPlan(input = {}, options = {}) {
  const teamRole = assertTeamRole(input.teamRole || input.from || input.withRole);
  const last = asPositiveInt(input.last, 20);
  const hmCommsPath = resolveHmCommsPath(options);
  const args = [
    hmCommsPath,
    'history',
    '--between',
    'mira',
    teamRole,
    '--last',
    String(last),
    '--json',
  ];

  const sessionId = String(input.sessionId || '').trim();
  if (sessionId) {
    args.push('--session', sessionId);
  }

  const scope = String(input.scope || '').trim();
  if (scope) {
    args.push('--scope', scope);
  }

  return {
    ok: true,
    dryRun: true,
    protocol: PROTOCOL,
    manualReadOnly: true,
    mutatesState: false,
    telegramRouteControl: false,
    uiSurfaceControl: false,
    query: {
      participant: 'mira',
      teamRole,
      sessionId: sessionId || null,
      correlationId: input.correlationId || null,
      last,
      scope: scope || null,
    },
    command: {
      executable: process.execPath,
      args,
      cwd: resolveSquidRunRoot(options),
    },
  };
}

function parseArgs(argv = []) {
  const parsed = {
    dryRun: true,
    last: 20,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (token === '--read') {
      parsed.read = true;
      continue;
    }
    if ((token === '--from' || token === '--with') && next) {
      parsed.teamRole = next;
      index += 1;
      continue;
    }
    if (token === '--session-id' && next) {
      parsed.sessionId = next;
      index += 1;
      continue;
    }
    if (token === '--correlation-id' && next) {
      parsed.correlationId = next;
      index += 1;
      continue;
    }
    if (token === '--last' && next) {
      parsed.last = next;
      index += 1;
      continue;
    }
    if (token === '--scope' && next) {
      parsed.scope = next;
      index += 1;
      continue;
    }

    throw Object.assign(new Error(`Unknown or incomplete argument: ${token}`), { code: 'invalid_request' });
  }

  return parsed;
}

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error?.code || 'invalid_request',
      message: error?.message || String(error || 'invalid request'),
      retryable: false,
    },
  };
}

function run(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const plan = buildReadPlan(args, {
    cwd: options.cwd || process.cwd(),
    hmCommsPath: options.hmCommsPath,
  });

  if (args.read) {
    const execute = options.spawnSync || spawnSync;
    const result = execute(plan.command.executable, plan.command.args, {
      cwd: plan.command.cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    const exitCode = Number.isInteger(result?.status) ? result.status : 1;
    let parsed = null;
    try {
      parsed = result?.stdout ? JSON.parse(result.stdout) : null;
    } catch (_) {
      parsed = null;
    }

    return {
      statusCode: exitCode,
      payload: {
        ok: exitCode === 0,
        dryRun: false,
        protocol: PROTOCOL,
        manualReadOnly: true,
        mutatesState: false,
        query: plan.query,
        command: plan.command,
        delivery: {
          status: exitCode === 0 ? 'hm_comms_completed' : 'hm_comms_failed',
          exit_code: exitCode,
          signal: result?.signal || null,
        },
        result: parsed,
        stdout: result?.stdout || '',
        stderr: result?.stderr || '',
        error: result?.error ? String(result.error.message || result.error) : null,
      },
    };
  }

  return {
    statusCode: 0,
    payload: plan,
  };
}

function main() {
  try {
    const result = run(process.argv.slice(2), { cwd: process.cwd() });
    process.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`);
    process.exit(result.statusCode);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorPayload(error), null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PROTOCOL,
  buildReadPlan,
  parseArgs,
  run,
};
