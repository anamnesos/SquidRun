/**
 * `telegram_consumed.v1` — the ONE schema that can retire a Telegram inbound
 * record, and the ONE validator that may say so.
 *
 * =====================================================================
 * WHY EVERY EARLIER ATTEMPT FAILED
 * =====================================================================
 * Four times in one day this system reported its own success while the thing
 * that mattered had not happened:
 *
 *   - a shadow-runner status file said running:true while the process was dead;
 *   - startup health scored 100/100 while six of James's messages rotted;
 *   - the drain treated `accepted.daemon_pty_unverified` as meaningful;
 *   - the delivery bus certified 2283 bytes packetized, reassembled, written
 *     and ACKED — while the pane held 125 characters beginning mid-word.
 *
 * That last one is the reason this file exists in its current shape. A proof
 * keyed to the EXISTENCE of a delivery ack proves nothing: a truncated write
 * satisfies it, the record retires, and James loses the tail of his message
 * with every layer reporting success. So proof here is not "an ack happened".
 * Proof is: THE CONSUMER ECHOED BACK A DIGEST OF THE EXACT BYTES IT RECEIVED,
 * AND THEY MATCH WHAT WE SENT.
 *
 * A truncated delivery cannot satisfy that. It hashes differently. That is the
 * whole point, and it is tested.
 *
 * =====================================================================
 * WHAT MAKES THIS RUNTIME-NEUTRAL
 * =====================================================================
 * Not the producer — there is no single component that both sees every pane
 * delivery AND can vouch for what a model actually consumed. The PTY layer
 * sees them all and is precisely what certified 2417 bytes for a 125-char
 * tail; seeing every delivery is not proving any of them.
 *
 * Neutrality lives in the SCHEMA. Each runtime has its own consumer adapter
 * (Claude's UserPromptSubmit hook, Codex's UserPromptSubmit hook) and those
 * adapters may differ internally as much as they like. What they emit is
 * byte-identical in shape, and this validator cannot tell which runtime
 * produced a record except by reading the `runtime` field it carries. A future
 * runtime plugs in by emitting the same schema; nothing here changes.
 *
 * =====================================================================
 * ABSENCE IS NOT A VERDICT
 * =====================================================================
 * The S491 root cause was NOT that Codex is incapable of proving consumption.
 * `.codex/hooks.json` declared the receipt adapter all along; `config.toml`
 * carried no trust row for any project hook, so Codex skipped it silently and
 * wrote nothing. Every layer downstream read that silence as "this runtime
 * cannot prove consumption" and held forever.
 *
 * So a missing producer must never be reported as an incapable runtime. The
 * two are different findings with different fixes, and `PRODUCER_STATES` below
 * keeps them apart by construction.
 */
const crypto = require('node:crypto');

const SCHEMA = 'telegram_consumed.v1';

/**
 * The ONLY positive classes. A record must carry one of these; carrying the
 * right identity fields is not enough.
 *
 * GATE ITEM 2, and it was a real hole in my previous draft: a plain object
 * with the expected ids and timestamps satisfied that validator completely. It
 * asked "do these fields match" and never "is this actually a proof". A
 * fabricated object answers the first question perfectly.
 */
const POSITIVE_PROOF_CLASSES = Object.freeze(new Set(['prompt_consumed']));

/**
 * Why no proof exists yet — kept strictly apart from "cannot exist".
 *
 * `producer_never_fired` is the S491 state: an adapter is declared but
 * untrusted, so it runs zero times and leaves no trace. It reads identically
 * to "unsupported runtime" from the outside, and conflating them is what cost
 * 8.6 hours.
 */
const PRODUCER_STATES = Object.freeze({
  OBSERVED: 'producer_observed',
  NEVER_FIRED: 'producer_never_fired',
  UNSUPPORTED: 'runtime_unsupported',
  UNKNOWN: 'producer_unknown',
});

/** Every field that must be present and correct. No field is optional. */
const REQUIRED_FIELDS = Object.freeze([
  'schema',
  'proofClass',
  'runtime',
  'updateId',
  'messageId',
  'routeKey',
  'windowKey',
  'profile',
  'chatId',
  'appGeneration',
  'consumerSessionId',
  'paneId',
  'queuedPayloadSha256',
  'deliveredPromptSha256',
  'deliveredPromptBytes',
  'consumedAtMs',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

/**
 * The canonical digest of what the QUEUE holds for this update.
 *
 * Deliberately computed from the durable record's own fields rather than from
 * the formatted prompt: the prompt gets a `[Telegram from x]:` prefix, recall
 * context, and possibly a truncation notice, none of which are the message.
 * This digest answers "is this the same MESSAGE", so that the same updateId
 * carrying a different body cannot match (gate item 1).
 */
function canonicalQueuedPayloadDigest(record = {}) {
  const canonical = JSON.stringify({
    updateId: Number(record.updateId),
    text: typeof record.text === 'string' ? record.text : '',
    chatId: record.chatId ?? null,
    from: record.from ?? null,
    messageId: record.messageId ?? null,
  });
  return sha256(canonical);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameScalar(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') return false;
  const left = String(a).trim();
  const right = String(b).trim();
  return Boolean(left) && left === right;
}

/**
 * Build a proof record at a consumer boundary. Shared by EVERY runtime adapter
 * so the shape cannot drift between them.
 *
 * `deliveredPrompt` must be the exact text the consumer received — not what
 * the sender believes it wrote. That distinction is the entire defence against
 * the truncated-but-acked delivery.
 */
function buildConsumedProof(input = {}) {
  const deliveredPrompt = String(input.deliveredPrompt ?? '');
  return {
    schema: SCHEMA,
    proofClass: 'prompt_consumed',
    runtime: isNonEmptyString(input.runtime) ? input.runtime.trim().toLowerCase() : null,
    updateId: Number(input.updateId),
    messageId: input.messageId ?? null,
    routeKey: input.routeKey ?? null,
    windowKey: input.windowKey ?? null,
    profile: input.profile ?? null,
    chatId: input.chatId ?? null,
    appGeneration: input.appGeneration ?? null,
    consumerSessionId: input.consumerSessionId ?? null,
    consumerTurnId: input.consumerTurnId ?? null,
    paneId: input.paneId ?? null,
    queuedPayloadSha256: input.queuedPayloadSha256 ?? null,
    deliveredPromptSha256: sha256(deliveredPrompt),
    deliveredPromptBytes: byteLength(deliveredPrompt),
    consumedAtMs: Number.isFinite(Number(input.consumedAtMs)) ? Number(input.consumedAtMs) : null,
  };
}

/**
 * THE ONE VALIDATOR. Every automatic retirement routes through this.
 *
 * @param {object} input
 *   proof     candidate `telegram_consumed.v1` record
 *   expected  identity + digests the drain recorded when it delivered
 *   attempt   {atMs, generation} from the durable latch, or null
 * @returns {{proven: boolean, reason: string}}
 */
function validateConsumedProof(input = {}) {
  const { proof, expected, attempt } = input;

  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    return { proven: false, reason: 'no_proof' };
  }
  if (!expected || typeof expected !== 'object') {
    return { proven: false, reason: 'no_expected_identity' };
  }

  // POSITIVE CLASS FIRST. Checked before identity so a fabricated object is
  // rejected for what it IS, not for a field it happens to be missing.
  if (proof.schema !== SCHEMA) {
    return { proven: false, reason: `wrong_schema:${proof.schema || 'none'}` };
  }
  if (!isNonEmptyString(proof.proofClass) || !POSITIVE_PROOF_CLASSES.has(proof.proofClass)) {
    return { proven: false, reason: `not_a_positive_proof_class:${proof.proofClass || 'none'}` };
  }

  for (const field of REQUIRED_FIELDS) {
    const value = proof[field];
    if (value === null || value === undefined || String(value).trim() === '') {
      return { proven: false, reason: `proof_field_missing:${field}` };
    }
  }

  // IDENTITY. Every field, from the proof's own body.
  for (const field of ['updateId', 'messageId', 'routeKey', 'windowKey', 'profile', 'chatId']) {
    const want = expected[field];
    if (want === null || want === undefined || String(want).trim() === '') {
      return { proven: false, reason: `expected_identity_missing:${field}` };
    }
    if (!sameScalar(proof[field], want)) {
      return { proven: false, reason: `identity_mismatch:${field}` };
    }
  }

  // GENERATION and CONSUMER SESSION. A receipt echoing a generation from a
  // previous app run is proof of an older delivery of the same id.
  if (!sameScalar(proof.appGeneration, expected.appGeneration)) {
    return { proven: false, reason: 'generation_mismatch' };
  }
  // PANE BINDING. Codex sessions with the same CWD run in panes 1 and 3, so a
  // receipt that cannot name its pane cannot be attributed to this route.
  if (!sameScalar(proof.paneId, expected.paneId)) {
    return { proven: false, reason: 'pane_mismatch' };
  }

  // PAYLOAD IDENTITY. Same id with a changed body must not match.
  if (!SHA256_RE.test(String(proof.queuedPayloadSha256))) {
    return { proven: false, reason: 'queued_digest_malformed' };
  }
  if (!sameScalar(proof.queuedPayloadSha256, expected.queuedPayloadSha256)) {
    return { proven: false, reason: 'queued_payload_digest_mismatch' };
  }

  // PAYLOAD INTEGRITY — the truncated-but-acked defence.
  if (!SHA256_RE.test(String(proof.deliveredPromptSha256))) {
    return { proven: false, reason: 'delivered_digest_malformed' };
  }
  if (!sameScalar(proof.deliveredPromptSha256, expected.deliveredPromptSha256)) {
    // The consumer hashed something other than what we sent. 2283 bytes out,
    // 125 characters in, ack fired anyway — this is where that dies.
    return { proven: false, reason: 'delivered_payload_digest_mismatch' };
  }
  // Byte length is checked TOO, though a digest match implies it. A digest
  // comparison that is ever loosened must not silently take the length with it.
  if (Number(proof.deliveredPromptBytes) !== Number(expected.deliveredPromptBytes)) {
    return { proven: false, reason: 'delivered_payload_length_mismatch' };
  }

  // ORDERING. Proof must postdate the attempt it claims to resolve.
  const consumedAtMs = Number(proof.consumedAtMs);
  if (!Number.isFinite(consumedAtMs) || consumedAtMs <= 0) {
    return { proven: false, reason: 'proof_time_unknown' };
  }
  if (attempt) {
    const attemptedAtMs = Number(attempt.atMs);
    if (!Number.isFinite(attemptedAtMs) || attemptedAtMs <= 0) {
      return { proven: false, reason: 'attempt_time_unknown' };
    }
    if (consumedAtMs < attemptedAtMs) {
      return { proven: false, reason: 'proof_predates_attempt' };
    }
  }

  return { proven: true, reason: 'consumption_proven' };
}

module.exports = {
  SCHEMA,
  POSITIVE_PROOF_CLASSES,
  PRODUCER_STATES,
  REQUIRED_FIELDS,
  sha256,
  byteLength,
  canonicalQueuedPayloadDigest,
  buildConsumedProof,
  validateConsumedProof,
};
