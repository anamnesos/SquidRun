#!/usr/bin/env node
'use strict';

const {
  CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY,
  runSystemProtectedEvals,
} = require('../modules/main/system-protected-evals');

function setOption(options, key, value) {
  if (Object.prototype.hasOwnProperty.call(options, key)) {
    if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = [options[key], value];
  } else {
    options[key] = value;
  }
}

function parseArgs(argv = []) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token) continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eqIndex = token.indexOf('=');
    if (eqIndex > 2) {
      setOption(options, token.slice(2, eqIndex), token.slice(eqIndex + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith('--')) {
      setOption(options, key, true);
      continue;
    }
    setOption(options, key, next);
    index += 1;
  }
  return { positional, options };
}

function getOption(options, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(options, key)) return options[key];
  }
  return null;
}

function normalizeCaseIds(value) {
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const entry of raw) {
    if (!entry || entry === true) continue;
    for (const part of String(entry).split(',')) {
      const text = part.trim();
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

function usage() {
  return {
    ok: true,
    usage: [
      'node ui/scripts/hm-system-protected-evals.js --case phase4a.accepted_unverified_never_visible_delivery --pretty',
      'node ui/scripts/hm-system-protected-evals.js --list',
    ],
    defaultCase: CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY,
  };
}

function printJson(payload, pretty = false) {
  console.log(JSON.stringify(payload, null, pretty ? 2 : 0));
}

function main(argv = process.argv.slice(2)) {
  const { options } = parseArgs(argv);
  const pretty = getOption(options, 'pretty') === true;
  if (getOption(options, 'help', 'h') === true) {
    printJson(usage(), pretty);
    return 0;
  }
  const caseIds = normalizeCaseIds(getOption(options, 'case', 'case-id'));
  const report = runSystemProtectedEvals({ caseIds });
  if (getOption(options, 'list') === true) {
    printJson({
      ok: true,
      schema: report.schema,
      cases: report.cases.map((evalCase) => ({
        id: evalCase.id,
        title: evalCase.title,
        phase: evalCase.phase,
        protectedZeroFail: evalCase.protectedZeroFail,
      })),
    }, pretty);
    return 0;
  }
  printJson(report, pretty);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    printJson({ ok: false, reason: err.message || String(err) }, true);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  normalizeCaseIds,
  parseArgs,
};
