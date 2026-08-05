/**
 * THE REPOSITORY'S CANONICAL JSON RULE, in one place.
 *
 * =====================================================================
 * WHY THIS IS AN EXTRACTION AND NOT A NEW MODULE
 * =====================================================================
 * This rule already existed, inside `codex-computer-use-proof.js`, where it
 * hashes hook definitions, approval snapshots and generation claims. It is the
 * right rule and that was the wrong home for it: the v7 §4 Telegram legacy
 * cutover fence needs the same canonical encoding to derive an id that must be
 * stable across processes and restarts, and making the fence require 1,772
 * lines of computer-use proof machinery to reach a twelve-line function would
 * couple two lanes that have nothing to do with each other.
 *
 * The alternative — a second implementation next to the fence — is worse and is
 * the failure this lane keeps finding. Two canonical encoders agree until one
 * is edited, and the day they disagree, two subsystems derive two different
 * digests from the same object and each is internally consistent. So there is
 * ONE implementation, here, and `codex-computer-use-proof` consumes it.
 *
 * =====================================================================
 * WHAT "CANONICAL" MEANS HERE, EXACTLY
 * =====================================================================
 * Object keys are sorted at every depth, recursively, and the result is
 * `JSON.stringify`d. That makes the encoding independent of insertion order,
 * which is the property a content-derived id needs: the same material assembled
 * by two different code paths must produce the same bytes.
 *
 * What it deliberately does NOT do is repair its input. Values `JSON.stringify`
 * cannot represent — `undefined`, functions, symbols — are dropped by
 * `stringify` exactly as they always were, and callers that care must refuse
 * those before they get here. A canonicaliser that silently substituted `null`
 * for `undefined` would make "the field was absent" and "the field was
 * explicitly nothing" hash identically, and the fence has an explicit absent
 * sentinel precisely because those are different facts.
 */
const crypto = require('node:crypto');

/** Recursively key-sorted copy. Arrays keep their order; order is their data. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
}

/** The canonical bytes for `value`. */
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** Hex SHA-256 of a string or Buffer. */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Hex SHA-256 of `value`'s canonical bytes. */
function canonicalDigest(value) {
  return sha256(canonicalJson(value));
}

module.exports = Object.freeze({
  canonicalize,
  canonicalJson,
  sha256,
  canonicalDigest,
});
