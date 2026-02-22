#!/usr/bin/env node
/**
 * hm-path-audit
 *
 * Validates critical flow ownership paths from config:
 * - exactly 1 primary path
 * - at most 1 fallback path
 *
 * Usage:
 *   node ui/scripts/hm-path-audit.js [--enforce] [--config <file>]
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_FLOW_IDS = [
  'startup-truth',
  'agent-messaging',
  'handoff-materialization',
];

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'hm-path-audit.config.json');

function parseArgs(argv) {
  const args = {
    enforce: false,
    configPath: DEFAULT_CONFIG_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--enforce') {
      args.enforce = true;
      continue;
    }
    if (token === '--config' && i + 1 < argv.length) {
      args.configPath = path.resolve(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

function normalizePathList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function validateConfig(config) {
  const violations = [];
  const flows = Array.isArray(config && config.flows) ? config.flows : [];

  if (!Array.isArray(config && config.flows)) {
    violations.push('Config must include a top-level "flows" array.');
    return { flows: [], violations };
  }

  const flowById = new Map();
  flows.forEach((flow, index) => {
    const id = typeof flow.id === 'string' ? flow.id.trim() : '';
    if (!id) {
      violations.push(`Flow at index ${index} is missing a valid "id".`);
      return;
    }

    if (!flowById.has(id)) flowById.set(id, []);
    flowById.get(id).push(flow);
  });

  REQUIRED_FLOW_IDS.forEach((id) => {
    const matches = flowById.get(id) || [];
    if (matches.length === 0) {
      violations.push(`Missing required flow "${id}".`);
      return;
    }
    if (matches.length > 1) {
      violations.push(`Flow "${id}" is duplicated (${matches.length} entries).`);
      return;
    }

    const flow = matches[0];
    const primaryPaths = normalizePathList(flow.primaryPaths);
    const fallbackPaths = normalizePathList(flow.fallbackPaths);

    if (primaryPaths.length !== 1) {
      violations.push(`Flow "${id}" must declare exactly 1 primary path (found ${primaryPaths.length}).`);
    }
    if (fallbackPaths.length > 1) {
      violations.push(`Flow "${id}" must declare at most 1 fallback path (found ${fallbackPaths.length}).`);
    }

    primaryPaths.forEach((value) => {
      if (typeof value !== 'string' || !value.trim()) {
        violations.push(`Flow "${id}" includes an empty primary path.`);
      }
    });
    fallbackPaths.forEach((value) => {
      if (typeof value !== 'string' || !value.trim()) {
        violations.push(`Flow "${id}" includes an empty fallback path.`);
      }
    });
  });

  flows.forEach((flow) => {
    const id = typeof flow.id === 'string' ? flow.id.trim() : '';
    if (!id) return;
    if (!REQUIRED_FLOW_IDS.includes(id)) {
      violations.push(`Flow "${id}" is out of scope; this audit is restricted to the 3 critical flows.`);
    }
  });

  return { flows, violations };
}

function summarizeFlow(flow) {
  const name = flow.name || flow.id;
  const primaryPaths = normalizePathList(flow.primaryPaths);
  const fallbackPaths = normalizePathList(flow.fallbackPaths);
  const fallbackLabel = fallbackPaths.length === 0 ? '(none)' : fallbackPaths[0];

  return `- ${name} [${flow.id}] primary=${primaryPaths.join(', ') || '(none)'} fallback=${fallbackLabel}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.enforce ? 'enforce' : 'report';
  const configPath = args.configPath;

  console.log(`[hm-path-audit] mode=${mode}`);
  console.log(`[hm-path-audit] config=${path.relative(process.cwd(), configPath)}`);

  if (!fs.existsSync(configPath)) {
    console.error(`[hm-path-audit] config not found: ${configPath}`);
    process.exit(1);
  }

  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`[hm-path-audit] invalid JSON: ${error.message}`);
    process.exit(1);
  }

  const result = validateConfig(config);

  result.flows.forEach((flow) => {
    console.log(summarizeFlow(flow));
  });

  if (result.violations.length === 0) {
    console.log('[hm-path-audit] PASS: all required flows have valid primary/fallback cardinality.');
    process.exit(0);
  }

  result.violations.forEach((violation) => {
    console.error(`[hm-path-audit] violation: ${violation}`);
  });

  if (args.enforce) {
    console.error('[hm-path-audit] enforce FAIL.');
    process.exit(1);
  }

  console.log('[hm-path-audit] report mode: violations reported without failing.');
}

main();
