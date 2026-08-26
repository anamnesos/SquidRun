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
/**
 * ANCHORED TO A WHOLE LINE. An unanchored search was a real vulnerability:
 * the marker describes a message whose BODY IS WRITTEN BY WHOEVER SENT THE
 * TELEGRAM. A first-match scan let that body carry its own `[SQUIDRUN_TG_CONSUME
 * ...]` line and be parsed as the authoritative one, and a `contains-prefix`
 * early return in the appender let the same body SUPPRESS the real marker
 * entirely. Either way the thing being proven got to write, or delete, the
 * proof about itself — and it failed silently.
 */
const MARKER_LINE_RE = /^\[SQUIDRUN_TG_CONSUME\s+([^\]\r\n]+)\]$/;

const FIELD_KEYS = Object.freeze({
  u: 'updateId',
  m: 'messageId',
  r: 'routeKey',
  w: 'windowKey',
  p: 'profile',
  c: 'chatId',
  g: 'appGeneration',
  q: 'queuedPayloadSha256',
  // THE EXACT ATTEMPT. Without these the consumer can only say "a delivery of
  // this message reached me"; the producer then attached its receipt to
  // whichever claim happened to be newest, so after a retry the receipt bound
  // to the wrong attempt and still looked valid. An attempt that cannot be
  // named cannot be the one being proven.
  k: 'claimId',
  a: 'attemptNonce',
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

/**
 * Defang any marker-lookalike inside attacker-controlled text.
 *
 * Turning the opening `[` into `(` cannot itself produce a new occurrence of
 * the prefix, so a single pass is total and there is no escaping-the-escape
 * game to lose. The substitution is deliberately VISIBLE in the pane: a
 * message that tried to forge delivery evidence should look odd to a human,
 * not be silently rewritten into something innocuous.
 */
function neutralizeMarkerLookalikes(text) {
  return String(text ?? '').split(MARKER_PREFIX).join(`(${MARKER_PREFIX.slice(1)}`);
}

/**
 * ALWAYS appends, and always as the FINAL line.
 *
 * The old early return on "text already contains the prefix" handed a sender
 * the power to suppress their own proof. Now the body is defanged first and
 * the authoritative marker always goes last, so exactly one real marker exists
 * and its position is not negotiable.
 */
function appendConsumeMarker(promptText, input = {}) {
  const marker = buildConsumeMarker(input);
  if (!marker) return typeof promptText === 'string' ? promptText : String(promptText ?? '');
  return `${neutralizeMarkerLookalikes(promptText)}\n${marker}`;
}

/**
 * @returns {object|null} parsed fields, or null when the marker is absent or
 * incomplete. Absence is normal — most prompts are not Telegram deliveries.
 */
function parseConsumeMarker(promptText) {
  const text = typeof promptText === 'string' ? promptText : String(promptText ?? '');

  // EXACTLY ONE occurrence in the entire prompt. Two means somebody else wrote
  // one, and there is no safe rule for picking a winner — neither first nor
  // last, because the attacker chooses their position. Ambiguity is refusal.
  const occurrences = text.split(MARKER_PREFIX).length - 1;
  if (occurrences !== 1) return null;

  // It must be the LAST non-empty line, matched as a WHOLE line. A marker
  // embedded mid-line, or with anything appended after it, is not ours.
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return null;
  const match = lines[lines.length - 1].match(MARKER_LINE_RE);
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
  neutralizeMarkerLookalikes,
};
