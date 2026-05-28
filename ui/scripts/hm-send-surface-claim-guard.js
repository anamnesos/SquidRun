const fs = require('fs');
const path = require('path');

const USER_FACING_TARGETS = new Set(['user', 'telegram']);
const IMAGE_PATH_RE = /(?:[A-Za-z]:[\\/][^"'<>|\r\n)]+?\.(?:png|jpe?g|webp)|\/[^"'<>|\r\n)]+?\.(?:png|jpe?g|webp))/gi;
const QUOTED_IMAGE_PATH_RE = /["'`]([^"'`\r\n]+?\.(?:png|jpe?g|webp))["'`]/gi;
const MARKDOWN_IMAGE_TARGET_RE = /\]\(([^)\r\n]+?\.(?:png|jpe?g|webp))\)/gi;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'are', 'was', 'were',
  'have', 'has', 'had', 'but', 'not', 'from', 'into', 'they', 'them', 'him', 'her',
  'his', 'she', 'our', 'out', 'what', 'when', 'where', 'why', 'how', 'all', 'can',
  'just', 'about', 'there', 'then', 'than', 'been', 'being', 'still', 'like',
]);

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeRole(value) {
  const text = asText(value).toLowerCase();
  if (text === '1' || text === 'main') return 'architect';
  if (text === '2') return 'builder';
  if (text === '3') return 'oracle';
  return text;
}

function isUserFacingTarget(targetRole, targetRaw) {
  return USER_FACING_TARGETS.has(normalizeRole(targetRole))
    || USER_FACING_TARGETS.has(normalizeRole(targetRaw));
}

function rowTimestampMs(row = {}) {
  for (const value of [row.brokeredAtMs, row.brokered_at_ms, row.sentAtMs, row.sent_at_ms, row.updatedAtMs, row.updated_at_ms, row.timestampMs, row.ts]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

function extractRowBody(row = {}) {
  return asText(row.rawBody ?? row.raw_body ?? row.body ?? row.message ?? row.content ?? '');
}

function normalizeUserPointText(value) {
  return asText(value)
    .replace(/^\s*\[[^\]]+\]\s*/g, ' ')
    .replace(/^\s*\((?:ARCHITECT|ARCH|BUILDER|ORACLE|USER|JAMES)\s*#?\d*\)\s*:?\s*/i, ' ')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`"'’‘“”()[\]{}<>]/g, ' ')
    .replace(/[^a-z0-9$]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensForPoint(value) {
  const normalized = normalizeUserPointText(value);
  if (!normalized) return [];
  return Array.from(new Set(
    (normalized.match(/[a-z0-9$]+/g) || [])
      .filter((token) => token.length > 2 || /^\$\d+$/.test(token))
      .filter((token) => !STOPWORDS.has(token))
  ));
}

function tokenOverlapScore(leftTokens = [], rightTokens = []) {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  const smaller = Math.min(left.size, right.size);
  if (smaller <= 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / smaller;
}

function findLatestUserRepeat(rows = [], options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const windowMs = Math.max(1, Number(options.windowMs) || 90 * 60 * 1000);
  const minOverlap = Number.isFinite(Number(options.minOverlap)) ? Number(options.minOverlap) : 0.6;
  const ordered = (Array.isArray(rows) ? rows : [])
    .filter((row) => normalizeRole(row.senderRole ?? row.sender_role ?? row.sender) === 'user')
    .sort((left, right) => rowTimestampMs(right) - rowTimestampMs(left));
  const latest = ordered[0] || null;
  if (!latest) return null;
  const latestTs = rowTimestampMs(latest) || nowMs;
  if (nowMs - latestTs > windowMs) return null;
  const latestTokens = tokensForPoint(extractRowBody(latest));
  if (latestTokens.length < 3) return null;

  for (const candidate of ordered.slice(1)) {
    const candidateTs = rowTimestampMs(candidate);
    if (candidateTs && latestTs - candidateTs > windowMs) continue;
    const candidateTokens = tokensForPoint(extractRowBody(candidate));
    if (candidateTokens.length < 3) continue;
    const score = tokenOverlapScore(latestTokens, candidateTokens);
    if (score >= minOverlap) {
      return {
        latest,
        previous: candidate,
        score,
        latestBody: extractRowBody(latest),
        previousBody: extractRowBody(candidate),
        latestMessageId: latest.messageId || latest.message_id || null,
        previousMessageId: candidate.messageId || candidate.message_id || null,
        latestAtMs: latestTs || null,
        previousAtMs: candidateTs || null,
      };
    }
  }
  return null;
}

function stripTrailingPathPunctuation(value) {
  return asText(value).replace(/[.,;:!?]+$/g, '');
}

function extractImagePaths(content) {
  const paths = [];
  const text = asText(content);
  for (const match of text.matchAll(QUOTED_IMAGE_PATH_RE)) {
    const candidate = stripTrailingPathPunctuation(match[1]);
    if (candidate) paths.push(candidate);
  }
  for (const match of text.matchAll(MARKDOWN_IMAGE_TARGET_RE)) {
    const candidate = stripTrailingPathPunctuation(match[1]);
    if (candidate) paths.push(candidate);
  }
  for (const match of text.matchAll(IMAGE_PATH_RE)) {
    const candidate = stripTrailingPathPunctuation(match[0]);
    if (candidate) paths.push(candidate);
  }
  return Array.from(new Set(paths));
}

function hasExistingSurfaceArtifact(content, options = {}) {
  const existsSync = typeof options.existsSync === 'function' ? options.existsSync : fs.existsSync;
  return extractImagePaths(content).some((candidate) => {
    try {
      return existsSync(path.resolve(candidate));
    } catch (_) {
      return false;
    }
  });
}

function isAdmissionOrConcession(content) {
  const text = asText(content).toLowerCase();
  return /\b(?:you(?:'re| are)? right|james(?:,)? you(?:'re| are)? right|correct|fair)\b/.test(text)
    || /\b(?:not there|not visible|isn't there|is not there|nothing in (?:your|the)|can't see|cannot see|not where james is looking)\b/.test(text)
    || /\b(?:i don't have (?:it|the real thing)|we don't have (?:it|the real thing)|i do not have (?:it|the real thing))\b/.test(text)
    || /\b(?:does not count|doesn't count|won't count|will not count|not proof|blocked|exact blocker)\b/.test(text);
}

function isNegatedClaim(content) {
  const text = asText(content).toLowerCase();
  return /\b(?:not|isn't|is not|doesn't|does not|won't|will not|can't|cannot|no)\s+(?:done|finished|complete|completed|visible|there|proof|count)\b/.test(text)
    || /\b(?:not proof|does not count|doesn't count|won't count|will not count|still (?:blocked|creating|missing|not visible))\b/.test(text)
    || isAdmissionOrConcession(text);
}

function hasSurfaceCompletionClaim(content) {
  const text = asText(content);
  if (!text || isNegatedClaim(text)) return false;
  const lower = text.toLowerCase();
  const startsWithClaim = /(?:^|\n)\s*(?:done|complete|completed|finished|all set|verdict\s*:\s*done)\b/i.test(text);
  const doneTerm = /\b(?:done|finished|complete|completed|all set|ready for james|visible|left open|created|fixed|resolved|works now|verdict\s*:\s*done|this counts|count this)\b/i.test(text);
  const surfaceTerm = /\b(?:james|visible|see|sees|screen|dashboard|window|pane|prompt|invoice|trustquote|telegram|real dashboard|screenshot|surface)\b/i.test(text);
  return (startsWithClaim && !/\b(?:test|unit|jest|suite)\b/i.test(lower)) || (doneTerm && surfaceTerm);
}

function hasSubstituteAsProofInstruction(content) {
  const text = asText(content);
  if (!text) return false;
  if (/\b(?:not proof|does not become proof|doesn't become proof|cannot become proof|can't become proof|does not count|doesn't count|won't count|will not count|substitute won't count|substitute does not count|hold for explicit|requires explicit|not where james sees|not where james is looking)\b/i.test(text)) {
    return false;
  }
  let scanText = text;
  for (const imagePath of extractImagePaths(text)) {
    scanText = scanText.split(imagePath).join(' ');
  }
  const substitute = /\b(?:local|localhost|emulator|mock|sandbox|private browser|private screenshot|demo env|fake environment)\b/i.test(scanText);
  const realSurface = /\b(?:real dashboard|james(?:'s)? dashboard|production|prod|live dashboard|actual dashboard|where james sees|trustquote dashboard|customer dashboard|james-visible)\b/i.test(scanText);
  const proofVerb = /\b(?:proof|prove|counts?|visible|screenshot|show|final|done|finish|create|leave|use)\b/i.test(scanText);
  return substitute && realSurface && proofVerb;
}

function detectSurfaceClaimGuardViolation(input = {}) {
  const content = asText(input.content);
  const targetRole = input.targetRole;
  const targetRaw = input.targetRaw;
  const messageId = input.messageId || null;
  const senderRole = normalizeRole(input.senderRole) || 'cli';
  const sessionId = input.sessionId || null;
  const nowMs = Number(input.nowMs) || Date.now();

  if (hasSubstituteAsProofInstruction(content)) {
    return {
      type: 'surface_claim_guard',
      violation_class: 'substitute_as_surface_proof',
      messageId,
      senderRole,
      targetRole: normalizeRole(targetRole) || normalizeRole(targetRaw) || null,
      targetRaw: targetRaw || null,
      sessionId,
      reason: 'Local/emulator/private/demo surface is being positioned as proof for James-visible or production reality.',
    };
  }

  if (!isUserFacingTarget(targetRole, targetRaw)) return null;

  const recentUserRows = Array.isArray(input.recentUserRows) ? input.recentUserRows : [];
  const repeated = findLatestUserRepeat(recentUserRows, {
    nowMs,
    windowMs: input.repeatWindowMs,
    minOverlap: input.repeatMinOverlap,
  });
  const hasArtifact = hasExistingSurfaceArtifact(content, {
    existsSync: input.existsSync,
  });

  if (repeated && !isAdmissionOrConcession(content) && !hasArtifact) {
    return {
      type: 'surface_claim_guard',
      violation_class: 'james_repeat_requires_surface_concession',
      messageId,
      senderRole,
      targetRole: normalizeRole(targetRole) || normalizeRole(targetRaw) || null,
      targetRaw: targetRaw || null,
      sessionId,
      reason: 'James repeated the same unresolved point; outbound reply must concede/name the unresolved surface or include a real surface artifact.',
      repeat: {
        score: repeated.score,
        latestMessageId: repeated.latestMessageId,
        previousMessageId: repeated.previousMessageId,
        latestAtMs: repeated.latestAtMs,
        previousAtMs: repeated.previousAtMs,
        latestBody: repeated.latestBody,
        previousBody: repeated.previousBody,
      },
    };
  }

  if (hasSurfaceCompletionClaim(content) && !hasArtifact) {
    return {
      type: 'surface_claim_guard',
      violation_class: 'surface_done_claim_without_artifact',
      messageId,
      senderRole,
      targetRole: normalizeRole(targetRole) || normalizeRole(targetRaw) || null,
      targetRaw: targetRaw || null,
      sessionId,
      reason: 'User-facing done/visible claim needs a literal surface artifact in the message.',
    };
  }

  return null;
}

module.exports = {
  detectSurfaceClaimGuardViolation,
  extractImagePaths,
  findLatestUserRepeat,
  hasExistingSurfaceArtifact,
  hasSubstituteAsProofInstruction,
  hasSurfaceCompletionClaim,
  isAdmissionOrConcession,
  normalizeUserPointText,
  tokensForPoint,
  tokenOverlapScore,
};
