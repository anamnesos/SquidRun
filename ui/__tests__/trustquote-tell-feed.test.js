const {
  buildTrustQuoteFactSignalsFromDocs,
  DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS,
  DRAFT_MARGIN_MAX_AGE_MS,
  isDeletedTrustQuoteDoc,
  timestampMs,
} = require('../modules/main/trustquote-tell-feed');

describe('trustquote tell feed', () => {
  test('emits raw TrustQuote facts without MIND judgment fields', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs,
      source: 'live',
      parkedCustomerIds: [],
      quotes: [{
        id: 'NpVMdNLeSPsyI8BUnHFO',
        data: {
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
          invoiceNumber: '109',
          type: 'quote',
          status: 'ready',
          total: 24000,
          balanceDue: 24000,
          paymentStatus: 'unpaid',
          createdAt: 1763003799538,
          updatedAt: nowMs,
          customerId: 'cust-charles-long',
          clientInfo: { firstName: 'Charles', lastName: 'Long' },
          jobTypes: [
            { type: 'Property Line Cleanout', price: '7000' },
            { type: 'Sewer Line Replacement', price: '5000' },
            { type: 'Drain Re-pipe Crawlspace', price: '12000' },
          ],
        },
      }],
    });

    const margin = signals.find((signal) => signal.type === 'trustquote:job-margin');
    expect(signals.some((signal) => signal.type === 'trustquote:invoice-aging')).toBe(false);
    expect(margin).toEqual(expect.objectContaining({
      id: 'quotes:NpVMdNLeSPsyI8BUnHFO:job-margin',
      source: 'live',
      observedAtMs: nowMs,
      rawRefs: expect.objectContaining({
        system: 'trustquote',
        collection: 'quotes',
        docId: 'NpVMdNLeSPsyI8BUnHFO',
        customerId: 'cust-charles-long',
        customerIdentityKey: 'trustquote:customer:cust-charles-long',
      }),
      facts: expect.objectContaining({
        bidAmount: 24000,
        bidPrice: 24000,
        bidCost: null,
        bidMarginPct: null,
        jobType: 'Property Line Cleanout',
        jobTypes: ['Property Line Cleanout', 'Sewer Line Replacement', 'Drain Re-pipe Crawlspace'],
        historicalMargin: { floorPct: null, sampleCount: 0, jobIds: [] },
        bidStatus: 'ready-to-send',
        customerId: 'cust-charles-long',
        customerIdentityKey: 'trustquote:customer:cust-charles-long',
        customerLabel: 'Charles Long',
        docNumber: '109',
      }),
    }));

    for (const signal of signals) {
      expect(signal).not.toHaveProperty('claim');
      expect(signal).not.toHaveProperty('whyNow');
      expect(signal).not.toHaveProperty('receipts');
      expect(signal).not.toHaveProperty('materialityUsd');
      expect(signal).not.toHaveProperty('proposedAction');
      expect(signal).not.toHaveProperty('regretScore');
      expect(signal).not.toHaveProperty('speak');
    }
  });

  test('fails source closed and emits invoice-aging/proof facts as raw fields for pending jobs only', () => {
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs: Date.parse('2026-06-22T16:50:00.000Z'),
      source: '',
      jobs: [{
        id: 'invoice-469',
        data: {
          invoiceNumber: 469,
          type: 'job',
          isProposal: false,
          status: 'sent',
          paymentStatus: 'partial',
          total: '34359.19',
          totalPaid: '30000',
          balanceDue: '4359.19',
          createdAt: 1770939258085,
          updatedAt: 1781551681194,
          lastEmailSentAt: 1781000000000,
          photoCount: 0,
        },
      }],
    });

    expect(signals.map((signal) => signal.source)).toEqual(['unverified', 'unverified', 'unverified']);
    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'trustquote:invoice-aging',
        facts: expect.objectContaining({
          invoiceAmount: 34359.19,
          balanceDue: 4359.19,
          documentType: 'job',
          isProposal: false,
          isPendingJob: true,
          status: 'partial',
          lastChasedMs: 1781000000000,
        }),
      }),
      expect.objectContaining({
        type: 'trustquote:job-proof-stale',
        facts: expect.objectContaining({
          jobValue: 34359.19,
          jobStatus: 'sent',
          proofRequired: ['photos'],
          proofPresent: [],
        }),
      }),
    ]));
  });

  test('does not emit invoice-aging or margin for stale draft quotes even when old and unpaid', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs,
      source: 'live',
      parkedCustomerIds: [],
      quotes: [{
        id: 'draft-yash-quote',
        data: {
          invoiceNumber: '113',
          type: 'quote',
          invoiceLabel: 'Quote #',
          isProposal: true,
          status: 'draft',
          paymentStatus: 'unpaid',
          total: 36500,
          balanceDue: 36500,
          date: '2026-04-17',
          customerId: 'yash-customer',
          clientInfo: { firstName: 'Yash' },
        },
      }],
    });

    expect(signals.some((signal) => signal.type === 'trustquote:invoice-aging')).toBe(false);
    expect(signals).toEqual([]);
  });

  test('filters deleted TrustQuote tombstones before any signal is built', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs,
      source: 'live',
      parkedCustomerIds: [],
      quotes: [{
        id: 'deleted-pending-quote',
        data: {
          invoiceNumber: '001',
          status: 'pending',
          total: 850,
          isDeleted: true,
          deletedAt: { seconds: 1778364321 },
          deletedBy: 'james',
          updatedAt: nowMs,
        },
      }],
      jobs: [{
        id: 'deleted-job-string-flag',
        data: {
          invoiceNumber: '002',
          type: 'job',
          status: 'sent',
          total: 1000,
          isDeleted: 'true',
          updatedAt: nowMs,
        },
      }],
    });

    expect(signals).toEqual([]);
    expect(isDeletedTrustQuoteDoc({ data: { isDeleted: '1' } })).toBe(true);
    expect(isDeletedTrustQuoteDoc({ data: { deletedBy: 'james' } })).toBe(true);
  });

  test('still emits margin facts for recent draft quotes', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs,
      source: 'live',
      parkedCustomerIds: [],
      quotes: [{
        id: 'recent-draft-quote',
        data: {
          invoiceNumber: '114',
          type: 'quote',
          invoiceLabel: 'Quote #',
          isProposal: true,
          status: 'draft',
          total: 9000,
          updatedAt: nowMs - DRAFT_MARGIN_MAX_AGE_MS + 1000,
          customerId: 'recent-draft-customer',
          clientInfo: { firstName: 'Recent', lastName: 'Draft' },
        },
      }],
    });

    expect(signals.map((signal) => signal.type)).toEqual(['trustquote:job-margin']);
    expect(signals[0].facts).toEqual(expect.objectContaining({
      bidStatus: 'draft',
      lastUserViewMs: nowMs - DRAFT_MARGIN_MAX_AGE_MS + 1000,
    }));
  });

  test('falls back to document identity instead of using customer name as key', () => {
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs: Date.parse('2026-06-22T16:50:00.000Z'),
      source: 'live',
      parkedCustomerIds: [],
      quotes: [{
        id: 'same-first-name-different-doc',
        data: {
          invoiceNumber: '110',
          total: 12000,
          status: 'ready',
          clientInfo: { firstName: 'Charles' },
        },
      }],
    });

    const margin = signals.find((signal) => signal.type === 'trustquote:job-margin');
    expect(margin.rawRefs).toEqual(expect.objectContaining({
      customerId: null,
      customerIdentityKey: 'trustquote:quotes:same-first-name-different-doc',
    }));
    expect(margin.facts).toEqual(expect.objectContaining({
      customerId: '',
      customerIdentityKey: 'trustquote:quotes:same-first-name-different-doc',
      customerLabel: 'Charles',
    }));
  });

  test('parks configured customer ids before signals reach the MIND', () => {
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs: Date.parse('2026-06-22T16:50:00.000Z'),
      source: 'live',
      quotes: [{
        id: 'parked-charles-quote',
        data: {
          invoiceNumber: '109',
          total: 24000,
          status: 'ready',
          customerId: DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS[0],
          clientInfo: { firstName: 'Charles', lastName: 'Long' },
        },
      }, {
        id: 'available-quote',
        data: {
          invoiceNumber: '110',
          total: 12000,
          status: 'ready',
          customerId: 'available-customer',
          clientInfo: { firstName: 'Available', lastName: 'Customer' },
        },
      }],
    });

    expect(signals).toHaveLength(1);
    expect(signals.every((signal) => signal.rawRefs.docId === 'available-quote')).toBe(true);
    expect(signals.some((signal) => signal.type === 'trustquote:invoice-aging')).toBe(false);
    expect(signals.some((signal) => signal.type === 'trustquote:job-proof-stale')).toBe(false);
    expect(JSON.stringify(signals)).not.toContain('Charles');
    expect(JSON.stringify(signals)).not.toContain(DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS[0]);
  });

  test('normalizes Firestore timestamp-like values', () => {
    expect(timestampMs({ seconds: 1000 })).toBe(1000000);
    expect(timestampMs({ toMillis: () => 12345 })).toBe(12345);
    expect(timestampMs('2026-06-22T00:00:00.000Z')).toBe(Date.parse('2026-06-22T00:00:00.000Z'));
  });
});
