'use strict';

const path = require('path');
const { normalizeSource } = require('../the-tell/scorer');

const DEFAULT_TRUSTQUOTE_ROOT = process.env.TRUSTQUOTE_ROOT || 'D:\\projects\\TrustQuote';
const TRUSTQUOTE_BUSINESS_ID = 'zDPMRRIlMiVJBOMhBbqrMk2iMI72';
const READ_COLLECTIONS = Object.freeze(['jobs', 'quotes']);
const CALENDAR_COLLECTION = 'calendar-events';
const DRAFT_MARGIN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_HARD_BOOKING_DURATION_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS = Object.freeze([
  'gkbmoefFvpwToedb4s8w',
]);
const pricingCache = new Map();

function toNumber(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[$,]/g, '').trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function timestampMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function getClientLabel(data) {
  const clientInfo = data?.clientInfo || {};
  const candidates = [
    data?.clientName,
    data?.customerName,
    [clientInfo.firstName, clientInfo.lastName].filter(Boolean).join(' '),
    [data?.clientFirstName, data?.clientLastName].filter(Boolean).join(' '),
  ];
  return toText(candidates.find((candidate) => toText(candidate, '')), 'Unknown client');
}

function getCustomerId(data) {
  return toText(data?.customerId || data?.clientId || data?.clientInfo?.id || data?.clientInfo?.customerId, '');
}

function getEventCustomerId(data) {
  return toText(data?.customerId || data?.clientId || data?.clientInfo?.id || data?.clientInfo?.customerId, '');
}

function getCustomerIdentityKey(doc) {
  const customerId = getCustomerId(doc.data || {});
  return customerId ? `trustquote:customer:${customerId}` : `trustquote:${doc.collection}:${doc.id}`;
}

function normalizeParkedCustomerIds(value = DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS) {
  const raw = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(raw)) return new Set(DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS);
  return new Set(raw.map((entry) => toText(entry, '')).filter(Boolean));
}

function parkedCustomerIdsFromEnv() {
  if (process.env.TRUSTQUOTE_TELL_PARKED_CUSTOMER_IDS === '') return [];
  return process.env.TRUSTQUOTE_TELL_PARKED_CUSTOMER_IDS || DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS;
}

function isParkedCustomerDoc(doc, parkedCustomerIds) {
  const customerId = getCustomerId(doc.data || {});
  return Boolean(customerId && parkedCustomerIds.has(customerId));
}

function isParkedEventDoc(doc, parkedCustomerIds) {
  const customerId = getEventCustomerId(doc.data || {});
  return Boolean(customerId && parkedCustomerIds.has(customerId));
}

function isDeletedTrustQuoteDoc(doc) {
  const data = doc?.data || {};
  const flag = String(data.isDeleted ?? '').trim().toLowerCase();
  return data.isDeleted === true
    || flag === 'true'
    || flag === '1'
    || Boolean(data.deletedAt)
    || Boolean(data.deletedBy);
}

function getDocTotal(data) {
  return toNumber(data?.total ?? data?.grandTotal ?? data?.subtotal ?? data?.amount ?? data?.invoiceTotal, 0);
}

function loadTrustQuotePricing(root = DEFAULT_TRUSTQUOTE_ROOT) {
  const resolvedRoot = path.resolve(root || DEFAULT_TRUSTQUOTE_ROOT);
  if (pricingCache.has(resolvedRoot)) return pricingCache.get(resolvedRoot);
  const previousCwd = process.cwd();
  try {
    process.chdir(resolvedRoot);
    require(require.resolve('tsx/cjs', { paths: [resolvedRoot] }));
    const pricing = require(path.join(resolvedRoot, 'lib', 'pricing', 'invoicePricing.ts'));
    const required = ['calculateBaseTotal', 'calculateServiceTotal', 'calculateGrandTotal'];
    for (const fn of required) {
      if (typeof pricing[fn] !== 'function') throw new Error(`trustquote_pricing_missing_${fn}`);
    }
    pricingCache.set(resolvedRoot, pricing);
    return pricing;
  } finally {
    process.chdir(previousCwd);
  }
}

function getCanonicalDocTotal(data, root = DEFAULT_TRUSTQUOTE_ROOT, pricingModule = null) {
  const jobTypes = Array.isArray(data?.jobTypes) ? data.jobTypes : [];
  if (jobTypes.length === 0) return null;
  try {
    const pricing = pricingModule || loadTrustQuotePricing(root);
    const subtotal = jobTypes.reduce((sum, job) => sum + pricing.calculateServiceTotal(job), 0);
    const total = pricing.calculateGrandTotal(subtotal, data?.discount ?? data?.discountAmount ?? 0);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

function getBalanceDue(data) {
  const explicit = toNumber(data?.balanceDue, null);
  if (explicit !== null) return explicit;
  const total = getDocTotal(data);
  const paid = toNumber(data?.totalPaid, 0);
  return Math.max(0, total - paid);
}

function getDocNumber(doc) {
  const data = doc.data || {};
  return toText(data.invoiceNumber || data.quoteNumber || doc.id, doc.id);
}

function serviceTypes(jobTypes) {
  if (!Array.isArray(jobTypes)) return [];
  return jobTypes
    .map((job) => toText(job?.type || job?.name || job?.title || job?.description, ''))
    .filter(Boolean);
}

function getTaskSummary(jobTypes) {
  const tasks = Array.isArray(jobTypes)
    ? jobTypes.flatMap((job) => Array.isArray(job?.jobTasks) ? job.jobTasks : [])
    : [];
  const incompleteTasks = tasks.filter((task) => !task?.completed);
  return {
    total: tasks.length,
    completed: tasks.length - incompleteTasks.length,
    incomplete: incompleteTasks.length,
    incompleteTaskIds: incompleteTasks
      .map((task) => toText(task?.id || task?.taskId || task?.name || task?.label || task?.title, ''))
      .filter(Boolean)
      .slice(0, 8),
  };
}

function normalizedBidStatus(data) {
  const raw = toText(data?.status || data?.paymentStatus || 'draft', 'draft').toLowerCase();
  if (/sent|emailed|sms/.test(raw)) return 'sent';
  if (/ready|approved|pending/.test(raw)) return 'ready-to-send';
  return 'draft';
}

function isProposalDoc(doc, data = doc.data || {}) {
  const type = toText(data.type || doc.collection, '').toLowerCase();
  const label = toText(data.invoiceLabel, '').toLowerCase();
  return doc.collection === 'quotes'
    || type === 'quote'
    || data.isProposal === true
    || label.includes('quote');
}

function normalizedPaymentStatus(data) {
  const explicit = toText(data.paymentStatus, '').toLowerCase();
  if (explicit) return explicit;
  const balanceDue = getBalanceDue(data);
  if (balanceDue <= 0) return 'paid';
  const paid = toNumber(data.totalPaid, 0);
  return paid > 0 ? 'partial' : 'unpaid';
}

function isPendingJobDoc(doc, data = doc.data || {}) {
  if (isProposalDoc(doc, data)) return false;
  const status = toText(data.status, '').toLowerCase();
  if (status === 'draft') return false;
  const paymentStatus = normalizedPaymentStatus(data);
  return paymentStatus !== 'paid' && paymentStatus !== 'overpaid';
}

function baseSignal(doc, type, nowMs, source, facts) {
  return {
    type,
    id: `${doc.collection}:${doc.id}:${type.split(':').pop()}`,
    source: normalizeSource(source),
    observedAtMs: nowMs,
    rawRefs: {
      system: 'trustquote',
      collection: doc.collection,
      docId: doc.id,
      businessId: TRUSTQUOTE_BUSINESS_ID,
      customerId: facts.customerId || null,
      customerIdentityKey: facts.customerIdentityKey || getCustomerIdentityKey(doc),
    },
    facts,
  };
}

function eventLabel(data) {
  const client = toText(data.clientName || data.customerName || [data.clientFirstName, data.clientLastName].filter(Boolean).join(' '), '');
  return client || 'scheduled customer';
}

function eventWorkLabel(data) {
  return toText(data.title || data.description || data.type || data.eventType, 'scheduled job');
}

function normalizedScheduleStatus(data) {
  // Mirrors TrustQuote calendar hooks: missing status defaults to scheduled.
  return toText(data.status, 'scheduled').toLowerCase();
}

function isScheduledStatus(data) {
  return normalizedScheduleStatus(data) === 'scheduled';
}

function bookingIntervalMs(data) {
  const startMs = timestampMs(data.start || data.startTime || data.scheduledStart || data.scheduledAt);
  const endMs = timestampMs(data.end || data.endTime || data.scheduledEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const durationMs = endMs - startMs;
  const startDate = new Date(startMs);
  const endDate = new Date(endMs);
  const looksAllDay = startDate.getUTCHours() === 0
    && startDate.getUTCMinutes() === 0
    && endDate.getUTCHours() === 23
    && endDate.getUTCMinutes() === 59;
  if (looksAllDay || durationMs > MAX_HARD_BOOKING_DURATION_MS) return null;
  return { startMs, endMs, durationMin: Math.round(durationMs / 60000) };
}

function buildScheduleCollisionFact(events = [], nowMs, source, parkedCustomerIds = parkedCustomerIdsFromEnv()) {
  const normalizedSource = normalizeSource(source);
  const parkedSet = normalizeParkedCustomerIds(parkedCustomerIds);
  const commitments = [];
  for (const event of events) {
    const doc = { ...event, collection: event.collection || CALENDAR_COLLECTION };
    const data = doc.data || {};
    if (isDeletedTrustQuoteDoc(doc) || isParkedEventDoc(doc, parkedSet)) continue;
    if (!isScheduledStatus(data)) continue;
    const interval = bookingIntervalMs(data);
    if (!interval || interval.endMs <= nowMs) continue;
    const customerId = getEventCustomerId(data);
    const linkedId = toText(data.jobId || data.invoiceId || data.linkedJobId || data.quoteId || doc.id, doc.id);
    commitments.push({
      id: doc.id,
      who: eventLabel(data),
      what: eventWorkLabel(data),
      startMs: interval.startMs,
      endMs: interval.endMs,
      durationMin: interval.durationMin,
      confirmed: true,
      relationshipWeight: 0.7,
      customerId,
      madeInContextRef: `job:${linkedId}`,
      rawRef: `calendar-events/${doc.id}`,
    });
  }
  if (commitments.length === 0) return null;
  // CAPACITY PRODUCER (S467 born-blind audit: the scorer consumed
  // facts.availableWindows/existingBusyMin that NOTHING produced — the
  // sensor was structurally silent forever, reading as "no collisions").
  // Windows are GENEROUS work hours (8:00-18:00, Mon-Sat) across the
  // commitment horizon: generosity biases toward FEWER collision calls,
  // so when the sensor does speak, even a generous calendar could not fit
  // the promises — the one-interrupt precision bar. existingBusyMin stays
  // 0 BY CONSTRUCTION: every booked interval already rides commitments,
  // and the scorer accumulates their durations itself (no double-count).
  const horizonEndMs = Math.min(
    commitments.reduce((m, c) => Math.max(m, c.endMs), nowMs) + 24 * 3600000,
    nowMs + 14 * 24 * 3600000
  );
  const availableWindows = [];
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  for (let t = day.getTime(); t < horizonEndMs; t += 24 * 3600000) {
    const d = new Date(t);
    if (d.getDay() === 0) continue; // Sundays off
    const startMs = Math.max(t + 8 * 3600000, nowMs);
    const endMs = Math.min(t + 18 * 3600000, horizonEndMs);
    if (endMs > startMs) availableWindows.push({ startMs, endMs });
  }
  return {
    type: 'promise:collision',
    id: 'calendar-events:schedule-overlap:promise-collision',
    context: 'promise:collision:schedule',
    source: normalizedSource,
    observedAtMs: nowMs,
    rawRefs: {
      system: 'trustquote',
      collection: CALENDAR_COLLECTION,
      docId: 'schedule-overlap',
      businessId: TRUSTQUOTE_BUSINESS_ID,
      eventIds: commitments.map((commitment) => commitment.id),
    },
    facts: { commitments, availableWindows, existingBusyMin: 0 },
  };
}

/**
 * HISTORICAL MARGIN INDEX (tell-sensors-v2: the S467 audit found this field
 * hardcoded to {floorPct:null,sampleCount:0} — the sensor starved on a stub
 * for 11 days, 2,746 swallows). Wedge-style grounding ported from the
 * pricing wedge's laws: comparables grouped by NORMALIZED type, floor only
 * at n>=3 (small-n honesty), LEAVE-ONE-OUT (a bid never grounds itself —
 * the eval-leakage law), transacted docs only (paid = market-accepted).
 */
// The WEDGE normalizer is the source of truth for job-type grouping
// (tell-sensors-v2 probe: the old local slug split 'Whole Home Water
// Repipe (2 Bath)' away from the repipe family and starved the floor —
// 8/10 live drafts were silent on granularity, not honesty).
const { normalizeJobType: normalizeWedgeJobType } = require('../the-tell/normalize-job-type');

function normalizeTellJobType(value) {
  return normalizeWedgeJobType(value);
}

function isTransactedDoc(data) {
  const pay = String(data.paymentStatus || '').toLowerCase();
  return pay === 'paid' || pay === 'overpaid';
}

function buildMarginIndex(docs, root = DEFAULT_TRUSTQUOTE_ROOT, pricingModule = null) {
  const byType = new Map(); // type -> [{docId, marginPct}]
  for (const doc of docs) {
    const data = doc.data || {};
    if (!isTransactedDoc(data)) continue;
    const price = getCanonicalDocTotal(data, root, pricingModule);
    if (!(price > 0)) continue;
    const marginPct = toNumber(data.bidMarginPct ?? data.marginPct ?? data.margin, null)
      ?? (Number.isFinite(toNumber(data.bidCost ?? data.cost ?? data.materialCost ?? data.materialsCost, NaN))
        ? (price - toNumber(data.bidCost ?? data.cost ?? data.materialCost ?? data.materialsCost, 0)) / price
        : null);
    // PRICE always indexes (his corpus holds prices, not costs — S451 law);
    // marginPct rides along only when cost data actually exists.
    for (const t of serviceTypes(Array.isArray(data.jobTypes) ? data.jobTypes : [])) {
      const key = normalizeTellJobType(t);
      if (!key) continue;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push({ docId: doc.id, marginPct: Number.isFinite(marginPct) ? marginPct : null, priceUsd: price });
    }
  }
  return byType;
}

function lookupHistoricalMargin(marginIndex, jobTypes, selfDocId) {
  const empty = { floorPct: null, sampleCount: 0, jobIds: [], priceFloorUsd: null, priceSampleCount: 0 };
  if (!marginIndex) return empty;
  for (const t of jobTypes || []) {
    const rows = (marginIndex.get(normalizeTellJobType(t)) || [])
      .filter((r) => r.docId !== selfDocId); // leave-one-out: never self-grounded
    if (rows.length < 3) continue;
    const out = { ...empty, jobIds: rows.map((r) => r.docId).slice(0, 12) };
    // PRICE floor (always available at n>=3): p25 of what he actually
    // charged for this normalized type — the floor speaks his own numbers.
    const prices = rows.map((r) => r.priceUsd).filter(Number.isFinite).sort((a, b) => a - b);
    if (prices.length >= 3) {
      out.priceFloorUsd = prices[Math.floor(prices.length * 0.25)];
      out.priceSampleCount = prices.length;
    }
    // MARGIN floor only when cost data genuinely exists at n>=3.
    const margins = rows.map((r) => r.marginPct).filter(Number.isFinite).sort((a, b) => a - b);
    if (margins.length >= 3) {
      out.floorPct = margins[Math.floor(margins.length * 0.25)];
      out.sampleCount = margins.length;
    }
    return out;
  }
  return empty;
}

function buildJobMarginFact(doc, nowMs, source, root = DEFAULT_TRUSTQUOTE_ROOT, pricingModule = null, marginIndex = null) {
  const data = doc.data || {};
  const jobTypes = Array.isArray(data.jobTypes) ? data.jobTypes : [];
  const types = serviceTypes(jobTypes);
  const bidPrice = getCanonicalDocTotal(data, root, pricingModule);
  if (bidPrice <= 0) return null;
  const bidStatus = normalizedBidStatus(data);
  const lastUserViewMs = timestampMs(data.lastViewedAt || data.lastOpenedAt || data.updatedAt || data.createdAt);
  if (bidStatus === 'draft' && (!Number.isFinite(lastUserViewMs) || nowMs - lastUserViewMs > DRAFT_MARGIN_MAX_AGE_MS)) {
    return null;
  }

  return baseSignal(doc, 'trustquote:job-margin', nowMs, source, {
    bidAmount: bidPrice,
    bidPrice,
    pricingSource: 'trustquote:lib/pricing/invoicePricing.ts',
    bidCost: toNumber(data.bidCost ?? data.cost ?? data.materialCost ?? data.materialsCost, null),
    bidMarginPct: toNumber(data.bidMarginPct ?? data.marginPct ?? data.margin, null),
    jobType: types[0] || toText(data.type, doc.collection === 'quotes' ? 'quote' : 'job'),
    jobTypes: types,
    historicalMargin: lookupHistoricalMargin(marginIndex, types, doc.id),
    bidStatus,
    lastUserViewMs,
    customerId: getCustomerId(data),
    customerIdentityKey: getCustomerIdentityKey(doc),
    customerLabel: getClientLabel(data),
    docNumber: getDocNumber(doc),
    // consumer reads facts.invoiceLabel for claim text — was never produced
    // (S467 audit: undefined would have rendered in the ONE interrupt)
    invoiceLabel: [getClientLabel(data), getDocNumber(doc) ? `#${getDocNumber(doc)}` : ''].filter(Boolean).join(' '),
  });
}

function buildTasksIncompleteFact(doc, nowMs, source, root = DEFAULT_TRUSTQUOTE_ROOT, pricingModule = null) {
  const data = doc.data || {};
  if (isProposalDoc(doc, data)) return null;
  const jobTypes = Array.isArray(data.jobTypes) ? data.jobTypes : [];
  const taskSummary = getTaskSummary(jobTypes);
  if (taskSummary.total === 0 || taskSummary.incomplete === 0) return null;
  const canonicalValue = getCanonicalDocTotal(data, root, pricingModule);

  return baseSignal(doc, 'trustquote:job-tasks-incomplete', nowMs, source, {
    taskSummary,
    tasksTotal: taskSummary.total,
    tasksIncomplete: taskSummary.incomplete,
    jobValue: canonicalValue ?? getDocTotal(data),
    jobStatus: toText(data.status || data.jobStatus || data.type, 'unknown'),
    isProposal: false,
    isPendingJob: isPendingJobDoc(doc, data),
    customerReachable: Boolean(data.lastEmailSentTo || data.lastSmsSentTo || data.clientEmail || data.clientPhone || data.clientInfo?.email || data.clientInfo?.phone),
    customerId: getCustomerId(data),
    customerIdentityKey: getCustomerIdentityKey(doc),
    customerLabel: getClientLabel(data),
    docNumber: getDocNumber(doc),
  });
}

function buildInvoiceAgingFact(doc, nowMs, source) {
  const data = doc.data || {};
  if (!isPendingJobDoc(doc, data)) return null;
  const balanceDue = getBalanceDue(data);
  const invoiceAmount = getDocTotal(data);
  const status = normalizedPaymentStatus(data);
  if (invoiceAmount <= 0 && balanceDue <= 0) return null;

  return baseSignal(doc, 'trustquote:invoice-aging', nowMs, source, {
    documentType: isProposalDoc(doc, data) ? 'quote' : 'job',
    isProposal: isProposalDoc(doc, data),
    isPendingJob: true,
    invoiceAmount,
    balanceDue,
    dueMs: timestampMs(data.dueDate || data.paymentDueDate || data.date || data.createdAt),
    status,
    paymentReceivedMs: timestampMs(data.lastPaymentDate || data.paymentReceivedAt),
    lastChasedMs: timestampMs(data.lastEmailSentAt || data.lastSmsSentAt || data.customerContactSentAt),
    customerReachable: Boolean(data.lastEmailSentTo || data.lastSmsSentTo || data.clientEmail || data.clientPhone || data.clientInfo?.email || data.clientInfo?.phone),
    customerId: getCustomerId(data),
    customerIdentityKey: getCustomerIdentityKey(doc),
    customerLabel: getClientLabel(data),
    docNumber: getDocNumber(doc),
  });
}

function buildTrustQuoteFactSignalsFromDocs({
  jobs = [],
  quotes = [],
  events = [],
  nowMs = Date.now(),
  source = 'unverified',
  parkedCustomerIds = parkedCustomerIdsFromEnv(),
  trustQuoteRoot = DEFAULT_TRUSTQUOTE_ROOT,
  pricingModule = null,
} = {}) {
  const normalizedSource = normalizeSource(source);
  const parkedSet = normalizeParkedCustomerIds(parkedCustomerIds);
  const docs = [
    ...jobs.map((doc) => ({ ...doc, collection: doc.collection || 'jobs' })),
    ...quotes.map((doc) => ({ ...doc, collection: doc.collection || 'quotes' })),
  ].filter((doc) => !isDeletedTrustQuoteDoc(doc) && !isParkedCustomerDoc(doc, parkedSet));

  const signals = [];
  // One index per tick over the full transacted snapshot — every margin
  // fact grounds on the same comparables the wedge law defines.
  const marginIndex = buildMarginIndex(docs, trustQuoteRoot, pricingModule);
  for (const doc of docs) {
    const margin = buildJobMarginFact(doc, nowMs, normalizedSource, trustQuoteRoot, pricingModule, marginIndex);
    const aging = buildInvoiceAgingFact(doc, nowMs, normalizedSource);
    const tasks = buildTasksIncompleteFact(doc, nowMs, normalizedSource, trustQuoteRoot, pricingModule);
    if (margin) signals.push(margin);
    if (aging) signals.push(aging);
    if (tasks) signals.push(tasks);
  }
  const scheduleCollision = buildScheduleCollisionFact(events, nowMs, normalizedSource, parkedCustomerIds);
  if (scheduleCollision) signals.push(scheduleCollision);
  return signals;
}

function requireFromRoot(root, moduleName) {
  return require(require.resolve(moduleName, { paths: [root] }));
}

function loadTrustQuoteEnv(root) {
  const dotenv = requireFromRoot(root, 'dotenv');
  dotenv.config({ path: path.join(root, '.env.local') });
}

function getFirebaseCredential() {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('trustquote_firebase_env_missing');
  }
  return { projectId, clientEmail, privateKey };
}

function initializeAdmin(root) {
  loadTrustQuoteEnv(root);
  const admin = requireFromRoot(root, 'firebase-admin');
  const appName = 'squidrun-trustquote-readonly';
  const existing = admin.apps.find((app) => app?.name === appName);
  if (existing) return { admin, app: existing };
  const app = admin.initializeApp({
    credential: admin.credential.cert(getFirebaseCredential()),
  }, appName);
  return { admin, app };
}

async function readCollection(db, collection, businessId, limit) {
  const snap = await db.collection(collection).where('businessId', '==', businessId).limit(limit).get();
  return snap.docs.map((doc) => ({ id: doc.id, collection, data: doc.data() }));
}

async function fetchTrustQuoteReadOnlySignals(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const root = options.root || DEFAULT_TRUSTQUOTE_ROOT;
  const businessId = options.businessId || TRUSTQUOTE_BUSINESS_ID;
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 80));
  const checkedAt = new Date(nowMs).toISOString();
  try {
    const { admin, app } = initializeAdmin(root);
    const db = admin.firestore(app);
    const [jobs, quotes, events] = await Promise.all([
      ...READ_COLLECTIONS.map((collection) => readCollection(db, collection, businessId, limit)),
      readCollection(db, CALENDAR_COLLECTION, businessId, Math.max(limit, 200)),
    ]);
    const signals = buildTrustQuoteFactSignalsFromDocs({
      jobs,
      quotes,
      events,
      nowMs,
      source: 'live',
      parkedCustomerIds: options.parkedCustomerIds,
    });
    const parkedSet = normalizeParkedCustomerIds(options.parkedCustomerIds ?? parkedCustomerIdsFromEnv());
    const allDocs = [...jobs, ...quotes];
    const parkedCount = allDocs.filter((doc) => isParkedCustomerDoc(doc, parkedSet)).length
      + events.filter((doc) => isParkedEventDoc(doc, parkedSet)).length;
    return {
      ok: true,
      source: 'live',
      checkedAt,
      businessId,
      root,
      data: {
        counts: { jobs: jobs.length, quotes: quotes.length },
        eventCount: events.length,
        parkedCount,
        signals,
      },
    };
  } catch (error) {
    return {
      ok: false,
      source: 'unverified',
      checkedAt,
      businessId,
      root,
      reason: error.message || 'trustquote_read_failed',
      data: { counts: { jobs: 0, quotes: 0 }, eventCount: 0, signals: [] },
    };
  }
}

module.exports = {
  DEFAULT_TRUSTQUOTE_ROOT,
  CALENDAR_COLLECTION,
  DRAFT_MARGIN_MAX_AGE_MS,
  MAX_HARD_BOOKING_DURATION_MS,
  DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS,
  buildScheduleCollisionFact,
  TRUSTQUOTE_BUSINESS_ID,
  buildTrustQuoteFactSignalsFromDocs,
  fetchTrustQuoteReadOnlySignals,
  isDeletedTrustQuoteDoc,
  normalizeParkedCustomerIds,
  timestampMs,
};
