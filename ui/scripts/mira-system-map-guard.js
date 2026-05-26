#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const SYSTEM_MAP_PATH = 'docs/mira-system-map.md';
const GUARD_SCRIPT_PATH = 'ui/scripts/mira-system-map-guard.js';
const PRE_COMMIT_HOOK_PATH = 'scripts/pre-commit.sh';

function normalizeRelPath(filePath = '') {
  return String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function uniqueEntries(entries = []) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const filePath = normalizeRelPath(entry?.path || entry);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    out.push({
      status: String(entry?.status || '').trim(),
      path: filePath,
      oldPath: normalizeRelPath(entry?.oldPath || ''),
    });
  }
  return out;
}

function parseNameStatus(output = '') {
  return String(output || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t').map((part) => part.trim()).filter(Boolean);
      const status = parts[0] || '';
      const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
      const oldPath = isRenameOrCopy ? parts[1] : '';
      const filePath = isRenameOrCopy ? parts[parts.length - 1] : parts[1];
      return {
        status,
        path: normalizeRelPath(filePath),
        oldPath: normalizeRelPath(oldPath),
      };
    })
    .filter((entry) => entry.path);
}

function changedLines(diffText = '') {
  return String(diffText || '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line));
}

function diffTouchesMiraTelegramRoute(diffText = '') {
  const routePattern = /\b(mira|sendMiraLivePrompt|routeMainTelegramInboundToMira|miraLive|MIRA_|presence|lab-prompt|live-entrypoint|voice|phoneVoice|voiceBroker|voice-broker|phone-voice)\b/i;
  return changedLines(diffText).some((line) => routePattern.test(line));
}

function diffTouchesMiraSystemMapGuardWiring(diffText = '') {
  const guardPattern = /\b(mira-system-map-guard|Mira system map guard|docs\/mira-system-map\.md|ui\/scripts\/mira-system-map-guard\.js)\b/i;
  return changedLines(diffText).some((line) => guardPattern.test(line));
}

function classifyMiraOwnedPath(filePath = '', diffProvider = () => '') {
  const normalized = normalizeRelPath(filePath);
  if (!normalized) return null;
  if (normalized === SYSTEM_MAP_PATH) return null;
  if (normalized === GUARD_SCRIPT_PATH) return 'Mira source-of-truth enforcement';

  if (normalized.startsWith('mira/')) return 'New Mira product root';
  if (normalized.startsWith('ui/modules/mira-core/')) return 'SquidRun Mira core';
  if (normalized === 'ui/modules/mira-lab-surface.js') return 'Mira Lab reply surface';
  if (normalized === 'ui/modules/mira-live-entrypoint.js') return 'Mira Live entrypoint';
  if (/^ui\/modules\/mira-[^/]+\.js$/i.test(normalized)) return 'Mira module surface';
  if (normalized === 'ui/modules/ipc/mira-lab-handlers.js') return 'Mira Lab IPC route';
  if (/^ui\/modules\/ipc\/mira-[^/]+\.js$/i.test(normalized)) return 'Mira IPC surface';
  if (normalized === 'ui/modules/ipc/voice-broker-handlers.js') return 'Mira voice IPC route';
  if (normalized === 'ui/modules/main/mira-lab-window.js') return 'Mira Lab window route';
  if (normalized === 'ui/modules/tabs/mira-local-text.js') return 'Removed Mira local text tab shell';
  if (normalized === 'ui/styles/tabs/mira-local-text.css') return 'Removed Mira local text style shell';
  if (/^ui\/mira-lab[^/]*$/i.test(normalized)) return 'Mira Lab renderer surface';
  if (normalized === 'ui/styles/mira-lab.css') return 'Mira Lab style surface';
  if (/^ui\/scripts\/hm-mira[^/]*\.js$/i.test(normalized)) return 'Mira script surface';
  if (/^ui\/scripts\/hm-(?:voice|phone-voice)[^/]*\.js$/i.test(normalized)) return 'Mira voice script surface';
  if (normalized === 'ui/modules/voice-broker.js') return 'Mira voice transport';
  if (normalized === 'ui/modules/phone-voice-client.js') return 'Mira phone voice transport';
  if (/^ui\/__tests__\/[^/]*mira[^/]*\.test\.js$/i.test(normalized)) return 'Mira test coverage';
  if (/^ui\/__tests__\/fixtures\/mira-[^/]+/i.test(normalized)) return 'Mira fixture contract';
  if (/^docs\/mira-[^/]+\.md$/i.test(normalized)) return 'Mira doc/contract';

  if (/^ui\/scripts\/hm-telegram[^/]*\.js$/i.test(normalized)
    || normalized === 'ui/modules/main/squidrun-app.js'
    || normalized === 'ui/modules/telegram-poller.js'
    || normalized === 'ui/modules/main/telegram-poller-worker.js'
    || normalized === 'telegram-poller.js') {
    return diffTouchesMiraTelegramRoute(diffProvider(normalized))
      ? 'Mixed route file change touches Mira route/voice semantics'
      : null;
  }

  if (normalized === PRE_COMMIT_HOOK_PATH) {
    return diffTouchesMiraSystemMapGuardWiring(diffProvider(normalized))
      ? 'Pre-commit Mira system map guard wiring'
      : null;
  }

  return null;
}

function evaluateMiraSystemMapGuard({ stagedChanges = [], diffProvider = () => '' } = {}) {
  const changes = uniqueEntries(stagedChanges);
  const mapStaged = changes.some((entry) => (
    entry.path === SYSTEM_MAP_PATH && !entry.status.startsWith('D')
  ));
  const mapRemoved = changes.find((entry) => (
    entry.path === SYSTEM_MAP_PATH && entry.status.startsWith('D')
  ) || (
    entry.oldPath === SYSTEM_MAP_PATH && entry.status.startsWith('R') && !mapStaged
  ));

  if (mapRemoved) {
    return {
      ok: false,
      status: mapRemoved.status.startsWith('R') ? 'map_renamed' : 'map_deleted',
      mapStaged: false,
      miraOwned: [],
      message: `[mira-system-map-guard] FAIL ${SYSTEM_MAP_PATH} is the Mira source-of-truth map and cannot be deleted, renamed, or moved away from the canonical path without first replacing the guard/map contract.`,
    };
  }

  const miraOwned = changes
    .map((entry) => ({
      ...entry,
      reason: classifyMiraOwnedPath(entry.path, diffProvider),
    }))
    .filter((entry) => entry.reason);

  if (miraOwned.length === 0) {
    return {
      ok: true,
      status: 'skipped',
      mapStaged,
      miraOwned,
      message: '[mira-system-map-guard] No staged Mira-owned paths. Skipping.',
    };
  }

  if (mapStaged) {
    return {
      ok: true,
      status: 'covered',
      mapStaged,
      miraOwned,
      message: `[mira-system-map-guard] PASS ${SYSTEM_MAP_PATH} is staged with Mira-owned changes.`,
    };
  }

  return {
    ok: false,
    status: 'missing_map',
    mapStaged,
    miraOwned,
    message: [
      `[mira-system-map-guard] FAIL Mira-owned changes require ${SYSTEM_MAP_PATH} in the same staged diff.`,
      ...miraOwned.map((entry) => `  - ${entry.path} (${entry.reason})`),
      `Fix: stage ${SYSTEM_MAP_PATH} with the capability/inventory/checkpoint truth, or document the explicit non-semantic exemption there and stage it.`,
    ].join('\n'),
  };
}

function runGit(repoRoot, args = []) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function getStagedChanges(repoRoot) {
  const output = runGit(repoRoot, ['diff', '--cached', '--name-status', '--find-renames', '--diff-filter=ACMRD']);
  return parseNameStatus(output);
}

function printUsage() {
  process.stdout.write([
    'Usage: node ui/scripts/mira-system-map-guard.js [--staged] [--root <path>]',
    '',
    `Blocks staged Mira-owned changes unless ${SYSTEM_MAP_PATH} is staged too.`,
  ].join('\n'));
}

function parseArgs(argv = []) {
  const args = {
    staged: false,
    root: path.resolve(__dirname, '..', '..'),
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--staged') {
      args.staged = true;
      continue;
    }
    if (token === '--root' && argv[i + 1]) {
      args.root = path.resolve(argv[i + 1]);
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.staged) {
    throw new Error('Only --staged mode is supported.');
  }

  const stagedChanges = getStagedChanges(args.root);
  const result = evaluateMiraSystemMapGuard({
    stagedChanges,
    diffProvider: (filePath) => runGit(args.root, ['diff', '--cached', '-U0', '--', filePath]),
  });

  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${result.message}\n`);
  if (!result.ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[mira-system-map-guard] ${error.message}\n`);
    process.exit(2);
  }
}

module.exports = {
  SYSTEM_MAP_PATH,
  classifyMiraOwnedPath,
  diffTouchesMiraSystemMapGuardWiring,
  diffTouchesMiraTelegramRoute,
  evaluateMiraSystemMapGuard,
  parseNameStatus,
  _internals: {
    changedLines,
    normalizeRelPath,
  },
};
