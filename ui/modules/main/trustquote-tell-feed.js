'use strict';

const path = require('path');
const { normalizeSource } = require('../the-tell/scorer');

const DEFAULT_TRUSTQUOTE_ROOT = process.env.TRUSTQUOTE_ROOT || 'D:\\projects\\TrustQuote';
const TRUSTQUOTE_BUSINESS_ID = 'zDPMRRIlMiVJBOMhBbqrMk2iMI72';
const READ_COLLECTIONS = Object.freeze(['jobs', 'quotes']);
const DRAFT_MARGIN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS = Object.freeze([
  'gkbmoefFvpwToedb4s8w',
]);

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

function getDocTotal(data) {
  return toNumber(data?.total ?? data?.grandTotal ?? data?.subtotal ?? data?.amount ?? data?.invoiceTotal, 0);
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

function proofPresent(data) {
  const present = [];
  if (toNumber(data?.photoCount, 0) > 0) present.push('photos');
  if (Array.isArray(data?.photoUrls) && data.photoUrls.length > 0) present.push('photoUrls');
  if (Array.isArray(data?.mediaAssets) && data.mediaAssets.length > 0) present.push('mediaAssets');
  if (data?.warrantiesActivated) present.push('warrantyActivation');
  return present;
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

function buildJobMarginFact(doc, nowMs, source) {
  const data = doc.data || {};
  const jobTypes = Array.isArray(data.jobTypes) ? data.jobTypes : [];
  const types = serviceTypes(jobTypes);
  const bidPrice = getDocTotal(data);
  if (bidPrice <= 0) return null;
  const bidStatus = normalizedBidStatus(data);
  const lastUserViewMs = timestampMs(data.lastViewedAt || data.lastOpenedAt || data.updatedAt || data.createdAt);
  if (bidStatus === 'draft' && (!Number.isFinite(lastUserViewMs) || nowMs - lastUserViewMs > DRAFT_MARGIN_MAX_AGE_MS)) {
    return null;
  }

  return baseSignal(doc, 'trustquote:job-margin', nowMs, source, {
    bidAmount: bidPrice,
    bidPrice,
    bidCost: toNumber(data.bidCost ?? data.cost ?? data.materialCost ?? data.materialsCost, null),
    bidMarginPct: toNumber(data.bidMarginPct ?? data.marginPct ?? data.margin, null),
    jobType: types[0] || toText(data.type, doc.collection === 'quotes' ? 'quote' : 'job'),
    jobTypes: types,
    historicalMargin: {
      floorPct: null,
      sampleCount: 0,
      jobIds: [],
    },
    bidStatus,
    lastUserViewMs,
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

function buildProofStaleFact(doc, nowMs, source) {
  const data = doc.data || {};
  if (isProposalDoc(doc, data)) return null;
  const jobValue = getDocTotal(data);
  if (jobValue <= 0) return null;
  return baseSignal(doc, 'trustquote:job-proof-stale', nowMs, source, {
    jobValue,
    jobStatus: toText(data.status || data.jobStatus || data.type, 'unknown'),
    proofRequired: ['photos'],
    proofPresent: proofPresent(data),
    proofSyncedAtMs: timestampMs(data.mediaSyncedAt || data.photosSyncedAt || data.updatedAt || data.createdAt),
    customerReachable: Boolean(data.clientEmail || data.clientPhone || data.clientInfo?.email || data.clientInfo?.phone),
    customerId: getCustomerId(data),
    customerIdentityKey: getCustomerIdentityKey(doc),
    customerLabel: getClientLabel(data),
    docNumber: getDocNumber(doc),
  });
}

function buildTrustQuoteFactSignalsFromDocs({
  jobs = [],
  quotes = [],
  nowMs = Date.now(),
  source = 'unverified',
  parkedCustomerIds = parkedCustomerIdsFromEnv(),
} = {}) {
  const normalizedSource = normalizeSource(source);
  const parkedSet = normalizeParkedCustomerIds(parkedCustomerIds);
  const docs = [
    ...jobs.map((doc) => ({ ...doc, collection: doc.collection || 'jobs' })),
    ...quotes.map((doc) => ({ ...doc, collection: doc.collection || 'quotes' })),
  ].filter((doc) => !doc.data?.isDeleted && !doc.data?.deletedAt && !isParkedCustomerDoc(doc, parkedSet));

  const signals = [];
  for (const doc of docs) {
    const margin = buildJobMarginFact(doc, nowMs, normalizedSource);
    const aging = buildInvoiceAgingFact(doc, nowMs, normalizedSource);
    const proof = buildProofStaleFact(doc, nowMs, normalizedSource);
    if (margin) signals.push(margin);
    if (aging) signals.push(aging);
    if (proof) signals.push(proof);
  }
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
    const [jobs, quotes] = await Promise.all(READ_COLLECTIONS.map((collection) => readCollection(db, collection, businessId, limit)));
    const signals = buildTrustQuoteFactSignalsFromDocs({
      jobs,
      quotes,
      nowMs,
      source: 'live',
      parkedCustomerIds: options.parkedCustomerIds,
    });
    const parkedSet = normalizeParkedCustomerIds(options.parkedCustomerIds ?? parkedCustomerIdsFromEnv());
    const allDocs = [...jobs, ...quotes];
    const parkedCount = allDocs.filter((doc) => isParkedCustomerDoc(doc, parkedSet)).length;
    return {
      ok: true,
      source: 'live',
      checkedAt,
      businessId,
      root,
      data: {
        counts: { jobs: jobs.length, quotes: quotes.length },
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
      data: { counts: { jobs: 0, quotes: 0 }, signals: [] },
    };
  }
}

module.exports = {
  DEFAULT_TRUSTQUOTE_ROOT,
  DRAFT_MARGIN_MAX_AGE_MS,
  DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS,
  TRUSTQUOTE_BUSINESS_ID,
  buildTrustQuoteFactSignalsFromDocs,
  fetchTrustQuoteReadOnlySignals,
  normalizeParkedCustomerIds,
  timestampMs,
};
