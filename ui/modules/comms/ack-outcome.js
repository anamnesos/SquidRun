'use strict';

/**
 * ACK-VOCABULARY COLLAPSE (nervous-system-v1, ceremony purge SHRINK item).
 *
 * Five ack shapes grew up narrating one question - "did it land?" -
 * (accepted.unverified / materialized.pointer_fallback /
 * accepted.daemon_pty_unverified / prompt_submitted.in_band /
 * delivered.websocket). With v1.2 receipts flowing on every pointer, the
 * question has a measured answer. Three states, receipt-backed:
 *
 *   delivered - proof exists (a prompt-submit receipt, a ledger route row,
 *               or a transport-verified delivery)
 *   pending   - the transport accepted it; no proof YET (the honest middle)
 *   failed    - the transport refused or errored
 *
 * The RAW status always rides along parenthesized - collapse the
 * vocabulary, never destroy the forensics.
 */

const RECEIPT_BACKED_STATUSES = Object.freeze(new Set([
  'prompt_submitted.in_band',
  'prompt_submitted.hook',
]));

const DELIVERED_VERIFIED_STATUSES = Object.freeze(new Set([
  'delivered.websocket',
  'delivered.verified',
]));

const PENDING_STATUSES = Object.freeze(new Set([
  'accepted.unverified',
  'accepted.daemon_pty_unverified',
  'materialized.pointer_fallback',
  'routed',
  'routed_unverified_timeout',
  'accepted',
  'queued',
]));

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * @param {object} sendResult - hm-send's transport result ({ack, delivered,
 *   deliveryProofStatus, ledgerRouteProof, attemptsUsed}).
 * @returns {{state: 'delivered'|'pending'|'failed', proof: string|null,
 *   receiptId: string|null, rawStatus: string, attempt: number|null}}
 */
function classifyAckOutcome(sendResult = {}) {
  const ack = (sendResult && typeof sendResult.ack === 'object' && sendResult.ack) || {};
  const rawStatus = toNonEmptyString(ack.status) || 'unknown';
  const attempt = Number.isFinite(Number(sendResult.attemptsUsed))
    ? Number(sendResult.attemptsUsed)
    : null;

  // Strongest proof first: a recorded prompt-submit receipt.
  const receipt = ack.modelPromptReceipt && typeof ack.modelPromptReceipt === 'object'
    ? ack.modelPromptReceipt
    : null;
  const receiptId = toNonEmptyString(receipt?.deliveryId) || toNonEmptyString(receipt?.messageId);
  if (receiptId || RECEIPT_BACKED_STATUSES.has(rawStatus)) {
    return { state: 'delivered', proof: 'receipt', receiptId: receiptId || null, rawStatus, attempt };
  }

  // Ledger route proof (hm-send's route-proof wait succeeded).
  if (sendResult.ledgerRouteProof?.proofConfirmed === true) {
    return { state: 'delivered', proof: 'ledger', receiptId: null, rawStatus, attempt };
  }

  // Transport-verified delivery statuses.
  if (DELIVERED_VERIFIED_STATUSES.has(rawStatus) || sendResult.delivered === true) {
    return { state: 'delivered', proof: 'transport', receiptId: null, rawStatus, attempt };
  }

  if (sendResult.ok === true && (PENDING_STATUSES.has(rawStatus) || sendResult.delivered === false)) {
    return { state: 'pending', proof: null, receiptId: null, rawStatus, attempt };
  }

  if (sendResult.ok === true) {
    // Accepted with an unrecognized status: honest middle, never inflate.
    return { state: 'pending', proof: null, receiptId: null, rawStatus, attempt };
  }

  return { state: 'failed', proof: null, receiptId: null, rawStatus, attempt };
}

/**
 * One line, three shapes. Raw status parenthesized; preview at the end.
 */
function formatAckLine(target, preview, outcome, extras = {}) {
  const attempt = outcome.attempt ? `, attempt ${outcome.attempt}` : '';
  const raw = outcome.rawStatus && outcome.rawStatus !== 'unknown' ? outcome.rawStatus : 'unknown';
  if (outcome.state === 'delivered') {
    const proofLabel = outcome.proof === 'receipt'
      ? `receipt ${outcome.receiptId || 'recorded'}`
      : (outcome.proof === 'ledger'
        ? `ledger row ${toNonEmptyString(String(extras.ledgerRow ?? '')) || 'proven'}`
        : raw);
    return `delivered to ${target} (${proofLabel}${attempt}): ${preview}`;
  }
  if (outcome.state === 'pending') {
    return `pending at ${target} (${raw}${attempt}; no proof yet - the ledger holds it): ${preview}`;
  }
  return `failed at ${target} (${raw}${attempt}): ${preview}`;
}

module.exports = {
  classifyAckOutcome,
  formatAckLine,
};
