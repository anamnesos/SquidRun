#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');

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
    '  node scripts/hm-memory-promote.js list [--status <status>] [--limit <n>]',
    '  node scripts/hm-memory-promote.js approve --ids <id1,id2> | --all',
    '  node scripts/hm-memory-promote.js reject --ids <id1,id2> | --all',
    '',
  ].join('\n'));
}

function parseIds(raw) {
  if (!raw) return [];
  return Array.from(new Set(String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)));
}

function normalizeStatement(statement) {
  return String(statement || '').replace(/\s+/g, ' ').trim();
}

function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function getSectionRange(lines, heading) {
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) return null;
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s+/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }
  return { startIndex, endIndex };
}

function appendBulletToSection(filePath, heading, statement) {
  const normalized = normalizeStatement(statement);
  ensureDir(filePath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${heading}\n\n- ${normalized}\n`);
    return { filePath, added: true, alreadyPresent: false };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const existingLines = raw.split(/\r?\n/);
  if (existingLines.some((line) => normalizeStatement(line.replace(/^[-*]\s+/, '')) === normalized)) {
    return { filePath, added: false, alreadyPresent: true };
  }

  let lines = existingLines.slice();
  let range = getSectionRange(lines, heading);
  if (!range) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(heading, '', `- ${normalized}`);
  } else {
    let insertAt = range.endIndex;
    while (insertAt > range.startIndex + 1 && lines[insertAt - 1] === '') {
      insertAt -= 1;
    }
    lines.splice(insertAt, 0, `- ${normalized}`);
  }

  const nextContent = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
  fs.writeFileSync(filePath, nextContent);
  return { filePath, added: true, alreadyPresent: false };
}

function resolvePromotionTarget(pr, workspaceDir) {
  const knowledgeDir = path.join(workspaceDir, 'knowledge');
  const category = String(pr.category || '').toLowerCase();
  const domain = String(pr.domain || '').toLowerCase();

  if (category === 'preference' || domain === 'user_preferences') {
    return { filePath: path.join(knowledgeDir, 'user-context.md'), heading: '## Observed Preferences' };
  }
  if (category === 'workflow' || domain === 'workflows') {
    return { filePath: path.join(knowledgeDir, 'workflows.md'), heading: '# Workflows' };
  }
  if (category === 'system_state' || domain === 'system_architecture') {
    return { filePath: path.join(knowledgeDir, 'infrastructure.md'), heading: '# Infrastructure' };
  }
  if (domain === 'business_context') {
    return { filePath: path.join(knowledgeDir, 'user-context.md'), heading: '## Active Focus Areas' };
  }
  return { filePath: path.join(knowledgeDir, 'memory-pr-promotions.md'), heading: '# Memory PR Promotions' };
}

function promoteRows(rows, workspaceDir) {
  const touched = [];
  for (const row of rows) {
    const target = resolvePromotionTarget(row, workspaceDir);
    const result = appendBulletToSection(target.filePath, target.heading, row.statement);
    touched.push({
      pr_id: row.pr_id,
      filePath: target.filePath,
      heading: target.heading,
      added: result.added,
      alreadyPresent: result.alreadyPresent,
    });
  }
  return touched;
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'list';
  const store = new CognitiveMemoryStore();

  try {
    if (command === 'list') {
      const status = flags.status || 'pending';
      const rows = store.listPendingPRs({ status, limit: flags.limit });
      process.stdout.write(`${JSON.stringify(rows.map((row) => ({
        ...row,
        source_payload: JSON.parse(row.source_payload_json || '{}'),
      })), null, 2)}\n`);
      return;
    }

    if (command !== 'approve' && command !== 'reject') {
      printUsage();
      throw new Error(`Unknown command: ${command}`);
    }

    let rows = [];
    if (flags.all) {
      rows = store.listPendingPRs({ status: 'pending', limit: 1000 });
    } else {
      const ids = parseIds(flags.ids);
      if (!ids.length) {
        throw new Error(`${command} requires --ids <id1,id2> or --all`);
      }
      rows = store.getMemoryPRsByIds(ids).filter((row) => row.status === 'pending');
    }

    if (!rows.length) {
      process.stdout.write(`${JSON.stringify({ ok: true, command, updated: 0, touchedFiles: [] }, null, 2)}\n`);
      return;
    }

    let touchedFiles = [];
    let nextStatus = 'rejected';
    if (command === 'approve') {
      touchedFiles = promoteRows(rows, store.paths.workspaceDir);
      nextStatus = 'promoted';
    }

    const review = store.reviewMemoryPRs({
      ids: rows.map((row) => row.pr_id),
      status: nextStatus,
      review_increment: 1,
    });

    process.stdout.write(`${JSON.stringify({
      ok: true,
      command,
      updated: review.updated,
      status: nextStatus,
      touchedFiles,
    }, null, 2)}\n`);
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

module.exports = {
  appendBulletToSection,
  parseIds,
  promoteRows,
  resolvePromotionTarget,
};
