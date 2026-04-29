#!/usr/bin/env node
'use strict';

/**
 * hm-tq-status — TrustQuote operator status snapshot.
 *
 * Mirrors the role hm-defi-status.js plays for trading: gives any agent that's
 * about to answer a Telegram message about James's plumbing schedule a fresh
 * read of today's calendar, in-flight jobs, and unpaid invoices — without
 * depending on the TrustQuote MCP being loaded in the current Claude session.
 *
 * Reads Firestore via TrustQuote's own firebase-admin install + .env.local, so
 * it works on any machine where TrustQuote is checked out next to squidrun.
 *
 * Usage:
 *   node ui/scripts/hm-tq-status.js
 *   node ui/scripts/hm-tq-status.js --owner-email jaymz6435@gmail.com
 *   node ui/scripts/hm-tq-status.js --json
 *   node ui/scripts/hm-tq-status.js --window-hours 24
 */

const path = require('path');
const fs = require('fs');

const TRUSTQUOTE_DIR = path.resolve(__dirname, '../../../TrustQuote');
const ENV_PATH = path.join(TRUSTQUOTE_DIR, '.env.local');
const ADMIN_PATH = path.join(TRUSTQUOTE_DIR, 'node_modules', 'firebase-admin');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { json: false, ownerEmail: null, windowHours: 24, unpaidHours: 48, listUsers: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--json') opts.json = true;
    else if (t === '--owner-email') opts.ownerEmail = argv[++i];
    else if (t === '--window-hours') opts.windowHours = Number(argv[++i]);
    else if (t === '--unpaid-hours') opts.unpaidHours = Number(argv[++i]);
    else if (t === '--list-users') opts.listUsers = true;
    else if (t === '--debug-events') opts.debugEvents = true;
    else if (t === '-h' || t === '--help') opts.help = true;
  }
  return opts;
}

function loadEnvLocal(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`TrustQuote .env.local not found at ${envPath}`);
  }
  const txt = fs.readFileSync(envPath, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

function loadAdmin(adminPath) {
  if (!fs.existsSync(adminPath)) {
    throw new Error(`firebase-admin not found at ${adminPath} — run npm install in TrustQuote`);
  }
  return require(adminPath);
}

function fmtWhen(d, timeWindow) {
  // Use timeWindow string for time-of-day if available (it's the authoritative
  // field in TrustQuote); fall back to the Timestamp's time only if not.
  const day = d.toLocaleString('en-US', { weekday: 'short' });
  if (timeWindow && timeWindow.trim()) return `${day} ${timeWindow.trim()}`;
  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtDateShort(d) {
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtAge(hours) {
  if (hours == null) return '?';
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function tsToDate(t) {
  if (!t) return null;
  if (t.toDate) return t.toDate();
  if (typeof t === 'object' && typeof t._seconds === 'number') return new Date(t._seconds * 1000);
  if (typeof t === 'string' || typeof t === 'number') return new Date(t);
  return null;
}

async function resolveBusinessId(admin, db, ownerEmail) {
  if (process.env.TQ_BUSINESS_ID) return process.env.TQ_BUSINESS_ID;

  const email = ownerEmail || 'jaymz6435@gmail.com';

  // 1) Try email field on Firestore users collection.
  let snap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!snap.empty) {
    const data = snap.docs[0].data();
    if (data.businessId) return data.businessId;
  }

  // 2) Fall back to Firebase Auth → UID → users/{uid}.
  try {
    const authUser = await admin.auth().getUserByEmail(email);
    const userDoc = await db.collection('users').doc(authUser.uid).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      if (data.businessId) return data.businessId;
    }
  } catch {
    // fall through
  }

  // 3) Last resort: a single owner user in the collection.
  snap = await db.collection('users').where('role', '==', 'owner').limit(2).get();
  if (snap.size === 1) {
    const data = snap.docs[0].data();
    if (data.businessId) return data.businessId;
  }

  throw new Error(`Could not resolve businessId for ${email}. Set TQ_BUSINESS_ID env to override.`);
}

async function fetchTodayEvents(db, businessId, windowHours) {
  // Window is "now → now+windowHours" (not start-of-today) so an evening run
  // still surfaces tomorrow morning's first job.
  const start = new Date();
  const end = new Date(start.getTime() + windowHours * 60 * 60 * 1000);

  const snap = await db
    .collection('calendar-events')
    .where('businessId', '==', businessId)
    .where('start', '>=', start)
    .where('start', '<', end)
    .orderBy('start', 'asc')
    .get();

  return snap.docs.map((d) => {
    const v = d.data();
    const ci = v.clientInfo || {};
    const ciName = [ci.firstName, ci.lastName].filter(Boolean).join(' ').trim();
    return {
      id: d.id,
      title: v.title || v.eventTitle || '(untitled)',
      start: tsToDate(v.start),
      end: tsToDate(v.end),
      // timeWindow ("11:00 AM") is the authoritative time-of-day in TrustQuote;
      // the `start` Timestamp can drift to midnight via certain create paths
      // (quicksearch + manual edit). Trust timeWindow when present.
      timeWindow: v.timeWindow || '',
      clientName: ciName || v.clientName || v.clientFirstName || '',
      clientPhone: ci.phone || v.clientPhone || '',
      clientAddress: ci.address || v.clientAddress || '',
      type: v.type || v.eventType || '',
      amount: v.amount || v.eventAmount || null,
    };
  });
}

async function fetchUnpaidInvoices(db, businessId, hours) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const snap = await db
    .collection('jobs')
    .where('businessId', '==', businessId)
    .where('paymentStatus', 'in', ['unpaid', 'partial'])
    .get();

  const items = snap.docs.map((d) => {
    const v = d.data();
    const created = tsToDate(v.createdAt) || tsToDate(v.updatedAt) || null;
    const ci = v.clientInfo || {};
    const ciName = [ci.firstName, ci.lastName].filter(Boolean).join(' ').trim();
    return {
      id: d.id,
      number: v.invoiceNumber || v.number || d.id,
      clientName: ciName || v.clientName || v.customerName || '',
      total: typeof v.total === 'number' ? v.total : null,
      paymentStatus: v.paymentStatus,
      createdAt: created,
      ageHours: created ? Math.floor((Date.now() - created.getTime()) / 36e5) : null,
    };
  });
  return items
    .filter((i) => i.createdAt && i.createdAt < cutoff)
    .sort((a, b) => (a.createdAt - b.createdAt));
}

function renderText({ events, unpaid, windowHours, unpaidHours }) {
  const lines = [];
  const now = new Date();
  lines.push(`TrustQuote operator status — ${fmtDateShort(now)}`);
  lines.push('');

  lines.push(`Schedule (next ${windowHours}h, ${events.length} ${events.length === 1 ? 'event' : 'events'}):`);
  if (events.length === 0) {
    lines.push('  (nothing scheduled)');
  } else {
    for (const e of events) {
      const when = e.start ? fmtWhen(e.start, e.timeWindow) : 'TBD';
      const who = e.clientName || '(no client)';
      const where = e.clientAddress || '';
      const phone = e.clientPhone ? ` ☎ ${e.clientPhone}` : '';
      const title = e.title && e.title !== '(untitled)' ? ` — ${e.title}` : '';
      lines.push(`  ${when}  ${who}${title}${where ? ` @ ${where}` : ''}${phone}`);
    }
  }
  lines.push('');

  lines.push(`Unpaid > ${unpaidHours}h (${unpaid.length}):`);
  if (unpaid.length === 0) {
    lines.push('  (none)');
  } else {
    for (const u of unpaid) {
      const total = u.total != null ? `$${u.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$?';
      lines.push(`  #${u.number}  ${u.clientName || '(no client)'}  ${total}  [${u.paymentStatus}, ${fmtAge(u.ageHours)} old]`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs();
  if (opts.help) {
    console.log(`hm-tq-status — TrustQuote operator status snapshot

Options:
  --owner-email <email>   Override owner lookup (default jaymz6435@gmail.com)
  --window-hours <n>      Calendar window forward from start of today (default 24)
  --unpaid-hours <n>      Threshold for "old unpaid" (default 48)
  --json                  Emit JSON instead of human-readable text
  -h, --help              This text

Env override:
  TQ_BUSINESS_ID          Skip the users-collection lookup, use this id directly`);
    return;
  }

  loadEnvLocal(ENV_PATH);
  const admin = loadAdmin(ADMIN_PATH);

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

  const db = admin.firestore();

  if (opts.listUsers) {
    const snap = await db.collection('users').limit(50).get();
    console.log(`users (${snap.size}):`);
    snap.docs.forEach((d) => {
      const v = d.data();
      console.log(`  ${d.id}  email=${v.email || '?'}  businessId=${v.businessId || '-'}  role=${v.role || '-'}`);
    });
    return;
  }

  const businessId = await resolveBusinessId(admin, db, opts.ownerEmail);

  if (opts.debugEvents) {
    const start = new Date();
    const end = new Date(start.getTime() + opts.windowHours * 60 * 60 * 1000);
    const snap = await db
      .collection('calendar-events')
      .where('businessId', '==', businessId)
      .where('start', '>=', start)
      .where('start', '<', end)
      .orderBy('start', 'asc')
      .get();
    snap.docs.forEach((d) => {
      const v = d.data();
      console.log(`--- ${d.id}`);
      console.log(`  keys: ${Object.keys(v).sort().join(',')}`);
      Object.entries(v).forEach(([k, val]) => {
        let s;
        if (val && typeof val === 'object' && val.toDate) s = val.toDate().toISOString();
        else if (val && typeof val === 'object') s = JSON.stringify(val);
        else s = String(val);
        if (s && s.length > 200) s = s.slice(0, 200) + '…';
        console.log(`  ${k}: ${s}`);
      });
    });
    return;
  }
  const [events, unpaid] = await Promise.all([
    fetchTodayEvents(db, businessId, opts.windowHours),
    fetchUnpaidInvoices(db, businessId, opts.unpaidHours),
  ]);

  if (opts.json) {
    console.log(JSON.stringify({ businessId, events, unpaid, generatedAt: new Date().toISOString() }, null, 2));
  } else {
    console.log(renderText({ events, unpaid, windowHours: opts.windowHours, unpaidHours: opts.unpaidHours }));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`hm-tq-status error: ${err.message}`);
    if (process.env.HM_TQ_DEBUG) console.error(err.stack);
    process.exit(1);
  }
);
