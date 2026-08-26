'use strict';

function parseStructuredJsonOutput(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    // Fall through.
  }

  const starts = [];
  for (let idx = 0; idx < text.length; idx += 1) {
    const char = text[idx];
    if (char === '{' || char === '[') {
      starts.push(idx);
    }
  }

  const extractBalancedJson = (startIndex) => {
    const opening = text[startIndex];
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let idx = startIndex; idx < text.length; idx += 1) {
      const char = text[idx];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = inString;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === opening) {
        depth += 1;
      } else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(startIndex, idx + 1);
        }
      }
    }
    return null;
  };

  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const candidate = extractBalancedJson(starts[index]);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (_) {
      // Keep scanning until a balanced JSON block parses.
    }
  }
  return null;
}

function normalizeStartupSummaryLine(value, fallback = 'none') {
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized || fallback;
  }
  if (value && typeof value === 'object') {
    const candidates = [
      value.summary,
      value.title,
      value.body,
      value.detail,
      value.message,
      value.id,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeStartupSummaryLine(candidate, '');
      if (normalized) return normalized;
    }
  }
  return fallback;
}

function takeStartupSummaryItems(items, limit = 2) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items
    .map((item) => normalizeStartupSummaryLine(item, ''))
    .filter(Boolean)
    .slice(0, limit);
}

module.exports = {
  normalizeStartupSummaryLine,
  parseStructuredJsonOutput,
  takeStartupSummaryItems,
};
