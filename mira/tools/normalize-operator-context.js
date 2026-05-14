#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE = path.join('workspace', 'knowledge', 'user-context.md');
const DEFAULT_DESTINATION = path.join('context', 'operator', 'operator-context.normalized.json');

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    source: DEFAULT_SOURCE,
    destination: null,
    stateRoot: process.env.MIRA_STATE_ROOT || '',
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--source' && next) {
      parsed.source = next;
      index += 1;
      continue;
    }
    if (token === '--state-root' && next) {
      parsed.stateRoot = next;
      index += 1;
      continue;
    }
    if (token === '--destination' && next) {
      parsed.destination = next;
      index += 1;
      continue;
    }
    if (token === '--write') {
      parsed.write = true;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${token}`);
  }

  return parsed;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeOperatorContext(sourcePath = DEFAULT_SOURCE) {
  const resolvedSource = path.resolve(sourcePath);
  const sourceText = fs.readFileSync(resolvedSource, 'utf8');
  const thesisLine = sourceText
    .split(/\r?\n/)
    .find((line) => line.includes('Mira product/business thesis:'));

  if (!thesisLine) {
    throw new Error('Mira product/business thesis line not found in source context.');
  }

  return {
    schema: 'mira.normalized.operator_context.v1',
    business_thesis: 'Mira is intended to become James operating extension for CRM, ERP, admin, customer communication, tax, documents, computer-use, and business workflows.',
    operating_lanes: [
      'CRM',
      'ERP',
      'admin',
      'customer communication',
      'tax',
      'documents',
      'computer-use',
      'business workflows',
    ],
    known_product_lanes: ['TrustQuote'],
    explicit_non_claims: [
      'Mira is not a chatbot, lab demo, trading layer, or comfort layer.',
      'TrustQuote is a known operating/product lane, not proof of the business legal/name identity.',
      'Do not invent James business name.',
    ],
    source_metadata: {
      source_path: DEFAULT_SOURCE,
      source_sha_scope: 'not_computed_v0',
      metadata_only: true,
      live_continuity_excluded: true,
      raw_content_included: false,
      normalized_summary_only: true,
      source_line_matched: 'Mira product/business thesis',
    },
  };
}

function run(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const sourcePath = path.resolve(options.cwd || process.cwd(), args.source);
  const normalized = normalizeOperatorContext(sourcePath);
  const payload = {
    ok: true,
    dryRun: !args.write,
    schema: normalized.schema,
    sourcePath,
    destinationRelativePath: DEFAULT_DESTINATION,
    normalized,
  };

  if (args.write) {
    if (!args.stateRoot || !String(args.stateRoot).trim()) {
      throw new Error('--state-root or MIRA_STATE_ROOT is required with --write.');
    }
    const stateRoot = path.resolve(args.stateRoot);
    const destination = path.resolve(stateRoot, args.destination || DEFAULT_DESTINATION);
    if (!isInside(stateRoot, destination)) {
      throw new Error('Destination escapes state root.');
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx' });
    payload.dryRun = false;
    payload.destinationPath = destination;
  }

  return payload;
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_DESTINATION,
  normalizeOperatorContext,
  run,
};
