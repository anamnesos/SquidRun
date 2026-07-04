'use strict';

/**
 * FACE JARGON CORE (S468 weaker-duplicate hunt): the ONE copy of the
 * machine-identifier strip shared by the face pipeline (renderer.js
 * stripSquidRoomFaceJargon) and the speech system's last-line guard
 * (squid-room-speech-system.js sanitizeSpeechText).
 *
 * These two carried hand-maintained twins of this exact logic and drifted
 * three times in one day (S466). Layer-SPECIFIC rules (agent-ref header
 * handling, verb-label preservation) stay in the consumers; everything a
 * machine identifier looks like lives here, once.
 *
 * Strip, never invent: consumers decide what an emptied line means.
 */
const MACHINE_JARGON_MARKER_PATTERNS = Object.freeze([
  /\bkind\s*=/i,
  /\bsubject\s*=/i,
  /\bmaterialized\b/i,
  /\bverdict\s+ledger\b/i,
  /\bhm--(?:[a-z0-9_-]+)?/i,
  /\bv--(?:[a-z0-9_-]+)?/i,
]);

function stripMachineJargon(value) {
  return String(value || '')
    // shell-escape artifact from hm-send payloads: '\'' -> apostrophe
    .replace(/'\\''/g, "'")
    .replace(/\bsha256[:=]?\s*[0-9a-f]{8,64}\b/gi, '')
    // bare commit/artifact hashes: >=7 hex chars WITH a digit AND a hex
    // alpha, so numeric verdict IDs like v-20260704173547-174-oracle survive
    // while e4e03749 dies.
    .replace(/\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]+\b/gi, '')
    // file paths (windows or unix, extension required) + bare filenames
    .replace(/(?:[A-Za-z]:)?(?:[\w.-]+[\\/]){1,}[\w.-]+\.\w{1,6}\b/g, '')
    .replace(/\b[\w.-]+\.(?:png|jpe?g|gif|md|js|ts|tsx|json|css|html|txt|log|pdf|woff2?)\b/gi, '')
    .replace(/\.squidrun\/[\w/.-]+/g, '')
    .replace(/\bwi-[a-z0-9][\w-]{5,}\b/gi, '')
    .replace(/\bhm-\d{10,}-[a-z0-9]+\b/gi, '')
    .replace(/\btrc-[0-9a-f-]{12,}\b/gi, '')
    .replace(/\b(?:rowId|messageId|deliveryId)\s*[:#=]?\s*[A-Za-z0-9._:-]+\b/gi, '')
    // husk removal (drop the CLAUSE, not just the token): slash-number runs
    // from stripped filenames, dangling slashes, letter-less parentheticals
    .replace(/(?:\s*\/\s*\d{4,}\b)+/g, '')
    .replace(/\s*\/\s*(?=[,.;:)\s]|$)/g, '')
    .replace(/\(\s*[\d\s/\\.,:;·–—-]*\s*\)/g, '')
    .replace(/\(\s*[,:;-]*\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function hasMachineJargonMarker(value) {
  const text = String(value || '');
  if (!text) return false;
  return MACHINE_JARGON_MARKER_PATTERNS.some((pattern) => pattern.test(text));
}

function sanitizeHumanFaceText(value) {
  const source = String(value || '');
  if (hasMachineJargonMarker(source)) return '';
  const stripped = stripMachineJargon(source);
  if (hasMachineJargonMarker(stripped)) return '';
  return stripped;
}

module.exports = {
  MACHINE_JARGON_MARKER_PATTERNS,
  hasMachineJargonMarker,
  sanitizeHumanFaceText,
  stripMachineJargon,
};
