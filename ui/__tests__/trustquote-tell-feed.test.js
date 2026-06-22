const {
  buildTrustQuoteFactSignalsFromDocs,
  buildScheduleCollisionFact,
  DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS,
  DRAFT_MARGIN_MAX_AGE_MS,
  isDeletedTrustQuoteDoc,
  timestampMs,
} = require('../modules/main/trustquote-tell-feed');

function parsePrice(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  return Number(String(value).replace(/,/g, '')) || 0;
}

function parseQuantity(value) {
  if (!value) return 1;
  if (typeof value === 'number') return value;
  return Number(String(value)) || 1;
}

function toCents(value) {
  return Math.round(parsePrice(value) * 100);
}

function fromCents(value) {
  return Math.round(value) / 100;
}

function makePricingModule() {
  const pricing = {};
  pricing.calculateBaseTotal = jest.fn((quantity, price) => fromCents(parseQuantity(quantity) * toCents(price)));
  pricing.calculateServiceTotal = jest.fn((job) => {
    const qty = parseQuantity(job.quantity || '1');
    const base = pricing.calculateBaseTotal(qty, job.price || '0');
    const addOnsPerUnit = (job.addOns || []).reduce((sum, addOn) => {
      return sum + Math.round(toCents(addOn.price || '0') * parseQuantity(addOn.quantity || '1'));
    }, 0);
    return fromCents(toCents(base) + Math.round(addOnsPerUnit * qty));
  });
  pricing.calculateGrandTotal = jest.fn((subtotal, discount) => fromCents(Math.max(0, toCents(subtotal) - toCents(discount || 0))));
  return pricing;
}

describe('trustquote tell feed', () => {
  let pricingModule;

  beforeEach(() => {
    pricingModule = makePricingModule();
  });

  test('emits raw TrustQuote facts without MIND judgment fields', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs,
      source: 'live',
      parkedCustomerIds: [],
      pricingModule,
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

  test('fails source closed and emits invoice-aging facts as raw fields for pending jobs only', () => {
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

    expect(signals.map((signal) => signal.source)).toEqual(['unverified']);
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
    ]));
    expect(signals.some((signal) => signal.type === 'trustquote:job-proof-stale')).toBe(false);
  });

  test('emits job-tasks-incomplete facts from TrustQuote jobTasks, not proof fields', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs,
      source: 'live',
      parkedCustomerIds: [],
      jobs: [{
        id: 'job-with-open-tasks',
        data: {
          invoiceNumber: 470,
          type: 'job',
          status: 'sent',
          paymentStatus: 'partial',
          total: 1200,
          balanceDue: 200,
          customerId: 'customer-tasks',
          clientInfo: { firstName: 'Tasky' },
          photoCount: 0,
          jobTypes: [{
            type: 'Water heater',
            price: '1200',
            jobTasks: [
              { id: 'pull-permit', name: 'Pull permit', completed: false },
              { id: 'install', name: 'Install', completed: true },
            ],
          }],
        },
      }],
    });

    const tasks = signals.find((signal) => signal.type === 'trustquote:job-tasks-incomplete');
    expect(tasks).toEqual(expect.objectContaining({
      id: 'jobs:job-with-open-tasks:job-tasks-incomplete',
      source: 'live',
      facts: expect.objectContaining({
        jobStatus: 'sent',
        isProposal: false,
        isPendingJob: true,
        tasksTotal: 2,
        tasksIncomplete: 1,
        jobValue: 1200,
        taskSummary: {
          total: 2,
          completed: 1,
          incomplete: 1,
          incompleteTaskIds: ['pull-permit'],
        },
      }),
    }));
    expect(tasks.facts).not.toHaveProperty('proofRequired');
    expect(tasks.facts).not.toHaveProperty('proofPresent');
    expect(signals.some((signal) => signal.type === 'trustquote:job-proof-stale')).toBe(false);
  });

  test('does not emit invoice-aging or margin for stale draft quotes even when old and unpaid', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs,
      source: 'live',
      parkedCustomerIds: [],
      pricingModule,
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
      pricingModule,
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

  test('emits schedule collision commitments only for confirmed fixed-time bookings', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const startMs = nowMs + 60 * 60 * 1000;
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs,
      source: 'live',
      parkedCustomerIds: [],
      events: [{
        id: 'event-a',
        data: {
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
          status: 'scheduled',
          start: startMs,
          end: startMs + 90 * 60 * 1000,
          title: 'Water heater install',
          clientName: 'Deepika',
          customerId: 'customer-a',
          jobId: 'job-a',
        },
      }, {
        id: 'event-b',
        data: {
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
          status: 'scheduled',
          start: startMs + 30 * 60 * 1000,
          end: startMs + 120 * 60 * 1000,
          title: 'Rough-in',
          clientName: 'Charles Saulus',
          customerId: 'customer-b',
          jobId: 'job-b',
        },
      }, {
        id: 'event-tentative',
        data: {
          status: 'tentative',
          start: startMs,
          end: startMs + 60 * 60 * 1000,
          title: 'Maybe',
          clientName: 'Tentative',
          customerId: 'customer-c',
        },
      }, {
        id: 'event-all-day',
        data: {
          status: 'scheduled',
          start: Date.parse('2026-06-23T00:00:00.000Z'),
          end: Date.parse('2026-06-23T23:59:59.999Z'),
          title: 'All day block',
          clientName: 'All Day',
          customerId: 'customer-d',
        },
      }],
    });

    const collision = signals.find((signal) => signal.type === 'promise:collision');
    expect(collision).toEqual(expect.objectContaining({
      id: 'calendar-events:schedule-overlap:promise-collision',
      source: 'live',
      rawRefs: expect.objectContaining({
        collection: 'calendar-events',
        eventIds: ['event-a', 'event-b'],
      }),
    }));
    expect(collision.facts.commitments).toEqual([
      expect.objectContaining({
        id: 'event-a',
        who: 'Deepika',
        what: 'Water heater install',
        startMs,
        endMs: startMs + 90 * 60 * 1000,
        durationMin: 90,
        confirmed: true,
        relationshipWeight: 0.7,
        customerId: 'customer-a',
        madeInContextRef: 'job:job-a',
        rawRef: 'calendar-events/event-a',
      }),
      expect.objectContaining({
        id: 'event-b',
        who: 'Charles Saulus',
        what: 'Rough-in',
        confirmed: true,
        madeInContextRef: 'job:job-b',
      }),
    ]);
  });

  test('schedule feed parks customers and tombstones before commitments reach MIND', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const startMs = nowMs + 60 * 60 * 1000;
    const signal = buildScheduleCollisionFact([{
      id: 'parked-event',
      data: {
        status: 'scheduled',
        start: startMs,
        end: startMs + 60 * 60 * 1000,
        customerId: DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS[0],
      },
    }, {
      id: 'deleted-event',
      data: {
        status: 'scheduled',
        start: startMs,
        end: startMs + 60 * 60 * 1000,
        customerId: 'live-customer',
        deletedAt: { seconds: 1 },
      },
    }], nowMs, 'live');

    expect(signal).toBeNull();
  });

  test('still emits margin facts for recent draft quotes', () => {
    const nowMs = Date.parse('2026-06-22T16:50:00.000Z');
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs,
      source: 'live',
      parkedCustomerIds: [],
      pricingModule,
      quotes: [{
        id: 'recent-draft-quote',
        data: {
          invoiceNumber: '114',
          type: 'quote',
          invoiceLabel: 'Quote #',
          isProposal: true,
          status: 'draft',
          total: 9000,
          jobTypes: [{ type: 'Drain repair', price: '9000' }],
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
      pricingModule,
      quotes: [{
        id: 'same-first-name-different-doc',
        data: {
          invoiceNumber: '110',
          total: 12000,
          jobTypes: [{ type: 'Cleanout', price: '12000' }],
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
      pricingModule,
      quotes: [{
        id: 'parked-charles-quote',
        data: {
          invoiceNumber: '109',
          total: 24000,
          jobTypes: [{ type: 'Parked job', price: '24000' }],
          status: 'ready',
          customerId: DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS[0],
          clientInfo: { firstName: 'Charles', lastName: 'Long' },
        },
      }, {
        id: 'available-quote',
        data: {
          invoiceNumber: '110',
          total: 12000,
          jobTypes: [{ type: 'Available job', price: '12000' }],
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

  test('margin bid amount uses TrustQuote canonical pricing instead of stored total shortcuts', () => {
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs: Date.parse('2026-06-22T16:50:00.000Z'),
      source: 'live',
      parkedCustomerIds: [],
      pricingModule,
      quotes: [{
        id: 'priced-through-canonical-module',
        data: {
          invoiceNumber: '115',
          total: 9999,
          status: 'ready',
          discount: 7,
          jobTypes: [{
            type: 'Fixture install',
            quantity: '2',
            price: '10',
            addOns: [{ name: 'Valve', price: '3', quantity: '2' }],
          }, {
            type: 'Service call',
            quantity: '1',
            price: '50',
          }],
        },
      }],
    });

    const margin = signals.find((signal) => signal.type === 'trustquote:job-margin');
    expect(margin.facts).toEqual(expect.objectContaining({
      bidAmount: 75,
      bidPrice: 75,
      pricingSource: 'trustquote:lib/pricing/invoicePricing.ts',
    }));
    expect(pricingModule.calculateBaseTotal).toHaveBeenCalled();
    expect(pricingModule.calculateServiceTotal).toHaveBeenCalledTimes(2);
    expect(pricingModule.calculateGrandTotal).toHaveBeenCalledWith(82, 7);
  });

  test('normalizes Firestore timestamp-like values', () => {
    expect(timestampMs({ seconds: 1000 })).toBe(1000000);
    expect(timestampMs({ toMillis: () => 12345 })).toBe(12345);
    expect(timestampMs('2026-06-22T00:00:00.000Z')).toBe(Date.parse('2026-06-22T00:00:00.000Z'));
  });
});
