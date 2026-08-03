/**
 * The marker the consumer echoes back.
 *
 * GATE ITEM 4. A consumer cannot echo a generation it was never given, and it
 * cannot vouch for a canonical payload digest it never saw. Both therefore
 * travel INSIDE the delivered prompt, where the runtime's own
 * UserPromptSubmit-equivalent hook receives them as part of the exact bytes.
 *
 * This is deliberately NOT the existing `[SQUIDRUN_RECEIPT ...]` marker. That
 * one carries delivery ids for the pane-submit verifier and is stamped on every
 * message; this one carries the queue's canonical identity and only appears on
 * Telegram ingress deliveries. Overloading the old marker would have made every
 * agent-to-agent send look like a Telegram consumption claim.
 *
 * Format is one line, parseable without JSON, because it must survive being
 * pasted into a terminal composer:
 *
 *   [SQUIDRUN_TG_CONSUME v=1 u=<updateId> m=<messageId> r=<route> w=<window>
 *    p=<profile> c=<chatId> g=<generation> q=<queuedPayloadSha256>]
 */

const MARKER_PREFIX = '[SQUIDRUN_TG_CONSUME';
const MARKER_RE = /\[SQUIDRUN_TG_CONSUME\s+([^\]]+)\]/;

const FIELD_KEYS = Object.freeze({
  u: 'updateId',
  m: 'messageId',
  r: 'routeKey',
  w: 'windowKey',
  p: 'profile',
  c: 'chatId',
  g: 'appGeneration',
  q: 'queuedPayloadSha256',
});

function isSafeValue(value) {
  // No spaces or brackets: those would make the single-line marker unparseable
  // and are never legitimate in any field it carries.
  return typeof value === 'string' && value.length > 0 && !/[\s\[\]]/.test(value);
}

/**
 * @returns {string|null} the marker, or null if any field is unusable — a
 * partial marker would be worse than none, because a consumer would echo an
 * incomplete identity that then fails validation for the wrong reason.
 */
function buildConsumeMarker(input = {}) {
  const parts = [];
  for (const [key, field] of Object.entries(FIELD_KEYS)) {
    const raw = input[field];
    if (raw === null || raw === undefined) return null;
    const value = String(raw).trim();
    if (!isSafeValue(value)) return null;
    parts.push(`${key}=${value}`);
  }
  return `${MARKER_PREFIX} v=1 ${parts.join(' ')}]`;
}

function appendConsumeMarker(promptText, input = {}) {
  const text = typeof promptText === 'string' ? promptText : String(promptText ?? '');
  if (text.includes(MARKER_PREFIX)) return text;
  const marker = buildConsumeMarker(input);
  if (!marker) return text;
  return `${text}\n${marker}`;
}

/**
 * @returns {object|null} parsed fields, or null when the marker is absent or
 * incomplete. Absence is normal — most prompts are not Telegram deliveries.
 */
function parseConsumeMarker(promptText) {
  const text = typeof promptText === 'string' ? promptText : String(promptText ?? '');
  const match = text.match(MARKER_RE);
  if (!match) return null;

  const parsed = {};
  for (const token of match[1].trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === 'v') {
      parsed.version = value;
      continue;
    }
    const field = FIELD_KEYS[key];
    if (field) parsed[field] = value;
  }

  if (parsed.version !== '1') return null;
  // EVERY field or nothing. A half-parsed marker is not a weaker identity, it
  // is a different message as far as the validator is concerned.
  for (const field of Object.values(FIELD_KEYS)) {
    if (!parsed[field]) return null;
  }
  return parsed;
}

module.exports = {
  MARKER_PREFIX,
  FIELD_KEYS,
  buildConsumeMarker,
  appendConsumeMarker,
  parseConsumeMarker,
};
