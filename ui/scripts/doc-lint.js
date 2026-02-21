#!/usr/bin/env node
/**
 * Doc hygiene linter for build docs.
 *
 * Validates:
 * - active item section exists with cap <= 5
 * - active item count does not exceed cap
 * - required fields on active items (Owner, Last Verified, Severity, STALE, Stale Since)
 * - stale marker correctness from severity + last-verified timestamp policy
 *
 * Targets:
 * - .squidrun/build/errors.md
 * - .squidrun/build/blockers.md
 * - .squidrun/build/status.md
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DOCS = {
  errors: {
    key: 'errors',
    relPath: path.join('.squidrun', 'build', 'errors.md'),
    sectionPatterns: [
      /^## ACTIVE \(Max (\d+)\)$/m,
    ],
    requireTriageSnapshot: true,
  },
  blockers: {
    key: 'blockers',
    relPath: path.join('.squidrun', 'build', 'blockers.md'),
    sectionPatterns: [
      /^## ACTIVE \(Max (\d+)\)$/m,
    ],
    requireTriageSnapshot: true,
  },
  status: {
    key: 'status',
    relPath: path.join('.squidrun', 'build', 'status.md'),
    sectionPatterns: [
      /^## ACTIVE \(Max (\d+)\)$/m,
      /^## Current Priorities \(Max (\d+)\)$/m,
    ],
    requireTriageSnapshot: true,
  },
};

const STALE_HOURS_BY_SEVERITY = {
  CRITICAL: 24,
  HIGH: 24,
  MEDIUM: 72,
  LOW: 168,
};

function printUsage() {
  console.log('Usage: node ui/scripts/doc-lint.js [--docs errors,blockers,status] [--staged] [--root <path>] [--now <iso>]');
  console.log('  --docs   Comma-separated keys. Default: errors,blockers,status');
  console.log('  --staged Lint only staged target docs (pre-commit mode)');
  console.log('  --root   Repo root override (default: inferred from script path)');
  console.log('  --now    Override current time (ISO8601) for deterministic checks');
}

function normalizeRelPath(p) {
  return p.replace(/\\/g, '/');
}

function parseArgs(argv) {
  const args = {
    docs: Object.keys(DOCS),
    stagedOnly: false,
    root: path.resolve(__dirname, '..', '..'),
    now: new Date(),
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--staged') {
      args.stagedOnly = true;
      continue;
    }
    if (token === '--docs' && argv[i + 1]) {
      args.docs = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i++;
      continue;
    }
    if (token === '--root' && argv[i + 1]) {
      args.root = path.resolve(argv[i + 1]);
      i++;
      continue;
    }
    if (token === '--now' && argv[i + 1]) {
      const parsed = new Date(argv[i + 1]);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid --now value: ${argv[i + 1]}`);
      }
      args.now = parsed;
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  for (const key of args.docs) {
    if (!DOCS[key]) {
      throw new Error(`Unknown doc key: ${key}`);
    }
  }

  return args;
}

function getLineNumberAt(text, index) {
  if (index <= 0) return 1;
  let lines = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') lines++;
  }
  return lines;
}

function findSection(content, sectionPatterns) {
  let best = null;

  for (const pattern of sectionPatterns) {
    const match = pattern.exec(content);
    if (!match) continue;
    if (!best || match.index < best.match.index) {
      best = {
        match,
        pattern,
      };
    }
  }

  if (!best) return null;

  const headingStart = best.match.index;
  const headingLineEnd = content.indexOf('\n', headingStart);
  const headingEnd = headingLineEnd === -1 ? content.length : headingLineEnd;
  const sectionStart = headingEnd === content.length ? content.length : headingEnd + 1;

  const nextSectionRegex = /^##\s+/gm;
  nextSectionRegex.lastIndex = sectionStart;
  const nextSection = nextSectionRegex.exec(content);
  const sectionEnd = nextSection ? nextSection.index : content.length;

  const headingText = content.slice(headingStart, headingEnd).trim();
  const cap = Number.parseInt(best.match[1], 10);

  return {
    headingStart,
    headingText,
    headingLine: getLineNumberAt(content, headingStart),
    cap,
    start: sectionStart,
    end: sectionEnd,
  };
}

function parseFields(blockText) {
  const fields = new Map();
  const fieldRegex = /^-\s+([^:\n]+):\s*(.*)$/gm;
  let match;
  while ((match = fieldRegex.exec(blockText)) !== null) {
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    fields.set(key, value);
  }
  return fields;
}

function parseItems(content, section) {
  const sectionText = content.slice(section.start, section.end);
  const itemRegex = /^###\s+(.+)$/gm;
  const rawMatches = [];
  let match;
  while ((match = itemRegex.exec(sectionText)) !== null) {
    rawMatches.push({
      title: match[1].trim(),
      indexInSection: match.index,
      fullMatchLength: match[0].length,
    });
  }

  return rawMatches.map((entry, idx) => {
    const blockStart = entry.indexInSection;
    const blockEnd = idx + 1 < rawMatches.length ? rawMatches[idx + 1].indexInSection : sectionText.length;
    const blockText = sectionText.slice(blockStart + entry.fullMatchLength + 1, blockEnd);
    const absoluteIndex = section.start + entry.indexInSection;
    return {
      title: entry.title,
      line: getLineNumberAt(content, absoluteIndex),
      fields: parseFields(blockText),
    };
  });
}

function parseLastVerified(raw) {
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) by (.+)$/);
  if (!match) return null;
  const stamp = new Date(`${match[1]}T${match[2]}:00`);
  if (Number.isNaN(stamp.getTime())) return null;
  return stamp;
}

function formatLocalMinute(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function normalizeSeverity(raw) {
  if (!raw) return null;
  const match = raw.toUpperCase().match(/CRITICAL|HIGH|MEDIUM|LOW/);
  return match ? match[0] : null;
}

function lintDoc(docConfig, content, now) {
  const issues = [];

  if (docConfig.requireTriageSnapshot && !/^## Triage Snapshot$/m.test(content)) {
    issues.push({
      line: 1,
      message: 'Missing required "## Triage Snapshot" section',
    });
  }

  const section = findSection(content, docConfig.sectionPatterns);
  if (!section) {
    issues.push({
      line: 1,
      message: 'Missing active/capped section (expected "## ACTIVE (Max N)" or "## Current Priorities (Max N)")',
    });
    return issues;
  }

  if (!Number.isFinite(section.cap)) {
    issues.push({
      line: section.headingLine,
      message: `Could not parse cap in heading "${section.headingText}"`,
    });
  } else if (section.cap > 5) {
    issues.push({
      line: section.headingLine,
      message: `Active cap exceeds global limit 5 (found Max ${section.cap})`,
    });
  }

  const items = parseItems(content, section);
  if (Number.isFinite(section.cap) && items.length > section.cap) {
    issues.push({
      line: section.headingLine,
      message: `Active item count ${items.length} exceeds section cap ${section.cap}`,
    });
  }
  if (items.length > 5) {
    issues.push({
      line: section.headingLine,
      message: `Active item count ${items.length} exceeds global cap 5`,
    });
  }

  for (const item of items) {
    const owner = item.fields.get('owner');
    const lastVerifiedRaw = item.fields.get('last verified');
    const severityRaw = item.fields.get('severity');
    const staleRaw = item.fields.get('stale');
    const staleSinceRaw = item.fields.get('stale since');

    if (!owner) {
      issues.push({
        line: item.line,
        message: `Item "${item.title}" is missing required field "Owner"`,
      });
    }

    if (!lastVerifiedRaw) {
      issues.push({
        line: item.line,
        message: `Item "${item.title}" is missing required field "Last Verified"`,
      });
    }

    if (!severityRaw) {
      issues.push({
        line: item.line,
        message: `Item "${item.title}" is missing required field "Severity"`,
      });
    }

    if (!staleRaw) {
      issues.push({
        line: item.line,
        message: `Item "${item.title}" is missing required field "STALE"`,
      });
    }

    if (!staleSinceRaw) {
      issues.push({
        line: item.line,
        message: `Item "${item.title}" is missing required field "Stale Since"`,
      });
    }

    const severity = normalizeSeverity(severityRaw);
    if (!severity) {
      issues.push({
        line: item.line,
        message: `Item "${item.title}" has invalid severity "${severityRaw || ''}"`,
      });
      continue;
    }

    const lastVerified = parseLastVerified(lastVerifiedRaw);
    if (!lastVerified) {
      issues.push({
        line: item.line,
        message: `Item "${item.title}" has invalid Last Verified format. Expected "YYYY-MM-DD HH:MM by <role>"`,
      });
      continue;
    }

    const staleAfterHours = STALE_HOURS_BY_SEVERITY[severity];
    const staleSinceDate = new Date(lastVerified.getTime() + staleAfterHours * 60 * 60 * 1000);
    const expectedStale = now.getTime() >= staleSinceDate.getTime();
    const expectedStaleSince = formatLocalMinute(staleSinceDate);
    const staleNormalized = (staleRaw || '').trim().toUpperCase();
    const staleSinceNormalized = (staleSinceRaw || '').trim();

    if (expectedStale) {
      if (staleNormalized !== 'YES') {
        issues.push({
          line: item.line,
          message: `Item "${item.title}" should be STALE: YES (computed from ${severity} + Last Verified)`,
        });
      }
      if (!staleSinceNormalized || staleSinceNormalized.toLowerCase() === 'n/a') {
        issues.push({
          line: item.line,
          message: `Item "${item.title}" should set "Stale Since: ${expectedStaleSince}"`,
        });
      } else if (staleSinceNormalized !== expectedStaleSince) {
        issues.push({
          line: item.line,
          message: `Item "${item.title}" has stale marker mismatch. Expected "Stale Since: ${expectedStaleSince}"`,
        });
      }
    } else {
      if (staleNormalized !== 'NO') {
        issues.push({
          line: item.line,
          message: `Item "${item.title}" should be STALE: NO (not past threshold)`,
        });
      }
      if (staleSinceNormalized.toLowerCase() !== 'n/a') {
        issues.push({
          line: item.line,
          message: `Item "${item.title}" should use "Stale Since: n/a" while STALE is NO`,
        });
      }
    }
  }

  return issues;
}

function getStagedDocKeys(rootDir) {
  let output = '';
  try {
    output = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const changed = new Set(
    output
      .split(/\r?\n/)
      .map((s) => normalizeRelPath(s.trim()))
      .filter(Boolean)
  );

  return Object.values(DOCS)
    .filter((doc) => changed.has(normalizeRelPath(doc.relPath)))
    .map((doc) => doc.key);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[doc-lint] ${err.message}`);
    printUsage();
    process.exit(2);
  }

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  let docKeys = [...args.docs];
  if (args.stagedOnly) {
    const stagedDocKeys = getStagedDocKeys(args.root);
    docKeys = docKeys.filter((k) => stagedDocKeys.includes(k));
    if (docKeys.length === 0) {
      console.log('[doc-lint] No staged target docs. Skipping.');
      process.exit(0);
    }
  }

  let totalIssues = 0;
  for (const key of docKeys) {
    const doc = DOCS[key];
    const fullPath = path.join(args.root, doc.relPath);
    if (!fs.existsSync(fullPath)) {
      console.error(`[doc-lint] FAIL ${doc.relPath}`);
      console.error('  - file not found');
      totalIssues++;
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const issues = lintDoc(doc, content, args.now);
    if (issues.length === 0) {
      console.log(`[doc-lint] PASS ${doc.relPath}`);
    } else {
      console.error(`[doc-lint] FAIL ${doc.relPath}`);
      for (const issue of issues) {
        console.error(`  - line ${issue.line}: ${issue.message}`);
      }
      totalIssues += issues.length;
    }
  }

  if (totalIssues > 0) {
    console.error(`[doc-lint] ${totalIssues} issue(s) found.`);
    process.exit(1);
  }

  console.log('[doc-lint] All checks passed.');
}

main();
