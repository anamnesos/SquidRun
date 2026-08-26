#!/usr/bin/env node
/**
 * hm-email: send-safety seam for outbound email.
 *
 * This script does NOT send mail. Nothing in SquidRun can send mail on its own:
 * the Gmail connector exposes create_draft/update_draft but no send verb, so the
 * final Send is always performed by an agent driving a logged-in browser.
 *
 * What this script owns is the part that must not be left to a model's memory:
 *   - a durable fingerprint per outbound message, so the same appeal cannot be
 *     sent twice into a claim file,
 *   - a ledger whose dangerous state is "claimed but unverified", not "claimed",
 *   - proof-of-effect recording that refuses to mark SENT without a real
 *     Gmail message id read back out of SENT.
 *
 * Commands:
 *   stage        copy attachments where a browser file-upload can reach them
 *   encode       base64 a SMALL attachment for MCP-native draft creation
 *   claim        take the send lock for one specific message
 *   record-sent  close a claim with proof (message id from SENT)
 *   abandon      close a claim that provably did not send
 *   status       show ledger state
 *
 * Ledger: .squidrun/runtime/email-send-ledger.jsonl (append-only)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
// Overridable so the lifecycle can be exercised without writing to the real ledger.
const LEDGER_PATH = process.env.SQUIDRUN_EMAIL_LEDGER
  ? path.resolve(process.env.SQUIDRUN_EMAIL_LEDGER)
  : path.join(PROJECT_ROOT, '.squidrun', 'runtime', 'email-send-ledger.jsonl');
const UPLOAD_DIR = path.join(PROJECT_ROOT, '.playwright-mcp', 'upload');

// Gmail allows 25MB of attachments. That ceiling is NOT the one that binds us.
// MCP-native attachments cross as base64 text inside a tool parameter, so the
// file transits the agent's context window: 10.49MB of PDF becomes ~14.7M
// characters, roughly 3.5M tokens against a ~200k window. Measured 2026-07-28.
// Anything above this goes through browser file-upload instead.
const MCP_ATTACH_SAFE_BYTES = 256 * 1024;
const GMAIL_TOTAL_ATTACH_BYTES = 25 * 1024 * 1024;

// A claim older than this with no resolution is not "expired" -- it is a message
// whose outcome we do not know, which is the one state that must never auto-clear.
const CLAIM_STALE_MS = 15 * 60 * 1000;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function sha256Text(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function readLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  return fs
    .readFileSync(LEDGER_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        console.error(`WARN: ledger line ${i + 1} is not valid JSON; ignoring`);
        return null;
      }
    })
    .filter(Boolean);
}

function appendLedger(entry) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Latest entry per claimId, so append-only history still yields current state. */
function currentState() {
  const byClaim = new Map();
  for (const e of readLedger()) {
    if (e.claimId) byClaim.set(e.claimId, e);
  }
  return byClaim;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        // repeatable flags (--file, --attach) collect into arrays
        if (out[key] === undefined) out[key] = next;
        else if (Array.isArray(out[key])) out[key].push(next);
        else out[key] = [out[key], next];
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function asList(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * The fingerprint is what makes a double-send detectable. It deliberately
 * includes attachment content hashes: same recipients + same subject + same body
 * but a corrected attachment is a DIFFERENT message and must be sendable.
 */
function fingerprint({ to, cc, bcc, subject, bodyHash, attachmentHashes }) {
  const canonical = JSON.stringify({
    to: [...to].map((s) => s.trim().toLowerCase()).sort(),
    cc: [...cc].map((s) => s.trim().toLowerCase()).sort(),
    bcc: [...bcc].map((s) => s.trim().toLowerCase()).sort(),
    subject: String(subject).trim().replace(/\s+/g, ' '),
    bodyHash,
    attachments: [...attachmentHashes].sort(),
  });
  return sha256Text(canonical);
}

function cmdStage(args) {
  const files = asList(args.file);
  if (!files.length) fail('stage requires at least one --file <path>');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  let total = 0;
  const staged = [];
  for (const f of files) {
    const src = path.resolve(f);
    if (!fs.existsSync(src)) fail(`attachment not found: ${src}`);
    const st = fs.statSync(src);
    if (!st.isFile()) fail(`not a file: ${src}`);
    if (st.size === 0) fail(`attachment is EMPTY, refusing to stage: ${src}`);

    const dest = path.join(UPLOAD_DIR, path.basename(src));
    fs.copyFileSync(src, dest);

    // Verify the copy landed byte-identical rather than trusting copyFileSync.
    const srcHash = sha256File(src);
    const destHash = sha256File(dest);
    if (srcHash !== destHash) fail(`staged copy differs from source: ${dest}`);

    total += st.size;
    staged.push({ source: src, staged: dest, bytes: st.size, sha256: srcHash });
    console.log(`staged  ${(st.size / 1024 / 1024).toFixed(2)} MB  ${path.basename(src)}`);
    console.log(`        sha256 ${srcHash}`);
    console.log(`        -> ${dest}`);
  }

  console.log(`\ntotal ${(total / 1024 / 1024).toFixed(2)} MB across ${staged.length} file(s)`);
  if (total > GMAIL_TOTAL_ATTACH_BYTES) {
    console.log('REFUSE: exceeds the Gmail 25MB attachment ceiling. Use a Drive link instead.');
    process.exit(2);
  }
  if (total > MCP_ATTACH_SAFE_BYTES) {
    console.log('NOTE: too large for MCP-native attachment (base64 would blow the agent context).');
    console.log('      These must be attached by BROWSER FILE UPLOAD from the staged paths above.');
  }
  console.log(JSON.stringify({ staged }, null, 2));
}

function cmdEncode(args) {
  const f = args.file;
  if (!f || f === true) fail('encode requires --file <path>');
  const src = path.resolve(f);
  if (!fs.existsSync(src)) fail(`file not found: ${src}`);
  const st = fs.statSync(src);

  const limit = args.limit && args.limit !== true ? Number(args.limit) : MCP_ATTACH_SAFE_BYTES;
  if (st.size > limit) {
    console.error(`REFUSE: ${(st.size / 1024 / 1024).toFixed(2)} MB exceeds the safe MCP attachment size of ${(limit / 1024).toFixed(0)} KB.`);
    console.error('Base64 would inflate this by ~4/3 and pass through the agent context window.');
    console.error(`This file would cost roughly ${Math.round((st.size * 4) / 3 / 4 / 1000)}k tokens.`);
    console.error('Use `stage` + browser file upload for this file instead.');
    process.exit(2);
  }

  const b64 = fs.readFileSync(src).toString('base64');
  const out = args.out && args.out !== true ? path.resolve(args.out) : null;
  if (out) {
    fs.writeFileSync(out, b64, 'utf8');
    console.log(JSON.stringify({ file: src, bytes: st.size, base64Chars: b64.length, out }, null, 2));
  } else {
    // Printed only for genuinely small files; caller opted in by staying under the limit.
    console.log(b64);
  }
}

function cmdClaim(args) {
  const to = asList(args.to).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
  const cc = asList(args.cc).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
  const bcc = asList(args.bcc).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
  if (!to.length) fail('claim requires --to <address>');
  const subject = args.subject && args.subject !== true ? String(args.subject) : fail('claim requires --subject');

  let body = '';
  if (args['body-file'] && args['body-file'] !== true) {
    const bp = path.resolve(args['body-file']);
    if (!fs.existsSync(bp)) fail(`body file not found: ${bp}`);
    body = fs.readFileSync(bp, 'utf8');
  } else if (args.body && args.body !== true) {
    body = String(args.body);
  } else {
    fail('claim requires --body-file <path> or --body <text>');
  }
  if (!body.trim()) fail('refusing to claim an empty body');

  const attachments = asList(args.attach).map((f) => {
    const p = path.resolve(f);
    if (!fs.existsSync(p)) fail(`attachment not found: ${p}`);
    return { path: p, sha256: sha256File(p), bytes: fs.statSync(p).size };
  });

  const fp = fingerprint({
    to, cc, bcc, subject,
    bodyHash: sha256Text(body.trim().replace(/\r\n/g, '\n')),
    attachmentHashes: attachments.map((a) => a.sha256),
  });

  const state = currentState();
  for (const e of state.values()) {
    if (e.fingerprint !== fp) continue;
    if (e.state === 'SENT') {
      console.error('REFUSE: this exact message was already sent.');
      console.error(`  claimId    ${e.claimId}`);
      console.error(`  sentAt     ${e.sentAt}`);
      console.error(`  messageId  ${e.proof && e.proof.messageId}`);
      console.error('If you intend to send a genuinely different message, change the body or attachments.');
      process.exit(3);
    }
    if (e.state === 'CLAIMED') {
      const ageMs = Date.now() - new Date(e.claimedAt).getTime();
      console.error('REFUSE: an unresolved claim already exists for this exact message.');
      console.error(`  claimId    ${e.claimId}`);
      console.error(`  claimedAt  ${e.claimedAt} (${Math.round(ageMs / 1000)}s ago)`);
      if (ageMs > CLAIM_STALE_MS) {
        console.error('');
        console.error('This claim is STALE, which does NOT mean it failed. It means THE OUTCOME IS UNKNOWN.');
        console.error('The message may already be in the recipient\'s inbox.');
        console.error('Resolve it by looking at SENT before doing anything else:');
        console.error('  - if it did send:      hm-email.js record-sent --claim <id> --message-id <id> --thread-id <id>');
        console.error('  - if it provably did not: hm-email.js abandon --claim <id> --reason "<what you checked>"');
      }
      process.exit(4);
    }
  }

  const claimId = `em-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const entry = {
    claimId,
    state: 'CLAIMED',
    claimedAt: new Date().toISOString(),
    fingerprint: fp,
    to, cc, bcc, subject,
    bodyBytes: Buffer.byteLength(body, 'utf8'),
    bodyHash: sha256Text(body.trim().replace(/\r\n/g, '\n')),
    attachments,
    claimedBy: process.env.SQUIDRUN_ROLE || 'unknown',
  };
  appendLedger(entry);

  console.log(`CLAIMED ${claimId}`);
  console.log(`  to          ${to.join(', ')}`);
  console.log(`  subject     ${subject}`);
  console.log(`  attachments ${attachments.length}`);
  console.log(`  fingerprint ${fp.slice(0, 16)}...`);
  console.log('');
  console.log('Now perform the send. Afterwards you MUST close this claim:');
  console.log(`  verify in SENT, then: node ui/scripts/hm-email.js record-sent --claim ${claimId} --message-id <id> --thread-id <id>`);
}

function cmdRecordSent(args) {
  const claimId = args.claim && args.claim !== true ? String(args.claim) : fail('record-sent requires --claim <id>');
  const messageId = args['message-id'] && args['message-id'] !== true ? String(args['message-id']) : null;
  if (!messageId) {
    fail('record-sent requires --message-id <id> read back from SENT. A send with no message id is NOT proof of delivery.');
  }
  const state = currentState();
  const e = state.get(claimId);
  if (!e) fail(`unknown claimId: ${claimId}`);
  if (e.state === 'SENT') fail(`claim ${claimId} is already closed as SENT (messageId ${e.proof && e.proof.messageId})`);

  const attachmentsVerified = args['attachments-verified'] && args['attachments-verified'] !== true
    ? Number(args['attachments-verified']) : null;
  const expected = (e.attachments || []).length;
  if (expected > 0 && attachmentsVerified === null) {
    fail(`this message claimed ${expected} attachment(s); pass --attachments-verified <n> read back from the sent message`);
  }
  if (expected > 0 && attachmentsVerified !== expected) {
    fail(`ATTACHMENT MISMATCH: claimed ${expected}, verified ${attachmentsVerified}. Do not close this claim until they agree.`);
  }

  appendLedger({
    ...e,
    state: 'SENT',
    sentAt: new Date().toISOString(),
    proof: {
      messageId,
      threadId: args['thread-id'] && args['thread-id'] !== true ? String(args['thread-id']) : null,
      attachmentsVerified,
      verifiedVia: args.via && args.via !== true ? String(args.via) : 'gmail:search in:sent + get_message',
    },
  });
  console.log(`SENT ${claimId} closed with proof messageId=${messageId}`);
}

function cmdAbandon(args) {
  const claimId = args.claim && args.claim !== true ? String(args.claim) : fail('abandon requires --claim <id>');
  const reason = args.reason && args.reason !== true ? String(args.reason) : null;
  if (!reason) fail('abandon requires --reason describing WHAT YOU CHECKED to conclude it did not send');
  const e = currentState().get(claimId);
  if (!e) fail(`unknown claimId: ${claimId}`);
  if (e.state === 'SENT') fail(`refusing: ${claimId} is closed as SENT and cannot be abandoned`);
  appendLedger({ ...e, state: 'ABANDONED', abandonedAt: new Date().toISOString(), reason });
  console.log(`ABANDONED ${claimId}: ${reason}`);
}

function cmdStatus(args) {
  const state = currentState();
  const rows = [...state.values()].sort((a, b) => String(a.claimedAt).localeCompare(String(b.claimedAt)));
  if (args.claim && args.claim !== true) {
    const e = state.get(String(args.claim));
    if (!e) fail(`unknown claimId: ${args.claim}`);
    console.log(JSON.stringify(e, null, 2));
    return;
  }
  if (!rows.length) {
    console.log('ledger empty (no outbound email has been claimed)');
    return;
  }
  let unresolved = 0;
  for (const e of rows) {
    const mark = e.state === 'SENT' ? 'SENT     ' : e.state === 'ABANDONED' ? 'ABANDONED' : 'CLAIMED  ';
    if (e.state === 'CLAIMED') unresolved += 1;
    console.log(`${mark} ${e.claimId}  ${String(e.subject).slice(0, 52)}  -> ${e.to.join(',')}`);
  }
  if (unresolved) {
    console.log(`\n${unresolved} UNRESOLVED claim(s). Each one is a message of UNKNOWN outcome, not a failed one.`);
    console.log('Resolve every one against SENT before sending anything similar.');
    process.exit(5);
  }
}

function usage() {
  console.log('Usage: node hm-email.js <command> [options]');
  console.log('');
  console.log('  stage       --file <path> [--file <path>...]');
  console.log('  encode      --file <path> [--out <path>] [--limit <bytes>]');
  console.log('  claim       --to <a[,b]> --subject <s> (--body-file <p> | --body <t>) [--attach <p>...] [--cc <a>] [--bcc <a>]');
  console.log('  record-sent --claim <id> --message-id <id> [--thread-id <id>] [--attachments-verified <n>] [--via <s>]');
  console.log('  abandon     --claim <id> --reason <text>');
  console.log('  status      [--claim <id>]');
  console.log('');
  console.log('This script never sends mail. It makes double-sending detectable and');
  console.log('makes "we think it sent" an unrepresentable state.');
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (cmd) {
    case 'stage': return cmdStage(args);
    case 'encode': return cmdEncode(args);
    case 'claim': return cmdClaim(args);
    case 'record-sent': return cmdRecordSent(args);
    case 'abandon': return cmdAbandon(args);
    case 'status': return cmdStatus(args);
    case undefined:
    case '--help':
    case '-h':
    case 'help': return usage();
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

main();
