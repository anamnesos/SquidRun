/**
 * Token estimation utilities
 * Extracted from memory-summarizer for standalone use.
 */

const DEFAULT_TOKENS_PER_WORD = 1.3;
const DEFAULT_CHARS_PER_TOKEN = 4;
const MAX_CONTENT_LENGTH = 500;

function estimateTokens(text, options = {}) {
  if (!text) return 0;
  const tokensPerWord = options.tokensPerWord || DEFAULT_TOKENS_PER_WORD;
  const charsPerToken = options.charsPerToken || DEFAULT_CHARS_PER_TOKEN;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const byWords = Math.ceil(wordCount * tokensPerWord);
  const byChars = Math.ceil(text.length / charsPerToken);
  return Math.max(byWords, byChars);
}

function truncateToTokenBudget(text, budget, options = {}) {
  if (!text || budget <= 0) return '';
  const estimate = estimateTokens(text, options);
  if (estimate <= budget) return text;
  const charsPerToken = options.charsPerToken || DEFAULT_CHARS_PER_TOKEN;
  const maxChars = Math.max(20, Math.floor(budget * charsPerToken));
  return truncateContent(text, maxChars);
}

function truncateContent(content, maxLength = MAX_CONTENT_LENGTH) {
  if (!content) return '';
  if (content.length <= maxLength) return content;
  const truncated = content.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastNewline = truncated.lastIndexOf('\n');
  const breakPoint = Math.max(lastPeriod, lastNewline);
  if (breakPoint > maxLength * 0.5) {
    return truncated.slice(0, breakPoint + 1) + '...';
  }
  return truncated + '...';
}

module.exports = { estimateTokens, truncateToTokenBudget, truncateContent };
