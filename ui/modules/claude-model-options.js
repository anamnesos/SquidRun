'use strict';

const CLAUDE_MODEL_SELECTOR_OPTIONS = Object.freeze([
  Object.freeze({ value: 'claude', label: 'Claude', model: '' }),
  Object.freeze({ value: 'claude:fable', label: 'Claude Fable 5', model: 'claude-fable-5' }),
  Object.freeze({ value: 'claude:opus', label: 'Claude Opus', model: 'opus' }),
  Object.freeze({ value: 'claude:sonnet', label: 'Claude Sonnet', model: 'sonnet' }),
]);

const CLAUDE_MODEL_FLAG_PATTERN = /(?:^|\s)--model(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i;

function normalizeClaudeModelId(value = '') {
  const cleaned = String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\[\d+(?:;\d+)*m\]/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!cleaned) return '';
  return /^[a-z0-9][a-z0-9._:-]*$/i.test(cleaned) ? cleaned : '';
}

function parseClaudeModelFromCommand(command = '') {
  const match = String(command || '').match(CLAUDE_MODEL_FLAG_PATTERN);
  return match ? normalizeClaudeModelId(match[1] || match[2] || match[3] || '') : '';
}

function claudeModelForSelectorValue(value = '') {
  const normalizedValue = String(value || '').trim().toLowerCase();
  const option = CLAUDE_MODEL_SELECTOR_OPTIONS.find((entry) => entry.value === normalizedValue);
  if (option) return option.model;
  if (normalizedValue.startsWith('claude:')) {
    return normalizeClaudeModelId(normalizedValue.slice('claude:'.length));
  }
  return '';
}

function selectorValueForClaudeModel(model = '') {
  const normalizedModel = normalizeClaudeModelId(model).toLowerCase();
  if (!normalizedModel) return 'claude';
  const exact = CLAUDE_MODEL_SELECTOR_OPTIONS.find((entry) => entry.model.toLowerCase() === normalizedModel);
  if (exact) return exact.value;
  if (normalizedModel.includes('fable')) return 'claude:fable';
  if (normalizedModel.includes('opus')) return 'claude:opus';
  if (normalizedModel.includes('sonnet')) return 'claude:sonnet';
  return 'claude';
}

function selectorValueForCommand(command = '', fallbackModel = 'claude') {
  const family = String(fallbackModel || '').trim().toLowerCase();
  if (family !== 'claude') return family || 'claude';
  return selectorValueForClaudeModel(parseClaudeModelFromCommand(command));
}

module.exports = {
  CLAUDE_MODEL_SELECTOR_OPTIONS,
  normalizeClaudeModelId,
  parseClaudeModelFromCommand,
  claudeModelForSelectorValue,
  selectorValueForClaudeModel,
  selectorValueForCommand,
};
