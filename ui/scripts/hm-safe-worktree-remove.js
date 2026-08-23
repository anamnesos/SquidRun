#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv = process.argv.slice(2)) {
  const args = { target: '', force: false, checkOnly: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--target' && argv[index + 1]) {
      args.target = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (token === '--force') args.force = true;
    if (token === '--check') args.checkOnly = true;
    if (token === '--json') args.json = true;
  }
  if (!args.target) throw new Error('Missing required --target <worktree-path>');
  return args;
}

function comparablePath(value) {
  const resolved = path.resolve(String(value || '')).replace(/^\\\\\?\\/u, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function runGitDefault(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error?.message || null,
  };
}

function parseWorktreeList(output = '') {
  return String(output)
    .split(/\0|\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length).trim()));
}

function inspectTreeForReparsePoints(rootPath, options = {}) {
  const fsRef = options.fs || fs;
  const root = path.resolve(rootPath);
  let rootStat;
  try {
    rootStat = fsRef.lstatSync(root);
  } catch (error) {
    return {
      ok: false,
      reason: 'worktree_unavailable',
      root,
      error: error?.message || String(error),
      reparsePoints: [],
    };
  }
  if (rootStat.isSymbolicLink()) {
    return { ok: false, reason: 'worktree_root_reparse_forbidden', root, reparsePoints: [root] };
  }
  if (!rootStat.isDirectory()) {
    return { ok: false, reason: 'worktree_not_directory', root, reparsePoints: [] };
  }

  const queue = [root];
  const reparsePoints = [];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = fsRef.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      return {
        ok: false,
        reason: 'worktree_scan_failed',
        root,
        error: error?.message || String(error),
        reparsePoints,
      };
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      let stat;
      try {
        stat = fsRef.lstatSync(candidate);
      } catch (error) {
        return {
          ok: false,
          reason: 'worktree_scan_failed',
          root,
          path: candidate,
          error: error?.message || String(error),
          reparsePoints,
        };
      }
      if (stat.isSymbolicLink()) {
        reparsePoints.push(candidate);
        continue;
      }
      if (stat.isDirectory()) queue.push(candidate);
    }
  }

  return reparsePoints.length > 0
    ? { ok: false, reason: 'worktree_reparse_point_forbidden', root, reparsePoints }
    : { ok: true, reason: null, root, reparsePoints: [] };
}

function requireGitSuccess(result, operation) {
  if (result?.status === 0) return result;
  const detail = String(result?.stderr || result?.error || 'unknown git failure').trim();
  throw new Error(`${operation} failed: ${detail}`);
}

function removeWorktreeSafely(options = {}) {
  const fsRef = options.fs || fs;
  const runGit = options.runGit || runGitDefault;
  const cwd = path.resolve(options.cwd || process.cwd());
  const target = path.resolve(options.target || '');
  if (!options.target) throw new Error('worktree_target_required');

  const rootResult = requireGitSuccess(
    runGit(['-C', cwd, 'rev-parse', '--show-toplevel'], { cwd }),
    'git root discovery'
  );
  const currentRoot = path.resolve(String(rootResult.stdout || '').trim());
  if (comparablePath(target) === comparablePath(currentRoot)) {
    return { ok: false, reason: 'current_worktree_removal_forbidden', target, currentRoot };
  }

  const listResult = requireGitSuccess(
    runGit(['-C', currentRoot, 'worktree', 'list', '--porcelain', '-z'], { cwd: currentRoot }),
    'git worktree discovery'
  );
  const registeredWorktrees = parseWorktreeList(listResult.stdout);
  if (!registeredWorktrees.some((entry) => comparablePath(entry) === comparablePath(target))) {
    return { ok: false, reason: 'unregistered_worktree_target', target, currentRoot };
  }

  const firstScan = inspectTreeForReparsePoints(target, { fs: fsRef });
  if (!firstScan.ok) return firstScan;
  if (options.checkOnly === true) {
    return { ok: true, checked: true, removed: false, target, currentRoot };
  }

  // Re-scan immediately before Git gets authority. This is intentionally
  // redundant: teardown is destructive, and a late junction must fail closed.
  const finalScan = inspectTreeForReparsePoints(target, { fs: fsRef });
  if (!finalScan.ok) return finalScan;

  const removeArgs = ['-C', currentRoot, 'worktree', 'remove'];
  if (options.force === true) removeArgs.push('--force');
  removeArgs.push(target);
  const removeResult = runGit(removeArgs, { cwd: currentRoot });
  if (removeResult?.status !== 0) {
    return {
      ok: false,
      reason: 'git_worktree_remove_failed',
      target,
      currentRoot,
      error: String(removeResult?.stderr || removeResult?.error || '').trim(),
    };
  }
  return { ok: true, checked: true, removed: true, target, currentRoot, force: options.force === true };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = removeWorktreeSafely({
    target: args.target,
    force: args.force,
    checkOnly: args.checkOnly,
  });
  process.stdout.write(`${JSON.stringify(result, null, args.json ? 2 : 0)}\n`);
  process.exitCode = result.ok ? 0 : 1;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  comparablePath,
  parseWorktreeList,
  inspectTreeForReparsePoints,
  removeWorktreeSafely,
  main,
};
