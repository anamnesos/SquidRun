/**
 * WHICH TRANSPORT PROTOCOL DOES THIS QUEUE RECORD BELONG TO?
 *
 * v7 §1. The repair introduces a symmetric `pane|mira` decision protocol, and
 * the single most dangerous thing it could do is apply that protocol to the
 * twelve records already sitting in the live queue. Those were written by a
 * build that knew nothing about decisions; they carry a legacy attempt latch
 * whose semantics the new protocol does not share, and one of them
 * (`808499316`) has already been answered. Sweeping them into the new path is
 * how an answered message gets answered twice.
 *
 * So membership is DECLARED BY THE PRODUCER, IN THE RECORD, and never inferred:
 *
 *   > They are never inferred from time, environment, process start, or lack of
 *   > a legacy latch.  (v7 §1)
 *
 * That sentence is the whole module. Every tempting shortcut — "records after
 * this timestamp are new", "records with no latch are new", "we are running the
 * new build so everything we see is new" — is a rule that reclassifies the live
 * twelve the moment something restarts. A record is post-cutover if and only if
 * it says so, completely and coherently, in its own stored fields.
 *
 * ANYTHING ELSE IS LEGACY, INCLUDING A HALF-STAMPED RECORD. v7 §1 is explicit:
 * "Any record missing/unknown/incoherent in this tuple is legacy." Not HOLD —
 * legacy, which routes it down the repaired pane path that already knows how to
 * be careful. A partially stamped record is indistinguishable from a record
 * written by a build mid-upgrade, and the safe reading of "I cannot tell what
 * protocol this is" is the older, more conservative one.
 */

/** The one protocol value that means post-cutover. Exact match, no variants. */
const TRANSPORT_PROTOCOL_V1 = 'decision_v1';

/**
 * PINNED TO THE RELEASE, deliberately a literal.
 *
 * Same reasoning as `TELEGRAM_CUTOVER_ID` in the admission store: a cutover id
 * derived from the clock, the generation or the schema version changes identity
 * across a restart, and every uniqueness key built on it stops meaning what it
 * meant. This one additionally feeds the stable legacy fence material (v7 §4),
 * where a value that moved between boots would remint a fence that is required
 * to be stable.
 */
const DECISION_CUTOVER_ID = 'tg-decision-cutover-v1';

/** The exact own fields a producer must stamp. All four, or it is legacy. */
const PROTOCOL_FIELDS = Object.freeze([
  'transportProtocol',
  'decisionCutoverId',
  'producerAppGeneration',
  'producerSessionId',
]);

const SOURCE_PROTOCOLS = Object.freeze({ LEGACY: 'legacy', DECISION_V1: TRANSPORT_PROTOCOL_V1 });

function ownString(record, key) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The stamped tuple, or null when this record is legacy.
 *
 * OWN PROPERTIES ONLY. These records are parsed from the spool file, so they
 * are plain objects today — but "today" is exactly the assumption this lane has
 * been burned by, and a classification that can be satisfied through a
 * prototype is a classification that can be borrowed.
 */
function readStampedProtocol(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

  const stamped = {};
  for (const field of PROTOCOL_FIELDS) {
    const value = ownString(record, field);
    // ALL FOUR OR NONE. A record naming a protocol but not the generation that
    // produced it cannot be joined to anything, and the decision/fence tables
    // are built on that join.
    if (value === null) return null;
    stamped[field] = value;
  }

  // UNKNOWN PROTOCOL IS NOT A FUTURE PROTOCOL WE SHOULD GUESS AT. A value this
  // build does not recognise is legacy, which is the conservative path, rather
  // than an unhandled branch further in.
  if (stamped.transportProtocol !== TRANSPORT_PROTOCOL_V1) return null;

  return stamped;
}

/**
 * Classify one queue record. Total, and never throws: an unreadable record is
 * legacy, because the legacy path is the one that already holds rather than
 * delivers when it cannot tell.
 */
function classifySourceRecord(record) {
  const stamped = readStampedProtocol(record);
  if (!stamped) return { protocol: SOURCE_PROTOCOLS.LEGACY, stamped: null };
  return { protocol: SOURCE_PROTOCOLS.DECISION_V1, stamped };
}

/** Is this record eligible for the new symmetric decision protocol at all? */
function isDecisionProtocolSource(record) {
  return readStampedProtocol(record) !== null;
}

/**
 * The fields a NEW record is stamped with at spool time.
 *
 * Returns null unless both identities are real. A producer that cannot name its
 * own generation and session does not get to stamp a record post-cutover; the
 * record is written unstamped and is therefore legacy, which is the honest
 * answer and the safe one.
 */
function buildSourceProtocolStamp(input = {}) {
  const appGeneration = typeof input.appGeneration === 'string' ? input.appGeneration.trim() : '';
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!appGeneration || !sessionId) return null;
  return {
    transportProtocol: TRANSPORT_PROTOCOL_V1,
    // NO CALLER OVERRIDE (Architect #104). The cutover is a property of the
    // RELEASE, and it is baked into the stable legacy fence material in v7 §4.
    // A caller-supplied value would let two producers in one build stamp two
    // different cutovers, which is a fence that cannot be derived and a
    // uniqueness key that means nothing.
    decisionCutoverId: DECISION_CUTOVER_ID,
    producerAppGeneration: appGeneration,
    producerSessionId: sessionId,
  };
}

module.exports = {
  TRANSPORT_PROTOCOL_V1,
  DECISION_CUTOVER_ID,
  PROTOCOL_FIELDS,
  SOURCE_PROTOCOLS,
  readStampedProtocol,
  classifySourceRecord,
  isDecisionProtocolSource,
  buildSourceProtocolStamp,
};
