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
    else if (t === '--invoice') opts.invoiceQuery = argv[++i];
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
      customerId: v.customerId || v.clientId || ci.customerId || '',
      jobId: v.jobId || v.invoiceId || v.invoiceJobId || '',
      invoiceNumber: v.invoiceNumber || v.number || '',
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

  const items = snap.docs
    .filter((d) => {
      const v = d.data();
      // Exclude soft-deleted invoices and those converted back to quotes.
      if (v.isDeleted) return false;
      if (v.convertedToType && v.convertedToType !== 'jobs') return false;
      return true;
    })
    .map((d) => {
    const v = d.data();
    const created = tsToDate(v.createdAt) || tsToDate(v.updatedAt) || null;
    const lastPay = v.lastPaymentDate ? new Date(v.lastPaymentDate) : null;
    const ci = v.clientInfo || {};
    const ciName = [ci.firstName, ci.lastName].filter(Boolean).join(' ').trim();
    // Sum paymentDates as source of truth (totalPaid scalar can be stale).
    let summedPaid = 0;
    if (Array.isArray(v.paymentDates)) {
      for (const p of v.paymentDates) {
        const amt = typeof p?.amount === 'number' ? p.amount : Number(p?.amount || 0);
        if (Number.isFinite(amt) && amt > 0) summedPaid += amt;
      }
    }
    const totalPaid = Math.max(summedPaid, typeof v.totalPaid === 'number' ? v.totalPaid : 0);
    // Compute balance from total - paid (authoritative); fall back only if total missing.
    let balance = null;
    if (typeof v.total === 'number') balance = v.total - totalPaid;
    else if (typeof v.balanceDue === 'number') balance = v.balanceDue;
    if (balance != null) balance = Math.round(balance * 100) / 100;
    // "Stale" for collection purposes = lastPaymentDate (or createdAt) older than threshold.
    const staleAnchor = lastPay || created;
    return {
      id: d.id,
      number: v.invoiceNumber || v.number || d.id,
      customerId: v.customerId || v.clientId || ci.customerId || '',
      clientName: ciName || v.clientName || v.customerName || '',
      total: typeof v.total === 'number' ? v.total : null,
      totalPaid,
      balanceDue: balance,
      paymentStatus: v.paymentStatus,
      createdAt: created,
      lastPaymentDate: lastPay,
      staleAnchor,
      ageHours: staleAnchor ? Math.floor((Date.now() - staleAnchor.getTime()) / 36e5) : null,
    };
  });
  return items
    .filter((i) => i.balanceDue != null && i.balanceDue > 0.5)
    .filter((i) => i.staleAnchor && i.staleAnchor < cutoff)
    .sort((a, b) => (a.staleAnchor - b.staleAnchor));
}

async function fetchOwnerContext(db, businessId) {
  const snap = await db
    .collection('ownerContext')
    .where('businessId', '==', businessId)
    .limit(200)
    .get();

  return snap.docs
    .map((d) => {
      const v = d.data();
      return {
        id: d.id,
        text: String(v.text || '').trim(),
        scopeType: String(v.scopeType || ''),
        customerId: String(v.customerId || ''),
        customerName: String(v.customerName || ''),
        jobId: String(v.jobId || ''),
        invoiceNumber: String(v.invoiceNumber || ''),
        eventId: String(v.eventId || ''),
        importance: String(v.importance || 'normal'),
        tags: Array.isArray(v.tags) ? v.tags.map(String) : [],
        createdAt: tsToDate(v.createdAt),
      };
    })
    .filter((entry) => entry.text)
    .sort((a, b) => {
      const ai = a.importance === 'high' ? 1 : 0;
      const bi = b.importance === 'high' ? 1 : 0;
      if (ai !== bi) return bi - ai;
      return (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
    });
}

function normalizeNeedle(value) {
  return String(value || '').trim().toLowerCase();
}

function namesOverlap(left, right) {
  const a = normalizeNeedle(left);
  const b = normalizeNeedle(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function contextForEvent(event, context) {
  return context
    .filter((entry) => {
      if (entry.eventId && entry.eventId === event.id) return true;
      if (entry.jobId && event.jobId && entry.jobId === event.jobId) return true;
      if (entry.customerId && event.customerId && entry.customerId === event.customerId) return true;
      if (entry.customerName && namesOverlap(entry.customerName, event.clientName)) return true;
      return false;
    })
    .slice(0, 2);
}

function contextForInvoice(invoice, context) {
  return context
    .filter((entry) => {
      if (entry.jobId && entry.jobId === invoice.id) return true;
      if (entry.invoiceNumber && String(entry.invoiceNumber) === String(invoice.number)) return true;
      if (entry.customerId && invoice.customerId && entry.customerId === invoice.customerId) return true;
      if (entry.customerName && namesOverlap(entry.customerName, invoice.clientName)) return true;
      return false;
    })
    .slice(0, 2);
}

function summarizeContext(entry) {
  const tags = entry.tags?.length ? ` [${entry.tags.slice(0, 2).join(', ')}]` : '';
  return `${entry.text}${tags}`;
}

function renderText({ events, unpaid, ownerContext, windowHours, unpaidHours }) {
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
      const remembered = contextForEvent(e, ownerContext);
      remembered.forEach((entry) => {
        lines.push(`    context: ${summarizeContext(entry)}`);
      });
    }
  }
  lines.push('');

  lines.push(`Unpaid > ${unpaidHours}h (${unpaid.length}):`);
  if (unpaid.length === 0) {
    lines.push('  (none)');
  } else {
    let totalOwed = 0;
    for (const u of unpaid) {
      const balance = u.balanceDue != null ? u.balanceDue : 0;
      totalOwed += balance;
      const balStr = `$${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const paid = u.totalPaid > 0 ? ` (paid $${u.totalPaid.toLocaleString('en-US')})` : '';
      const lastPay = u.lastPaymentDate ? `, last paid ${u.lastPaymentDate.toISOString().slice(0, 10)}` : '';
      lines.push(`  #${u.number}  ${u.clientName || '(no client)'}  ${balStr}${paid}  [${u.paymentStatus}, ${fmtAge(u.ageHours)} since activity${lastPay}]`);
      const remembered = contextForInvoice(u, ownerContext);
      remembered.forEach((entry) => {
        lines.push(`    context: ${summarizeContext(entry)}`);
      });
    }
    lines.push('');
    lines.push(`  Total outstanding balance: $${totalOwed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  }

  const highContext = ownerContext
    .filter((entry) => entry.importance === 'high')
    .filter((entry) => entry.scopeType !== 'owner')
    .slice(0, 3);
  if (highContext.length) {
    lines.push('');
    lines.push('High-importance context:');
    highContext.forEach((entry) => {
      const scope = entry.customerName || entry.invoiceNumber || entry.scopeType || 'business';
      lines.push(`  ${scope}: ${summarizeContext(entry)}`);
    });
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

  if (opts.invoiceQuery) {
    const q = String(opts.invoiceQuery).toLowerCase();
    // Match by invoiceNumber, document id, or client first/last name (substring).
    const snap = await db.collection('jobs').where('businessId', '==', businessId).get();
    const matches = snap.docs.filter((d) => {
      const v = d.data();
      const ci = v.clientInfo || {};
      const hay = [
        v.invoiceNumber, d.id,
        v.clientName, v.customerName,
        ci.firstName, ci.lastName,
      ].filter(Boolean).map((s) => String(s).toLowerCase()).join(' | ');
      return hay.includes(q);
    });
    console.log(`Matches for "${opts.invoiceQuery}": ${matches.length}`);
    matches.forEach((d) => {
      const v = d.data();
      console.log(`\n=== job ${d.id}  (#${v.invoiceNumber || '?'})`);
      Object.entries(v).forEach(([k, val]) => {
        let s;
        if (val && typeof val === 'object' && val.toDate) s = val.toDate().toISOString();
        else if (val && typeof val === 'object') s = JSON.stringify(val);
        else s = String(val);
        if (s && s.length > 400) s = s.slice(0, 400) + '…';
        console.log(`  ${k}: ${s}`);
      });
    });
    return;
  }

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
  const [events, unpaid, ownerContext] = await Promise.all([
    fetchTodayEvents(db, businessId, opts.windowHours),
    fetchUnpaidInvoices(db, businessId, opts.unpaidHours),
    fetchOwnerContext(db, businessId),
  ]);

  if (opts.json) {
    console.log(JSON.stringify({ businessId, events, unpaid, ownerContext, generatedAt: new Date().toISOString() }, null, 2));
  } else {
    console.log(renderText({ events, unpaid, ownerContext, windowHours: opts.windowHours, unpaidHours: opts.unpaidHours }));
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
