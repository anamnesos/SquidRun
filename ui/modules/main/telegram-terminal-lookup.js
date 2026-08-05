/**
 * THE DRAIN'S READ OF TERMINAL CONSUMPTION PROOF.
 *
 * =====================================================================
 * WHAT THIS REPLACES, AND WHY THE REPLACEMENT IS THE REPAIR
 * =====================================================================
 * `findTelegramDeliveryReceipt` used to answer this question from the generic
 * model-prompt receipt store. That store records `prompt_submit` for EVERY
 * prompt in every pane; it knows nothing about Telegram, about which update it
 * belongs to, about which chat it came from, or about which process generation
 * delivered it. So the old lookup did two things it should never have done:
 *
 *   1. it treated `prompt_submitted.in_band` as `delivered.verified` — a
 *      submission to a model endpoint reported as consumption by a pane; and
 *   2. it attached the route, window and profile IT HAD BEEN ASKED ABOUT onto
 *      the object it returned, so the drain's identity comparison was reading
 *      values the lookup had just written for it.
 *
 * The second one is why the wedge survived every restart. The returned object
 * carried messageId/routeKey/windowKey/profile and nothing else, while
 * `evaluateConsumptionProof` requires `chatId`, `generation` and a real
 * `provedAtMs` as well. There was no input to that path — none — that could
 * produce `proven:true` in production. The queue was not waiting for a slow
 * receipt. It was waiting for a receipt whose shape could not exist.
 *
 * This module reads the ONE store whose rows are written at a consumer
 * boundary that saw the bytes, and it returns those rows' own fields. It
 * filters, it parses, it validates shape. It does not complete, decorate, or
 * infer. If the record does not already own a field, this lookup cannot supply
 * it, and that is the entire design.
 *
 * FAIL CLOSED MEANS THROW HERE. `processRecord` turns a throwing lookup into a
 * HOLD and a returned null into "not yet". Those are the correct mappings for
 * "I cannot tell" and "there is no proof": the first must never re-deliver, and
 * the second is the ordinary state of a message still being worked on.
 */
const fs = require('node:fs');

const { TelegramAdmissionWriter } = require('./telegram-admission-writer');
const { findConsumedReceipt } = require('./telegram-launch-registry');
const { validateConsumedRecordShape } = require('./telegram-consumed-proof');

/**
 * Reasons that mean "no proof exists yet", as opposed to "proof cannot be
 * read". Only these may become a null; everything else is an unknown, and an
 * unknown must hold.
 */
const ABSENT_REASONS = new Set(['consumed_receipt_absent']);

/**
 * @param {object} input
 *   messageId   the durable `telegram-in-<updateId>` id
 *   routeKey    the route the drain re-validated against the live route table
 *   dbPath      optional override; tests point this at a temp ledger
 *   writerFactory optional injection seam for the same purpose
 * @returns {object|null} evidence built ONLY from the stored record
 * @throws when proof cannot be read or is ambiguous
 */
function findTerminalConsumptionEvidence(input = {}) {
  const messageId = String(input.messageId ?? '').trim();
  const routeKey = String(input.routeKey ?? '').trim();
  if (!messageId || !routeKey) return null;

  const writer = input.writerFactory
    ? input.writerFactory()
    : new TelegramAdmissionWriter(input.dbPath ? { dbPath: input.dbPath } : {});

  // A LEDGER THAT DOES NOT EXIST HAS NEVER PROVEN ANYTHING.
  //
  // This is the same distinction the store makes for a missing table, and it
  // is load-bearing for exactly the same reason: on a fresh install there is no
  // ledger file until something writes one, and a lookup that threw there would
  // hold the first Telegram message forever. Duplicate protection does not come
  // from this store — it comes from the durable attempt latch — so absence may
  // safely read as "no proof yet", while a ledger that EXISTS and cannot be
  // read must still hold.
  if (!writer.dbPath || !fs.existsSync(writer.dbPath)) return null;

  const opened = writer.open();
  if (!opened.ok) {
    // The file is there and we cannot open it. That is "I cannot tell", never
    // "nothing was delivered".
    throw new Error(`terminal consumption store unavailable: ${opened.reason || 'unknown'}`);
  }

  let found;
  try {
    found = findConsumedReceipt(writer.db, { messageId, routeKey });
  } finally {
    writer.close();
  }

  if (!found.ok) {
    if (ABSENT_REASONS.has(found.reason)) return null;
    // AMBIGUOUS OR CORRUPT. Two turns claiming one message, or bytes that do
    // not parse, is exactly the state where guessing puts a duplicate in front
    // of James or retires something he never saw.
    throw new Error(`terminal consumption proof unreadable: ${found.reason}`);
  }

  const shape = validateConsumedRecordShape(found.record);
  if (!shape.ok) {
    // A stored row that is not a well-formed terminal record is a defect in
    // whatever wrote it. Holding is the only safe reading.
    throw new Error(`terminal consumption record malformed: ${shape.reason}`);
  }

  const record = found.record;
  return {
    // The status the drain's own class check allowlists, and `verified` so the
    // fresh-delivery correlation path recognises it too.
    status: 'delivered.verified',
    verified: true,
    proofSource: 'telegram_consumed_receipt',
    // ===================================================================
    // EVERY FIELD BELOW COMES FROM THE STORED RECORD. Not one of them is read
    // from the query, and that is checkable by reading this object literal:
    // `messageId` and `routeKey` are re-read from `record`, not carried over
    // from the arguments that found it.
    // ===================================================================
    messageId: record.messageId,
    routeKey: record.routeKey,
    windowKey: record.windowKey,
    profile: record.profile,
    chatId: record.chatId,
    generation: record.appGeneration,
    provedAtMs: record.terminalAtMs,
    updateId: record.updateId,
    admissionId: record.admissionId,
    terminalEvent: record.terminalEvent,
    consumerSessionId: record.consumerSessionId,
    paneId: record.paneId,
    claimId: record.claimId,
    attemptNonce: record.attemptNonce,
    runtime: record.runtime,
    deliveredPromptSha256: record.deliveredPromptSha256,
  };
}

module.exports = { findTerminalConsumptionEvidence, ABSENT_REASONS };
