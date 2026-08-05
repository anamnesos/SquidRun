/**
 * THE DRAIN'S READ OF THE DURABLE TRANSPORT CLAIM.
 *
 * =====================================================================
 * THE SEAM THE B4 REPAIR OPENED AND DID NOT CLOSE
 * =====================================================================
 * B4b made the DB claim the authoritative attempt latch at the DELIVERY seam.
 * The drain's DECISION layer stayed on `delivery-attempts.jsonl`. Those two can
 * only agree while nothing crashes: the JSONL line was written before
 * `deliver()` and therefore before any claim existed, so a crash between them
 * left one file saying "attempted" and the database saying nothing was ever
 * claimed — an orphan by construction. And once the JSONL write is removed (it
 * must be: two independent latches for one attempt is the same two-writer
 * defect one layer down), a restarted drain that cannot see the claim believes
 * every post-cutover message is untouched. That is not a stale diagnosis, it is
 * a duplicate in front of James.
 *
 * So this module is the counterpart of `telegram-terminal-lookup.js`, and it
 * obeys the same rule: it opens the one store that owns the fact, returns the
 * stored row's own fields, and NEVER supplies a value the record does not
 * already carry. It filters. It does not complete.
 *
 * FAIL CLOSED MEANS THROW. `processRecord` maps a throw to a HOLD and a null to
 * "no claim exists". Those are the honest mappings for "I cannot tell" and
 * "nothing has claimed this": the first must never deliver, the second is the
 * ordinary state of a message that has not been attempted yet.
 */
const fs = require('node:fs');

const { TelegramAdmissionWriter } = require('./telegram-admission-writer');
const {
  readTransportClaim,
  verifyInstalledSchema,
  CLAIM_READ_SCHEMA_OBJECTS,
  TELEGRAM_CUTOVER_ID,
} = require('./telegram-admission-store');

/**
 * @param {object} input
 *   updateId    the durable queue update id
 *   routeKey    the route the drain re-validated against the live route table
 *   cutoverId   defaults to the one cutover constant
 *   dbPath / writerFactory   injection seams; tests point these at a temp ledger
 * @returns {object|null} the stored claim, or null when nothing has claimed it
 * @throws when the claim store exists and cannot be read, or reads ambiguously
 */
function findTransportClaim(input = {}) {
  const updateId = Number(input.updateId);
  const routeKey = String(input.routeKey ?? '').trim();
  const cutoverId = String(input.cutoverId || TELEGRAM_CUTOVER_ID).trim();
  if (!Number.isSafeInteger(updateId) || updateId <= 0 || !routeKey || !cutoverId) {
    // A question this malformed cannot be answered safely either way.
    throw new Error('transport claim lookup requires updateId and routeKey');
  }

  const writer = input.writerFactory
    ? input.writerFactory()
    : new TelegramAdmissionWriter(input.dbPath ? { dbPath: input.dbPath } : {});

  // A LEDGER THAT DOES NOT EXIST HAS NEVER CLAIMED ANYTHING. Same reasoning as
  // the terminal lookup: on a fresh install nothing has written a file yet, and
  // a lookup that threw there would hold the first Telegram message forever.
  if (!writer.dbPath || !fs.existsSync(writer.dbPath)) return null;

  const opened = writer.open();
  if (!opened.ok) {
    throw new Error(`transport claim store unavailable: ${opened.reason || 'unknown'}`);
  }

  try {
    // THE INSTALLED SHAPE, NOT THE EXPECTED ONE (A2b). A ledger carrying an
    // older shape of these tables answers `SELECT` happily and would report
    // "no claim" for a row it simply cannot see.
    //
    // ABSENT AND STALE ARE DIFFERENT ANSWERS, and collapsing them is how a
    // fail-closed read becomes fail-open. EVERY claim object absent means this
    // kernel has never run against this ledger, so no claim can exist and the
    // legacy latch is the whole story. Anything stale — or present-but-partial,
    // which is a build that COULD have claimed — is "I cannot tell", and this
    // path must hold rather than report an empty result.
    const schema = verifyInstalledSchema(writer.db, [...CLAIM_READ_SCHEMA_OBJECTS]);
    if (!schema.ok) {
      if (schema.reason === 'schema_shape_mismatch' && schema.detail?.allAbsent === true) {
        return null;
      }
      throw new Error(`transport claim schema unverified: ${schema.reason}`);
    }

    const read = readTransportClaim(writer.db, { cutoverId, routeKey, updateId });
    if (!read.ok) throw new Error(`transport claim unreadable: ${read.reason}`);
    if (!read.claim) {
      return read.closedClaims.length
        // Closed-unsent slots are not an outstanding attempt, but they are not
        // nothing either, and a caller reporting "never attempted" would be
        // erasing a recorded refusal.
        ? { claim: null, closedClaims: read.closedClaims }
        : null;
    }
    return { claim: read.claim, closedClaims: read.closedClaims };
  } finally {
    writer.close();
  }
}

module.exports = { findTransportClaim };
