/**
 * Auto-learning extractor
 * Detects learning statements in agent conversations and returns structured learnings.
 */

const MAX_SCAN_CHARS = 20000;
const MAX_LEARNING_LENGTH = 1200;
const RECENT_MAX = 500;
const RECENT_TTL_MS = 60 * 60 * 1000; // 1 hour

const recentKeys = new Map(); // key -> timestamp

const PATTERNS = [
  {
    category: 'pattern',
    confidence: 0.85,
    regex: /(?:^|\n)\s*(?:i|we)\s+learned\s+that\s+(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'pattern',
    confidence: 0.8,
    regex: /(?:^|\n)\s*lesson\s+learned[:\-]\s*(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'pattern',
    confidence: 0.75,
    regex: /(?:^|\n)\s*best\s+practice[:\-]\s*(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'bug',
    confidence: 0.85,
    regex: /(?:^|\n)\s*root\s+cause\s*(?:was|is|:)\s*(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'bug',
    confidence: 0.8,
    regex: /(?:^|\n)\s*the\s+issue\s+was\s*(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'bug',
    confidence: 0.8,
    regex: /(?:^|\n)\s*the\s+problem\s+was\s*(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'solution',
    confidence: 0.85,
    regex: /(?:^|\n)\s*the\s+fix\s+(?:is|was|:)\s*(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'solution',
    confidence: 0.8,
    regex: /(?:^|\n)\s*fix(?:ed)?\s*(?:by|is|was|:)\s*(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'solution',
    confidence: 0.8,
    regex: /(?:^|\n)\s*resolved\s+by\s+(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'solution',
    confidence: 0.75,
    regex: /(?:^|\n)\s*solution\s*(?:is|was|:)\s*(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'warning',
    confidence: 0.8,
    regex: /(?:^|\n)\s*warning[:\-]\s*(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'warning',
    confidence: 0.75,
    regex: /(?:^|\n)\s*we\s+should\s+avoid\s+(.+?)(?:[.!?\n]|$)/gi
  },
  {
    category: 'warning',
    confidence: 0.7,
    regex: /(?:^|\n)\s*beware\s+of\s+(.+?)(?:[.!?\n]|$)/gi
  }
];

function cleanExtract(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/^[\-\*\:\s]+/, '').replace(/[\s\.\,;:]+$/, '');
  if (cleaned.length > MAX_LEARNING_LENGTH) {
    cleaned = cleaned.slice(0, MAX_LEARNING_LENGTH) + '...';
  }
  return cleaned;
}

function pruneRecent() {
  if (recentKeys.size <= RECENT_MAX) return;
  const now = Date.now();
  for (const [key, timestamp] of recentKeys.entries()) {
    if (now - timestamp > RECENT_TTL_MS || recentKeys.size > RECENT_MAX) {
      recentKeys.delete(key);
    }
  }
}

function seenRecently(category, content) {
  const key = `${category}:${content.toLowerCase()}`;
  const now = Date.now();
  if (recentKeys.has(key) && (now - recentKeys.get(key)) < RECENT_TTL_MS) {
    return true;
  }
  recentKeys.set(key, now);
  pruneRecent();
  return false;
}

function extractLearnings(text, options = {}) {
  if (!text || typeof text !== 'string') return [];
  const input = text.slice(0, MAX_SCAN_CHARS);
  const results = [];

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(input)) !== null) {
      const extracted = cleanExtract(match[1] || match[0]);
      if (!extracted || extracted.length < 8) continue;
      if (seenRecently(pattern.category, extracted)) continue;

      results.push({
        category: pattern.category,
        topic: pattern.category,
        content: extracted,
        confidence: pattern.confidence,
        pattern: pattern.regex.source,
        sourceHint: options.sourceHint || null
      });
    }
  }

  return results;
}

module.exports = {
  extractLearnings
};
