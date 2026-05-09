#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_OUTPUT = path.join('docs', 'codebase-index.md');

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
  });
}

function parseArgs(argv = []) {
  const parsed = {
    check: false,
    json: false,
    output: DEFAULT_OUTPUT,
    projectRoot: null,
    help: false,
    errors: [],
  };

  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '').trim();
    if (!token) continue;
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--check') {
      parsed.check = true;
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--output') {
      const next = String(args[index + 1] || '').trim();
      if (!next || next.startsWith('--')) {
        parsed.errors.push('--output requires a path.');
      } else {
        parsed.output = next;
        index += 1;
      }
      continue;
    }
    if (token.startsWith('--output=')) {
      const value = token.slice('--output='.length).trim();
      if (!value) parsed.errors.push('--output requires a path.');
      else parsed.output = value;
      continue;
    }
    if (token === '--project-root') {
      const next = String(args[index + 1] || '').trim();
      if (!next || next.startsWith('--')) {
        parsed.errors.push('--project-root requires a path.');
      } else {
        parsed.projectRoot = next;
        index += 1;
      }
      continue;
    }
    if (token.startsWith('--project-root=')) {
      const value = token.slice('--project-root='.length).trim();
      if (!value) parsed.errors.push('--project-root requires a path.');
      else parsed.projectRoot = value;
      continue;
    }
    parsed.errors.push(`Unknown option: ${token}`);
  }

  return parsed;
}

function renderUsage() {
  return [
    'Usage:',
    '  node ui/scripts/hm-codebase-index.js [--output docs/codebase-index.md]',
    '  node ui/scripts/hm-codebase-index.js --check [--output docs/codebase-index.md]',
    '  node ui/scripts/hm-codebase-index.js --json',
    '',
    'Generates a deterministic Markdown inventory from Git-visible files:',
    '  git ls-files --cached --others --exclude-standard',
    '',
  ].join('\n');
}

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function getProjectRoot(startDir = process.cwd()) {
  return path.resolve(runGit(['rev-parse', '--show-toplevel'], { cwd: startDir }).trim());
}

function listGitVisibleFiles(projectRoot) {
  const output = runGit(['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: projectRoot,
    maxBuffer: 128 * 1024 * 1024,
  });
  return output
    .split(/\r?\n/)
    .map(normalizeRelPath)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function parseStatus(projectRoot) {
  const output = runGit(['status', '--porcelain=v1', '-z'], {
    cwd: projectRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  const statuses = new Map();
  const parts = output.split('\0').filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    const code = entry.slice(0, 2);
    let filePath = normalizeRelPath(entry.slice(3));
    if (code.includes('R') || code.includes('C')) {
      const next = parts[index + 1];
      if (next) {
        filePath = normalizeRelPath(next);
        index += 1;
      }
    }
    if (filePath) {
      statuses.set(filePath, code);
    }
  }
  return statuses;
}

function fileKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (/\/__tests__\//.test(filePath) || /\.test\.[cm]?js$/i.test(filePath)) return 'test';
  if (filePath.startsWith('docs/') || ext === '.md') return 'doc';
  if (filePath.startsWith('ui/scripts/') || filePath.startsWith('scripts/') || ext === '.ps1' || ext === '.bat') return 'script';
  if (['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx'].includes(ext)) return 'source';
  if (['.json', '.yml', '.yaml', '.toml', '.env', '.example'].includes(ext) || path.basename(filePath).startsWith('.')) return 'config';
  if (['.css', '.html', '.svg', '.png', '.ico', '.excalidraw'].includes(ext)) return 'asset';
  return ext ? ext.slice(1) : 'file';
}

function groupFor(filePath) {
  if (filePath.startsWith('ui/modules/')) return 'ui/modules';
  if (filePath.startsWith('ui/__tests__/')) return 'ui/__tests__';
  if (filePath.startsWith('ui/scripts/')) return 'ui/scripts';
  if (filePath.startsWith('ui/styles/')) return 'ui/styles';
  if (filePath.startsWith('ui/')) return 'ui/other';
  if (filePath.startsWith('docs/')) return 'docs';
  if (filePath.startsWith('workspace/knowledge/')) return 'workspace/knowledge';
  if (filePath.startsWith('workspace/')) return 'workspace';
  if (filePath.startsWith('scripts/')) return 'scripts';
  if (filePath.startsWith('tools/')) return 'tools';
  if (filePath.startsWith('benchmarks/')) return 'benchmarks';
  if (filePath.startsWith('.github/')) return '.github';
  if (filePath.startsWith('.squidrun/')) return '.squidrun';
  return 'root';
}

function getFileSize(projectRoot, filePath) {
  try {
    return fs.statSync(path.join(projectRoot, filePath)).size;
  } catch {
    return null;
  }
}

function getGitHead(projectRoot) {
  try {
    return runGit(['rev-parse', '--short', 'HEAD'], { cwd: projectRoot }).trim();
  } catch {
    return 'unknown';
  }
}

function getGitBranch(projectRoot) {
  try {
    return runGit(['branch', '--show-current'], { cwd: projectRoot }).trim() || 'detached';
  } catch {
    return 'unknown';
  }
}

function markdownEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function formatBytes(value) {
  if (value === null || value === undefined) return '-';
  if (!Number.isFinite(Number(value))) return '-';
  return String(Number(value));
}

function collectInventory(options = {}) {
  const projectRoot = getProjectRoot(options.projectRoot || process.cwd());
  const outputRelPath = normalizeRelPath(options.output || DEFAULT_OUTPUT);
  const visibleFiles = new Set(listGitVisibleFiles(projectRoot));
  visibleFiles.add(outputRelPath);
  visibleFiles.add('ui/scripts/hm-codebase-index.js');

  const statuses = parseStatus(projectRoot);
  const files = Array.from(visibleFiles).sort((a, b) => a.localeCompare(b)).map((filePath) => ({
    path: filePath,
    group: groupFor(filePath),
    kind: fileKind(filePath),
    status: statuses.get(filePath) || '  ',
    bytes: filePath === outputRelPath ? null : getFileSize(projectRoot, filePath),
  }));

  const groups = new Map();
  const kinds = new Map();
  const statusCounts = new Map();
  for (const file of files) {
    groups.set(file.group, (groups.get(file.group) || 0) + 1);
    kinds.set(file.kind, (kinds.get(file.kind) || 0) + 1);
    const status = file.status === '  ' ? 'clean/tracked' : file.status.trim() || file.status;
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
  }

  return {
    projectRoot,
    outputRelPath,
    sourceCommand: 'git ls-files --cached --others --exclude-standard',
    git: {
      branch: getGitBranch(projectRoot),
      head: getGitHead(projectRoot),
    },
    totalFiles: files.length,
    groups: Object.fromEntries(Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    kinds: Object.fromEntries(Array.from(kinds.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    statuses: Object.fromEntries(Array.from(statusCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    files,
  };
}

function renderCountMap(map) {
  return Object.entries(map)
    .map(([key, count]) => `- ${key}: ${count}`)
    .join('\n');
}

function renderInventoryMarkdown(inventory) {
  const lines = [
    '# Codebase Index',
    '',
    '> Generated by `node ui/scripts/hm-codebase-index.js`. Do not edit this file by hand.',
    '',
    'This file is the full Git-visible inventory for agent navigation. It is deliberately separate from `ARCHITECTURE.md`: this file answers "what exists?", while `ARCHITECTURE.md` answers "how the system fits together."',
    '',
    '## Metadata',
    `- Source command: \`${inventory.sourceCommand}\``,
    `- Git branch: \`${inventory.git.branch}\``,
    `- Git HEAD: \`${inventory.git.head}\``,
    `- Total files listed: ${inventory.totalFiles}`,
    '- Scope: tracked files plus nonignored untracked files visible to Git',
    '- Excluded by design: ignored dependencies, runtime databases, logs, backups, local private overlays, and other files hidden by `.gitignore`',
    '- Verify freshness: `node ui/scripts/hm-codebase-index.js --check`',
    '',
    '## Summary By Group',
    renderCountMap(inventory.groups),
    '',
    '## Summary By Kind',
    renderCountMap(inventory.kinds),
    '',
    '## Summary By Status',
    '- `clean/tracked`: present in Git with no working-tree status marker',
    '- Other values are raw two-column `git status --porcelain` codes such as `M`, `A`, or `??`',
    renderCountMap(inventory.statuses),
    '',
    '## Files',
    '',
  ];

  const filesByGroup = new Map();
  for (const file of inventory.files) {
    if (!filesByGroup.has(file.group)) filesByGroup.set(file.group, []);
    filesByGroup.get(file.group).push(file);
  }

  for (const [group, files] of Array.from(filesByGroup.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${group}`);
    lines.push('');
    lines.push('| Path | Kind | Status | Bytes |');
    lines.push('| --- | --- | --- | ---: |');
    for (const file of files) {
      const status = file.status === '  ' ? 'clean/tracked' : file.status;
      lines.push(`| \`${markdownEscape(file.path)}\` | ${markdownEscape(file.kind)} | \`${markdownEscape(status)}\` | ${formatBytes(file.bytes)} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function writeIfChanged(filePath, content) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (current === content) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const parsed = parseArgs(argv);
  if (parsed.help) {
    stdout.write(renderUsage());
    return 0;
  }
  if (parsed.errors.length > 0) {
    stderr.write(`${parsed.errors.join('\n')}\n\n${renderUsage()}`);
    return 1;
  }

  const inventory = collectInventory({
    projectRoot: parsed.projectRoot || process.cwd(),
    output: parsed.output,
  });

  if (parsed.json) {
    stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return 0;
  }

  const markdown = renderInventoryMarkdown(inventory);
  const outputPath = path.resolve(inventory.projectRoot, parsed.output || DEFAULT_OUTPUT);

  if (parsed.check) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
    if (current !== markdown) {
      stderr.write(`Codebase index is stale: ${path.relative(inventory.projectRoot, outputPath)}\n`);
      return 2;
    }
    stdout.write(`Codebase index is current: ${path.relative(inventory.projectRoot, outputPath)}\n`);
    return 0;
  }

  const changed = writeIfChanged(outputPath, markdown);
  stdout.write(`${changed ? 'Updated' : 'Already current'} ${path.relative(inventory.projectRoot, outputPath)} (${inventory.totalFiles} files)\n`);
  return 0;
}

if (require.main === module) {
  try {
    const exitCode = main();
    if (exitCode !== 0) process.exit(exitCode);
  } catch (err) {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_OUTPUT,
  collectInventory,
  fileKind,
  groupFor,
  listGitVisibleFiles,
  main,
  parseArgs,
  renderInventoryMarkdown,
  renderUsage,
};
