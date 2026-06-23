'use strict';

// READ-ONLY GUARD (audit finding #4, code-side defense-in-depth).
// The TrustQuote->Tell path reads his LIVE customer Firestore with a FULL admin (read+write) credential.
// Today the feed only reads (.collection/.where/.get). A scoped read-only service account is the real fix,
// but that's a Firebase IAM console op for James. Until then, this guard FAILS the build the moment any
// Firestore WRITE idiom appears in the Tell read path — so an accidental write to his customer data can't
// ship silently. (In-memory Map.set / cache.set are not Firestore writes and are intentionally allowed.)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FEED = path.join(ROOT, 'modules', 'main', 'trustquote-tell-feed.js');
const SHADOW = path.join(ROOT, 'modules', 'main', 'the-tell-shadow-runner.js');

// Unambiguous Firestore WRITE idioms (none of these match an in-memory Map/Set/cache .set()).
const FIRESTORE_WRITE_PATTERNS = [
  { re: /\.doc\([^)]*\)\s*\.\s*(set|update|delete|create)\s*\(/, name: 'doc().set/update/delete/create' },
  { re: /collection\([^)]*\)\s*\.\s*add\s*\(/, name: 'collection().add()' },
  { re: /\bwriteBatch\s*\(/, name: 'writeBatch()' },
  { re: /\.\s*batch\s*\(\s*\)/, name: '.batch()' },
  { re: /\brunTransaction\s*\(/, name: 'runTransaction()' },
  { re: /\bFieldValue\s*\./, name: 'FieldValue.*' },
  { re: /\.set\s*\([^)]*\{\s*merge\s*:/, name: '.set(data, {merge})' },
];

function scan(file) {
  const src = fs.readFileSync(file, 'utf8');
  return FIRESTORE_WRITE_PATTERNS.filter((p) => p.re.test(src)).map((p) => p.name);
}

describe('Tell Firestore path stays READ-ONLY (no writes to his live customer data)', () => {
  test('the TrustQuote->Tell feed contains zero Firestore write idioms', () => {
    const hits = scan(FEED);
    expect(hits).toEqual([]); // if this fails: a write idiom entered the read-only feed — needs explicit review + a scoped credential
  });

  test('the feed genuinely DOES read Firestore (guard is not trivially passing on a refactor)', () => {
    const src = fs.readFileSync(FEED, 'utf8');
    expect(/\.collection\([^)]*\)/.test(src) && /\.get\s*\(/.test(src)).toBe(true);
  });

  test('the shadow runner does NOT touch Firestore directly — access stays confined to the one read-only feed', () => {
    const src = fs.readFileSync(SHADOW, 'utf8');
    expect(/require\(\s*['"]firebase-admin['"]\s*\)/.test(src)).toBe(false);
    expect(/admin\.firestore\s*\(/.test(src)).toBe(false);
    expect(scan(SHADOW)).toEqual([]);
  });
});
