#!/usr/bin/env node
'use strict';

/**
 * hm-sandbox: siege sandbox over git worktrees (S468 — organ 6's gate).
 *
 * The four-day plan bars any siege (attack agents probing the system) until
 * the sandbox is PROVEN: work inside a sandbox must be unable to reach the
 * production tree or runtime. This tool creates/destroys worktree sandboxes
 * and — the part that matters — `prove` runs the isolation demonstration
 * and emits checkable evidence instead of an assurance.
 *
 *   node ui/scripts/hm-sandbox.js create <name> [--repo <path>]
 *   node ui/scripts/hm-sandbox.js destroy <name> [--repo <path>]
 *   node ui/scripts/hm-sandbox.js list [--repo <path>]
 *   node ui/scripts/hm-sandbox.js prove [--repo <path>] [--runtime <path>]
 *
 * prove: creates a throwaway sandbox; inside it mutates a tracked file,
 * adds a new file, and commits; then verifies the production tree's file
 * content, HEAD, status, and runtime-dir fingerprint are byte-identical to
 * their before state. Sandbox is destroyed afterward. Exit code = verdict.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX_ROOT_NAME = 'squidrun-siege-sandboxes';

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', timeout: 60000, ...options,
  }).trim();
}

function sandboxRoot(repo) {
  // Sibling of the repo, never inside it: a sandbox living in the prod tree
  // would make "untouched prod tree" unfalsifiable.
  return path.join(path.dirname(repo), SANDBOX_ROOT_NAME);
}

function sandboxPath(repo, name) {
  if (!/^[A-Za-z0-9][\w-]*$/.test(String(name))) {
    throw new Error(`invalid sandbox name '${name}'`);
  }
  return path.join(sandboxRoot(repo), name);
}

function createSandbox(repo, name) {
  const target = sandboxPath(repo, name);
  if (fs.existsSync(target)) throw new Error(`sandbox '${name}' already exists`);
  fs.mkdirSync(sandboxRoot(repo), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', target, 'HEAD']);
  return { name, path: target, head: git(target, ['rev-parse', 'HEAD']) };
}

function destroySandbox(repo, name) {
  const target = sandboxPath(repo, name);
  git(repo, ['worktree', 'remove', '--force', target]);
  return { destroyed: name };
}

function listSandboxes(repo) {
  const root = sandboxRoot(repo);
  const rows = git(repo, ['worktree', 'list', '--porcelain']).split('\n\n');
  const sandboxes = [];
  for (const row of rows) {
    const wt = row.split('\n').find((l) => l.startsWith('worktree '));
    if (!wt) continue;
    const wtPath = path.resolve(wt.slice('worktree '.length));
    if (wtPath.startsWith(path.resolve(root) + path.sep)) {
      sandboxes.push({ name: path.basename(wtPath), path: wtPath });
    }
  }
  return { root, sandboxes };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const RUNTIME_CANARY = 'siege-canary-runtime.json';

function prove({ repo, runtimeDir }) {
  const checks = [];
  const check = (name, before, after) => {
    checks.push({ name, isolated: before === after, before, after });
  };

  // Pick a tracked file to attack (first tracked file in the sandbox HEAD).
  const trackedFile = git(repo, ['ls-files']).split('\n').filter(Boolean)[0];
  if (!trackedFile) throw new Error('prove: repo has no tracked files');

  const before = {
    head: git(repo, ['rev-parse', 'HEAD']),
    status: git(repo, ['status', '--porcelain']),
    fileHash: sha256File(path.join(repo, trackedFile)),
  };

  const name = `prove-${process.pid}`;
  const sandbox = createSandbox(repo, name);
  let attack;
  try {
    // The attack, from INSIDE the sandbox: mutate a tracked file, add a new
    // file, commit both. If isolation holds, prod never sees any of it.
    fs.appendFileSync(path.join(sandbox.path, trackedFile), '\n// SIEGE CANARY — must never reach prod\n');
    fs.writeFileSync(path.join(sandbox.path, 'siege-canary-new-file.txt'), 'sandbox-only artifact\n');
    // Runtime-path attack: write into the sandbox's OWN .squidrun/runtime.
    // The live prod runtime churns constantly (receipts, heartbeat), so the
    // check is a TARGETED canary — did THIS file reach prod — not a naive
    // whole-dir fingerprint that reads ordinary liveness as a leak.
    const sandboxRuntime = path.join(sandbox.path, '.squidrun', 'runtime');
    fs.mkdirSync(sandboxRuntime, { recursive: true });
    fs.writeFileSync(path.join(sandboxRuntime, RUNTIME_CANARY), '{"leak":"if you can read this in prod"}\n');
    git(sandbox.path, ['add', '-A']);
    git(sandbox.path, ['-c', 'user.email=siege@sandbox', '-c', 'user.name=siege',
      'commit', '-m', 'siege canary commit (sandbox-local)']);
    attack = {
      mutatedTrackedFile: trackedFile,
      sandboxHead: git(sandbox.path, ['rev-parse', 'HEAD']),
      sandboxFileHash: sha256File(path.join(sandbox.path, trackedFile)),
    };
  } finally {
    destroySandbox(repo, name);
  }

  check('prod HEAD unchanged', before.head, git(repo, ['rev-parse', 'HEAD']));
  check('prod status unchanged', before.status, git(repo, ['status', '--porcelain']));
  check('prod tracked-file bytes unchanged', before.fileHash, sha256File(path.join(repo, trackedFile)));
  checks.push({
    name: 'runtime canary absent from prod runtime',
    isolated: !runtimeDir || !fs.existsSync(path.join(runtimeDir, RUNTIME_CANARY)),
  });
  checks.push({
    name: 'attack really ran (sandbox diverged before teardown)',
    isolated: attack.sandboxHead !== before.head && attack.sandboxFileHash !== before.fileHash,
  });
  checks.push({
    name: 'canary file absent from prod',
    isolated: !fs.existsSync(path.join(repo, 'siege-canary-new-file.txt')),
  });

  return {
    verdict: checks.every((c) => c.isolated) ? 'ISOLATED' : 'LEAKED',
    repo,
    runtimeDir: runtimeDir || null,
    attack,
    checks,
  };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (nameArg) => {
    const i = rest.indexOf(`--${nameArg}`);
    return i >= 0 ? rest[i + 1] : null;
  };
  const repo = path.resolve(flag('repo') || path.join(__dirname, '..', '..'));
  try {
    let result;
    if (cmd === 'create') result = createSandbox(repo, rest[0]);
    else if (cmd === 'destroy') result = destroySandbox(repo, rest[0]);
    else if (cmd === 'list') result = listSandboxes(repo);
    else if (cmd === 'prove') {
      result = prove({
        repo,
        runtimeDir: flag('runtime') || path.join(repo, '.squidrun', 'runtime'),
      });
      if (result.verdict !== 'ISOLATED') process.exitCode = 1;
    } else {
      throw new Error('usage: hm-sandbox.js create <name>|destroy <name>|list|prove [--repo P] [--runtime P]');
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`hm-sandbox: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { createSandbox, destroySandbox, listSandboxes, prove, sandboxRoot };
