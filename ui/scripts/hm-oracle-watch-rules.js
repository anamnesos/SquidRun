#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_RULES_PATH,
  DEFAULT_STATE_PATH,
  defaultRulesConfig,
  loadRulesConfig,
  loadWatchState,
  normalizeMode,
  normalizeTicker,
} = require('./hm-oracle-watch-engine');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function writeJsonFile(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;
    options.set(key, value);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function parseJsonOption(value, label = 'json') {
  try {
    return JSON.parse(String(value || ''));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function upsertRule(config, rule = {}) {
  const normalizedRule = {
    ...rule,
    ticker: normalizeTicker(rule.ticker),
  };
  const existingIndex = (config.rules || []).findIndex((entry) => entry.id === normalizedRule.id);
  if (existingIndex >= 0) {
    config.rules[existingIndex] = {
      ...config.rules[existingIndex],
      ...normalizedRule,
    };
  } else {
    config.rules.push(normalizedRule);
  }
  return config;
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const command = parsed.positional[0] || 'show';
  const rulesPath = path.resolve(toText(getOption(parsed.options, 'rules', DEFAULT_RULES_PATH), DEFAULT_RULES_PATH));
  const statePath = path.resolve(toText(getOption(parsed.options, 'state', DEFAULT_STATE_PATH), DEFAULT_STATE_PATH));
  let config = loadRulesConfig(rulesPath, { statePath });

  if (command === 'init') {
    config = defaultRulesConfig();
    writeJsonFile(rulesPath, config);
    console.log(JSON.stringify({ ok: true, command, rulesPath, config }, null, 2));
    return;
  }

  if (command === 'show') {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (command === 'set-mode') {
    config.mode = normalizeMode(parsed.positional[1] || getOption(parsed.options, 'mode', 'normal'));
    writeJsonFile(rulesPath, config);
    console.log(JSON.stringify({ ok: true, command, mode: config.mode, rulesPath }, null, 2));
    return;
  }

  if (command === 'set-hot') {
    const symbols = String(getOption(parsed.options, 'symbols', parsed.positional[1] || ''))
      .split(',')
      .map((entry) => normalizeTicker(entry))
      .filter(Boolean)
      .slice(0, 2);
    config.hotSymbols = symbols;
    writeJsonFile(rulesPath, config);
    console.log(JSON.stringify({ ok: true, command, hotSymbols: config.hotSymbols, rulesPath }, null, 2));
    return;
  }

  if (command === 'add' || command === 'upsert') {
    let rule = null;
    if (getOption(parsed.options, 'json', null)) {
      rule = parseJsonOption(getOption(parsed.options, 'json', ''), 'rule json');
    } else if (getOption(parsed.options, 'file', null)) {
      rule = JSON.parse(fs.readFileSync(path.resolve(String(getOption(parsed.options, 'file', ''))), 'utf8'));
    }
    if (!rule || !rule.id || !rule.ticker || !rule.trigger) {
      throw new Error('Rule add/upsert requires id, ticker, and trigger.');
    }
    config = upsertRule(config, rule);
    writeJsonFile(rulesPath, config);
    console.log(JSON.stringify({ ok: true, command, ruleId: rule.id, rulesPath }, null, 2));
    return;
  }

  if (command === 'remove') {
    const id = toText(parsed.positional[1] || getOption(parsed.options, 'id', ''));
    config.rules = (config.rules || []).filter((rule) => rule.id !== id);
    writeJsonFile(rulesPath, config);
    console.log(JSON.stringify({ ok: true, command, ruleId: id, rulesPath }, null, 2));
    return;
  }

  if (command === 'toggle') {
    const id = toText(parsed.positional[1] || getOption(parsed.options, 'id', ''));
    const enabled = String(getOption(parsed.options, 'enabled', parsed.positional[2] || 'true')).toLowerCase() !== 'false';
    config.rules = (config.rules || []).map((rule) => rule.id === id ? { ...rule, enabled } : rule);
    writeJsonFile(rulesPath, config);
    console.log(JSON.stringify({ ok: true, command, ruleId: id, enabled, rulesPath }, null, 2));
    return;
  }

  if (command === 'mark-acted') {
    const id = toText(parsed.positional[1] || getOption(parsed.options, 'id', ''));
    if (!id) {
      throw new Error('mark-acted requires a rule id.');
    }
    const note = toText(getOption(parsed.options, 'note', parsed.positional[2] || ''), '');
    const state = loadWatchState(statePath);
    const now = new Date().toISOString();
    const nextRuleState = {
      ...(state.rules?.[id] || {}),
      actedOnAt: now,
      actedOnNote: note || null,
      actedOnCount: Number(state.rules?.[id]?.actedOnCount || 0) + 1,
    };
    state.rules = {
      ...(state.rules || {}),
      [id]: nextRuleState,
    };
    state.counters = {
      ...(state.counters || {}),
      triggersActedOn: Number(state.counters?.triggersActedOn || 0) + 1,
    };
    state.updatedAt = now;
    writeJsonFile(statePath, state);
    console.log(JSON.stringify({ ok: true, command, ruleId: id, statePath, actedOnAt: now, note: nextRuleState.actedOnNote }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  parseCliArgs,
  upsertRule,
  main,
};
