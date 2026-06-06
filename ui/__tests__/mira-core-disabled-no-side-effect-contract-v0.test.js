'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONTRACT_PATH = 'ui/__tests__/fixtures/mira-core-disabled-no-side-effect-contract-v0.json';
const repoRoot = path.resolve(__dirname, '..', '..');
const contract = require('./fixtures/mira-core-disabled-no-side-effect-contract-v0.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePath(filePath = '') {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob) {
  const normalized = normalizePath(glob);
  const doubleStar = '__SQUIDRUN_DOUBLE_STAR__';
  const pattern = escapeRegExp(normalized)
    .replace(/\*\*/g, doubleStar)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(doubleStar, 'g'), '.*');
  return new RegExp(`^${pattern}$`);
}

function pathMatchesGlob(filePath, glob) {
  return globToRegExp(glob).test(normalizePath(filePath));
}

function listVisibleWorkingTreeFiles() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return output
    .replace(/\r/g, '')
    .split('\n')
    .map(normalizePath)
    .filter(Boolean)
    .filter((filePath) => fs.existsSync(path.join(repoRoot, filePath)));
}

function setPath(target, pathParts, value) {
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    cursor = cursor[pathParts[index]];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
}

function validateDisabledNoSideEffectContract(candidate) {
  const errors = [];
  const allowedClassifications = new Set(candidate.allowed_disabled_classifications || []);
  const disallowedTokens = candidate.disallowed_disabled_classification_tokens || [];

  if (candidate.schema !== 'squidrun.mira_core.disabled_no_side_effect_contract.v0') {
    errors.push({ id: 'schema_mismatch', path: 'schema' });
  }

  for (const family of candidate.disabled_families || []) {
    const classification = String(family.classification || '');
    const status = String(family.status || '');
    const familyText = `${classification} ${status}`;

    if (!allowedClassifications.has(classification)) {
      errors.push({ id: 'classification_not_allowed', family: family.id, classification });
    }

    for (const token of disallowedTokens) {
      if (new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(familyText)) {
        errors.push({ id: 'classification_disallowed', family: family.id, token });
      }
    }

    if (!Array.isArray(family.path_globs) || family.path_globs.length === 0) {
      errors.push({ id: 'family_without_path_globs', family: family.id });
    }
  }

  for (const flag of candidate.required_side_effect_flags || []) {
    if (candidate.side_effect_flags?.[flag] !== false) {
      errors.push({ id: 'side_effect_flag_true', flag, value: candidate.side_effect_flags?.[flag] });
    }
  }

  for (const counter of candidate.required_side_effect_counters || []) {
    if (candidate.side_effect_counters?.[counter] !== 0) {
      errors.push({
        id: 'side_effect_counter_nonzero',
        counter,
        value: candidate.side_effect_counters?.[counter],
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function disabledFamilyEntries(candidate = contract) {
  return candidate.disabled_families.flatMap((family) => (
    family.path_globs.map((glob) => ({
      familyId: family.id,
      classification: family.classification,
      glob,
      basenameGlob: path.posix.basename(glob)
        .replace(/\.test\.js$/, '')
        .replace(/-contract\.json$/, '-contract')
        .replace(/\.js$/, ''),
      regex: globToRegExp(glob),
      basenameRegex: globToRegExp(path.posix.basename(glob)
        .replace(/\.test\.js$/, '')
        .replace(/-contract\.json$/, '-contract')
        .replace(/\.js$/, '')),
    }))
  ));
}

function findDisabledInventory(files, candidate = contract) {
  const familyEntries = disabledFamilyEntries(candidate);
  return files.flatMap((filePath) => {
    const matches = familyEntries.filter((entry) => entry.regex.test(filePath));
    return matches.map((entry) => ({ filePath, ...entry }));
  });
}

function isExecutableSource(filePath) {
  return /\.(?:cjs|js|mjs|ts|tsx)$/i.test(filePath)
    && !filePath.startsWith('docs/');
}

function stripKnownExtension(value) {
  return String(value || '')
    .replace(/\.test\.js$/i, '')
    .replace(/-contract\.json$/i, '-contract')
    .replace(/\.(?:cjs|js|mjs|ts|tsx|json)$/i, '');
}

function stringLiterals(value = '') {
  return [...String(value).matchAll(/(['"])((?:\\.|(?!\1).)*?)\1/g)]
    .map((match) => match[2])
    .filter(Boolean);
}

function extractConsumerTargets(text = '') {
  const targets = [];
  const addTarget = (kind, value, context = '') => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    targets.push({ kind, value: normalized, context });
  };

  for (const match of String(text).matchAll(/\b(?:require|import)\s*\(([^;]*?)\)/gms)) {
    for (const literal of stringLiterals(match[1])) {
      addTarget('dynamic_import_or_require', literal, match[0]);
    }
  }

  for (const match of String(text).matchAll(/\bimport\s+(['"])((?:\\.|(?!\1).)*?)\1/gm)) {
    addTarget('side_effect_import', match[2], match[0]);
  }

  for (const match of String(text).matchAll(/\bfrom\s+(['"])((?:\\.|(?!\1).)*?)\1/gm)) {
    addTarget('static_import', match[2], match[0]);
  }

  for (const match of String(text).matchAll(/\b(?:\w+\.)?(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(([^;]*?)\)/gms)) {
    for (const literal of stringLiterals(match[1])) {
      addTarget('child_process_execution', literal, match[0]);
    }
  }

  return targets;
}

function targetMatchesDisabledEntry(target, candidatePath, entry) {
  const value = normalizePath(target.value);
  const valueWithoutExtension = stripKnownExtension(value);
  const valueBasename = stripKnownExtension(path.posix.basename(value));

  if (
    entry.regex.test(value)
    || entry.regex.test(`${value}.js`)
    || entry.regex.test(`${value}.json`)
    || entry.regex.test(`${valueWithoutExtension}.js`)
    || entry.regex.test(`${valueWithoutExtension}.json`)
  ) {
    return true;
  }

  if (!entry.basenameRegex.test(valueBasename)) return false;

  if (target.kind === 'child_process_execution') {
    return valueBasename.startsWith('hm-mira-core-');
  }

  if (entry.glob.startsWith('ui/scripts/')) {
    return valueBasename.startsWith('hm-mira-core-');
  }

  if (entry.glob.startsWith('ui/modules/mira-core/')) {
    return candidatePath.startsWith('ui/modules/mira-core/')
      || value.includes('mira-core')
      || value.startsWith('./')
      || value.startsWith('../modules/mira-core/');
  }

  if (entry.glob.startsWith('ui/__tests__/fixtures/')) {
    return candidatePath.startsWith('ui/__tests__');
  }

  if (entry.glob.startsWith('ui/__tests__/')) {
    return candidatePath.startsWith('ui/__tests__');
  }

  return false;
}

function findConsumerMatches({ candidatePath, text, familyEntries }) {
  const targets = extractConsumerTargets(text);
  const matches = [];

  for (const target of targets) {
    for (const entry of familyEntries) {
      if (!targetMatchesDisabledEntry(target, candidatePath, entry)) continue;
      matches.push({
        candidatePath,
        familyId: entry.familyId,
        glob: entry.glob,
        kind: target.kind,
        target: target.value,
      });
    }
  }

  return matches;
}

function extractProjectPathReferences(text = '') {
  return [...String(text).matchAll(/\bui\/(?:modules\/mira-core|scripts|__tests__|__tests__\/fixtures)\/[A-Za-z0-9_.\/-]+/g)]
    .map((match) => normalizePath(match[0]).replace(/[),.;:]+$/g, ''))
    .filter(Boolean);
}

describe('Mira core disabled no-side-effect contract v0', () => {
  test('classifies parked scaffold families as disabled and rejects live/ready status', () => {
    const validation = validateDisabledNoSideEffectContract(contract);

    expect(validation).toEqual({ ok: true, errors: [] });
    expect(contract.disabled_families.map((family) => family.id)).toEqual([
      'runtime_scaffold',
      'server_scaffold',
      'kill_switch_scaffold',
      'phase49_66_rollup_lineage',
      'auth_encryption_storage_identity_scaffold',
    ]);
  });

  test('keeps required side-effect flags false and counters zero', () => {
    for (const flag of contract.required_side_effect_flags) {
      expect(contract.side_effect_flags).toHaveProperty(flag, false);
    }

    for (const counter of contract.required_side_effect_counters) {
      expect(contract.side_effect_counters).toHaveProperty(counter, 0);
    }
  });

  test('rejects negative fixtures that try to enable side effects or live status', () => {
    for (const negativeFixture of contract.negative_fixtures) {
      const mutated = clone(contract);
      for (const mutation of negativeFixture.mutations) {
        setPath(mutated, mutation.path, mutation.value);
      }

      const validation = validateDisabledNoSideEffectContract(mutated);

      expect(validation.ok).toBe(false);
      expect(validation.errors.some((error) => error.id === negativeFixture.expected_error_id))
        .toBe(true);
    }
  });

  test('does not classify protected live Mira paths as disabled scaffold', () => {
    const files = listVisibleWorkingTreeFiles();
    const disabledInventory = findDisabledInventory(files);
    const disabledPathSet = new Set(disabledInventory.map((entry) => entry.filePath));

    for (const livePath of contract.protected_live_paths) {
      const absolutePath = path.join(repoRoot, livePath);
      expect(fs.existsSync(absolutePath)).toBe(true);
      expect(disabledPathSet.has(livePath)).toBe(false);
    }
  });

  test('scanner catches import and child-process execution forms used by live consumers', () => {
    const familyEntries = disabledFamilyEntries();
    const cases = [
      {
        name: 'side-effect import',
        candidatePath: 'ui/modules/mira-core/live-consumer.js',
        text: "import './runtime-harness';",
      },
      {
        name: 'whitespace require',
        candidatePath: 'ui/modules/mira-core/live-consumer.js',
        text: "const runtime = require ('./runtime-harness');",
      },
      {
        name: 'whitespace dynamic import',
        candidatePath: 'ui/modules/mira-core/live-consumer.js',
        text: "const runtime = import ('./runtime-harness');",
      },
      {
        name: 'computed require basename literal',
        candidatePath: 'ui/modules/mira-core/live-consumer.js',
        text: "const runtime = require(path.join(__dirname, 'runtime-harness'));",
      },
      {
        name: 'spawned disabled wrapper',
        candidatePath: 'ui/modules/live-consumer.js',
        text: "spawn(process.execPath, ['ui/scripts/hm-mira-core-runtime-harness.js']);",
      },
      {
        name: 'execFile disabled wrapper',
        candidatePath: 'ui/__tests__/live-consumer.test.js',
        text: "execFile(process.execPath, ['ui/scripts/hm-mira-core-kill-switch-wiring-safety.js']);",
      },
    ];

    for (const entry of cases) {
      const matches = findConsumerMatches({
        candidatePath: entry.candidatePath,
        text: entry.text,
        familyEntries,
      });

      expect(matches.length).toBeGreaterThan(0);
    }
  });

  test('finds no live source consumers for the disabled family outside its own collapse set', () => {
    const files = listVisibleWorkingTreeFiles();
    const disabledInventory = findDisabledInventory(files);
    const disabledPathSet = new Set(disabledInventory.map((entry) => entry.filePath));
    const familyEntries = disabledFamilyEntries();
    const allowedConsumerPaths = new Set(contract.allowed_consumer_reference_paths);
    const violations = [];

    for (const candidatePath of files) {
      if (
        disabledPathSet.has(candidatePath)
        || allowedConsumerPaths.has(candidatePath)
        || !isExecutableSource(candidatePath)
      ) {
        continue;
      }
      const absolutePath = path.join(repoRoot, candidatePath);
      if (!fs.statSync(absolutePath).isFile()) continue;
      const text = fs.readFileSync(absolutePath, 'utf8');
      violations.push(...findConsumerMatches({ candidatePath, text, familyEntries }));
    }

    expect(violations).toEqual([]);
  });

  test('docs and architecture do not leave exact disabled-family path references dangling', () => {
    const familyEntries = disabledFamilyEntries();
    const checkedDocs = [
      'ARCHITECTURE.md',
      'docs/codebase-index.md',
    ];
    const danglingReferences = [];

    for (const docPath of checkedDocs) {
      const text = fs.readFileSync(path.join(repoRoot, docPath), 'utf8');
      for (const ref of extractProjectPathReferences(text)) {
        if (!familyEntries.some((entry) => entry.regex.test(ref))) continue;
        if (fs.existsSync(path.join(repoRoot, ref))) continue;
        danglingReferences.push({ docPath, ref });
      }
    }

    expect(danglingReferences).toEqual([]);
  });

  test('documents the contract in the Mira system map without executing old modules', () => {
    const systemMap = fs.readFileSync(path.join(repoRoot, 'docs/mira-system-map.md'), 'utf8');

    expect(systemMap).toContain(CONTRACT_PATH);
    expect(systemMap).toContain('disabled/no-side-effect contract');
    expect(systemMap).toContain('emit/reply/route/seed');
  });
});
