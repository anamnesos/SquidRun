#!/usr/bin/env node
'use strict';

/**
 * Promote reviewed care/taste candidates into TrustQuote ownerContext.
 *
 * Dry-run by default. Applying requires:
 *   --index <n> or --candidate-text <text>
 *   --reason <future behavior change reason>
 *   --apply
 *
 * This keeps promotion consequential: no raw receipt dump, no generic notes.
 */

const path = require('path');
const fs = require('fs');
const { createHash } = require('crypto');
const { resolveCoordPath } = require('../config');

const TRUSTQUOTE_DIR = path.resolve(__dirname, '../../../TrustQuote');
const ENV_PATH = path.join(TRUSTQUOTE_DIR, '.env.local');
const ADMIN_PATH = path.join(TRUSTQUOTE_DIR, 'node_modules', 'firebase-admin');
const DEFAULT_CANDIDATES_PATH = resolveCoordPath('coord/owner-context-promotion-candidates.jsonl');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    filePath: DEFAULT_CANDIDATES_PATH,
    index: null,
    candidateText: '',
    reason: '',
    apply: false,
    ownerEmail: null,
    json: false,
    list: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (token === '--apply') args.apply = true;
    else if (token === '--json') args.json = true;
    else if (token === '--list') args.list = true;
    else if (token === '--path') args.filePath = path.resolve(argv[++index]);
    else if (token === '--index') args.index = Number.parseInt(argv[++index], 10);
    else if (token === '--candidate-text') args.candidateText = String(argv[++index] || '');
    else if (token === '--reason') args.reason = String(argv[++index] || '');
    else if (token === '--owner-email') args.ownerEmail = String(argv[++index] || '');
    else if (token === '-h' || token === '--help') args.help = true;
  }
  return args;
}

function loadEnvLocal(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`TrustQuote .env.local not found at ${envPath}`);
  }
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function loadAdmin(adminPath) {
  if (!fs.existsSync(adminPath)) {
    throw new Error(`firebase-admin not found at ${adminPath} - run npm install in TrustQuote`);
  }
  return require(adminPath);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return { lineNumber: index + 1, ...JSON.parse(line) };
      } catch (error) {
        return {
          lineNumber: index + 1,
          status: 'invalid',
          candidate: `Invalid JSON: ${error?.message || String(error)}`,
        };
      }
    });
}

function writeJsonl(filePath, records) {
  const lines = records.map((record) => {
    const { lineNumber, ...payload } = record;
    return JSON.stringify(payload);
  });
  fs.writeFileSync(filePath, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8');
}

function normalizeTags(tags) {
  return Array.isArray(tags)
    ? tags.map((tag) => String(tag || '').trim().toLowerCase()).filter(Boolean)
    : [];
}

function inferScope(candidate) {
  const tags = normalizeTags(candidate.tags);
  const text = String(candidate.candidate || '');
  if (tags.includes('lynette') || /lynette butsuda/i.test(text)) {
    return {
      scopeType: 'customer',
      customerName: 'Lynette Butsuda',
    };
  }
  if (tags.includes('james') || tags.includes('communication')) {
    return {
      scopeType: 'owner',
    };
  }
  return {
    scopeType: 'business',
  };
}

function promotionKeyFor(candidate) {
  const source = [
    candidate.sourceReceipt || '',
    candidate.lineNumber || '',
    candidate.candidate || '',
  ].join('|');
  return `promotion_${createHash('sha256').update(source).digest('hex').slice(0, 24)}`;
}

function validateCandidateForApply(candidate) {
  const missing = [];
  if (!String(candidate.sourceReceipt || '').trim()) missing.push('sourceReceipt');
  if (!String(candidate.promotionReason || '').trim()) missing.push('promotionReason');
  if (!String(candidate.expectedBehaviorChange || '').trim()) missing.push('expectedBehaviorChange');
  if (missing.length > 0) {
    throw new Error(`Apply requires candidate provenance: missing ${missing.join(', ')}`);
  }
  if (String(candidate.status || '').toLowerCase() !== 'candidate') {
    throw new Error(`Candidate status is ${candidate.status || 'unknown'}; only status=candidate can be promoted`);
  }
}

function buildOwnerContextRecord({ businessId, candidate, reason }) {
  const tags = normalizeTags(candidate.tags);
  const scope = inferScope(candidate);
  const now = new Date();
  const promotionKey = promotionKeyFor(candidate);
  const text = [
    String(candidate.candidate || '').trim(),
    String(candidate.expectedBehaviorChange || '').trim()
      ? `Future behavior: ${String(candidate.expectedBehaviorChange).trim()}`
      : '',
  ].filter(Boolean).join('\n');

  if (!text) {
    throw new Error('candidate text is required');
  }
  if (!String(reason || '').trim()) {
    throw new Error('--reason is required to promote ownerContext');
  }

  return {
    businessId,
    text,
    source: 'system',
    scopeType: scope.scopeType,
    customerId: null,
    customerName: scope.customerName || null,
    jobId: null,
    invoiceNumber: null,
    eventId: null,
    providerCallId: null,
    importance: 'high',
    tags: Array.from(new Set(['promoted', ...tags])).slice(0, 12),
    followUpAt: null,
    createdBy: 'hm-owner-context-promote',
    createdByChatId: null,
    metadata: {
      sourceReceipt: candidate.sourceReceipt || null,
      promotionReason: candidate.promotionReason || '',
      appliedReason: String(reason || '').trim(),
      expectedBehaviorChange: candidate.expectedBehaviorChange || '',
      candidateTs: candidate.ts || null,
      candidateLineNumber: candidate.lineNumber,
      promotionKey,
    },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function selectCandidate(candidates, args) {
  const active = candidates.filter((candidate) => String(candidate.status || '').toLowerCase() === 'candidate');
  if (Number.isInteger(args.index)) {
    const selected = active[args.index - 1];
    if (!selected) throw new Error(`No candidate at active index ${args.index}`);
    return selected;
  }
  if (args.candidateText) {
    const needle = args.candidateText.toLowerCase();
    const selected = active.find((candidate) => String(candidate.candidate || '').toLowerCase().includes(needle));
    if (!selected) throw new Error(`No active candidate matching "${args.candidateText}"`);
    return selected;
  }
  return null;
}

function markCandidatePromoted(filePath, candidates, selected, ownerContextId, appliedReason) {
  const updated = candidates.map((candidate) => {
    if (candidate.lineNumber !== selected.lineNumber) return candidate;
    return {
      ...candidate,
      status: 'promoted',
      promotedAt: new Date().toISOString(),
      ownerContextId,
      appliedReason,
    };
  });
  writeJsonl(filePath, updated);
}

async function resolveBusinessId(admin, db, ownerEmail) {
  if (process.env.TQ_BUSINESS_ID) return process.env.TQ_BUSINESS_ID;
  const email = ownerEmail || 'jaymz6435@gmail.com';

  let snap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!snap.empty && snap.docs[0].data().businessId) return snap.docs[0].data().businessId;

  try {
    const authUser = await admin.auth().getUserByEmail(email);
    const userDoc = await db.collection('users').doc(authUser.uid).get();
    if (userDoc.exists && userDoc.data().businessId) return userDoc.data().businessId;
  } catch {
    // fall through
  }

  snap = await db.collection('users').where('role', '==', 'owner').limit(2).get();
  if (snap.size === 1 && snap.docs[0].data().businessId) return snap.docs[0].data().businessId;
  throw new Error(`Could not resolve businessId for ${email}. Set TQ_BUSINESS_ID env to override.`);
}

function renderList(candidates) {
  const active = candidates.filter((candidate) => String(candidate.status || '').toLowerCase() === 'candidate');
  if (active.length === 0) return 'No active promotion candidates.';
  return active.map((candidate, index) => {
    const tags = normalizeTags(candidate.tags).join(', ');
    return [
      `${index + 1}. ${candidate.candidate}`,
      `   reason: ${candidate.promotionReason || ''}`,
      `   future: ${candidate.expectedBehaviorChange || ''}`,
      `   source: ${candidate.sourceReceipt || ''}${tags ? ` [${tags}]` : ''}`,
    ].join('\n');
  }).join('\n\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`hm-owner-context-promote - dry-run-first ownerContext promotion

Options:
  --list                         List active candidates
  --index <n>                    Select active candidate by 1-based index
  --candidate-text <text>        Select active candidate by substring
  --reason <text>                Required behavior-change reason for promotion
  --apply                        Write to TrustQuote ownerContext
  --json                         Emit JSON
  --owner-email <email>          Override owner lookup`);
    return { ok: true };
  }

  const candidates = readJsonl(args.filePath);
  if (args.list || (!args.index && !args.candidateText)) {
    const result = { ok: true, path: args.filePath, candidates };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(renderList(candidates));
    return result;
  }

  const candidate = selectCandidate(candidates, args);
  if (!candidate) throw new Error('No candidate selected. Use --index or --candidate-text.');

  if (args.apply) {
    validateCandidateForApply(candidate);
  }

  let admin = null;
  let db = null;
  let businessId = process.env.TQ_BUSINESS_ID || '<resolved-on-apply>';
  if (args.apply) {
    loadEnvLocal(ENV_PATH);
    admin = loadAdmin(ADMIN_PATH);
    if (!admin.apps.length) {
      if (!process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
        throw new Error('FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY missing from TrustQuote .env.local');
      }
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
      });
    }
    db = admin.firestore();
    businessId = await resolveBusinessId(admin, db, args.ownerEmail);
  }
  const record = buildOwnerContextRecord({ businessId, candidate, reason: args.reason });

  const result = {
    ok: true,
    dryRun: !args.apply,
    businessId,
    candidate,
    ownerContext: record,
    id: null,
  };

  if (args.apply) {
    const ref = db.collection('ownerContext').doc(record.metadata.promotionKey);
    const existing = await ref.get();
    if (existing.exists) {
      throw new Error(`Candidate already promoted as ownerContext ${ref.id}`);
    }
    await ref.create(record);
    result.id = ref.id;
    markCandidatePromoted(args.filePath, candidates, candidate, ref.id, args.reason);
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(args.apply ? `Promoted ownerContext ${result.id}` : 'Dry run only. Add --apply to promote.');
    console.log(`${record.scopeType}: ${record.text}`);
  }
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`hm-owner-context-promote error: ${error.message}`);
    if (process.env.HM_TQ_DEBUG) console.error(error.stack);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  readJsonl,
  writeJsonl,
  inferScope,
  promotionKeyFor,
  validateCandidateForApply,
  buildOwnerContextRecord,
  selectCandidate,
  markCandidatePromoted,
  main,
};
