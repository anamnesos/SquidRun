'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');

const DEFAULT_SUGGESTION_LOG_PATH = resolveCoordPath(path.join('runtime', 'setup-suggestions.jsonl'), { forWrite: true });
const DEFAULT_HORIZONS_MINUTES = [30, 60, 240];

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function appendSuggestionProposalRecords(records = [], options = {}) {
  const suggestionLogPath = options.suggestionLogPath || DEFAULT_SUGGESTION_LOG_PATH;
  const normalized = (Array.isArray(records) ? records : []).map((record) => ({
    ...record,
    kind: 'proposal',
    recordedAt: new Date().toISOString(),
  }));
  ensureDir(suggestionLogPath);
  if (normalized.length > 0) {
    fs.appendFileSync(
      suggestionLogPath,
      `${normalized.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
  }
  return {
    ok: true,
    count: normalized.length,
    path: suggestionLogPath,
  };
}

async function settleSuggestionOutcomes(options = {}) {
  return {
    ok: true,
    settledCount: 0,
    horizonsMinutes: Array.isArray(options.horizonsMinutes) ? options.horizonsMinutes : DEFAULT_HORIZONS_MINUTES,
    path: options.suggestionLogPath || DEFAULT_SUGGESTION_LOG_PATH,
    settledAt: new Date().toISOString(),
  };
}

module.exports = {
  DEFAULT_SUGGESTION_LOG_PATH,
  DEFAULT_HORIZONS_MINUTES,
  appendSuggestionProposalRecords,
  settleSuggestionOutcomes,
};
