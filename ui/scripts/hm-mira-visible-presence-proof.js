#!/usr/bin/env node
'use strict';

const path = require('path');

const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PROGRESS_PROOF_COMMANDS,
  VISIBLE_PRESENCE_A0_PROOF_KEY,
  VISIBLE_PRESENCE_A0_TEST_COMMAND,
  writeProgressProofArtifact,
} = require('../modules/mira-core/mira-progress-proof-inputs-v0');

function parseArgs(argv = []) {
  const args = {
    projectRoot: process.cwd(),
    out: null,
    json: true,
    pretty: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--project-root' || token === '--project') {
      args.projectRoot = argv[index + 1] || args.projectRoot;
      index += 1;
    } else if (token.startsWith('--project-root=')) {
      args.projectRoot = token.slice('--project-root='.length);
    } else if (token.startsWith('--project=')) {
      args.projectRoot = token.slice('--project='.length);
    } else if (token === '--out') {
      args.out = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--out=')) {
      args.out = token.slice('--out='.length);
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--pretty') {
      args.pretty = true;
    } else if (token === '--timeout-ms') {
      args.timeoutMs = Number.parseInt(argv[index + 1], 10) || DEFAULT_TIMEOUT_MS;
      index += 1;
    } else if (token.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number.parseInt(token.slice('--timeout-ms='.length), 10) || DEFAULT_TIMEOUT_MS;
    } else if (token && !token.startsWith('-') && !args.projectRoot) {
      args.projectRoot = token;
    } else if (token) {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  args.projectRoot = path.resolve(args.projectRoot || process.cwd());
  if (args.out) args.out = path.resolve(args.out);
  return args;
}

function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const result = writeProgressProofArtifact({
    projectRoot: args.projectRoot,
    progressProofPath: args.out || undefined,
    timeoutMs: args.timeoutMs,
    runner: options.runner,
    head: options.head,
    nowMs: options.nowMs,
  });
  const proof = result.artifact.proofs[VISIBLE_PRESENCE_A0_PROOF_KEY];
  const proofs = Object.fromEntries(Object.entries(result.artifact.proofs || {}).map(([key, entry]) => [
    key,
    {
      status: entry.status,
      command: entry.command,
      reason: entry.reason,
    },
  ]));
  const output = {
    ok: result.ok,
    schema: result.artifact.schema,
    proof_path: result.source_ref,
    proof_key: VISIBLE_PRESENCE_A0_PROOF_KEY,
    status: proof.status,
    command: VISIBLE_PRESENCE_A0_TEST_COMMAND,
    proof_count: Object.keys(result.artifact.proofs || {}).length,
    expected_proof_keys: DEFAULT_PROGRESS_PROOF_COMMANDS.map((entry) => entry.proof_key),
    proofs,
    head: result.artifact.head,
    worktree: result.artifact.worktree,
    consumable_when_current_worktree_clean: result.ok === true && result.artifact.worktree?.clean === true,
  };
  process.stdout.write(`${JSON.stringify(output, null, args.pretty ? 2 : 0)}\n`);
  return result;
}

if (require.main === module) {
  try {
    const result = main();
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`hm-mira-visible-presence-proof: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs,
};
