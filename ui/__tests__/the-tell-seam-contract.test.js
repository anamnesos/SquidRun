'use strict';

const {
  buildTrustQuoteFactSignalsFromDocs,
  DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS,
} = require('../modules/main/trustquote-tell-feed');
const { evaluate } = require('../modules/the-tell/scorer');

const NOW = Date.parse('2026-06-22T17:30:00.000Z');
const OUTPUT_ONLY_FIELDS = Object.freeze([
  'claim',
  'whyNow',
  'receipts',
  'materialityUsd',
  'proposedAction',
  'regretScore',
  'speak',
  'pushback',
]);

function expectFeedSignalContract(signal, requiredFactKeys = []) {
  expect(signal).toEqual(expect.objectContaining({
    type: expect.any(String),
    id: expect.any(String),
    source: 'live',
    observedAtMs: NOW,
    rawRefs: expect.objectContaining({
      system: 'trustquote',
      businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
    }),
    facts: expect.any(Object),
  }));
  for (const field of OUTPUT_ONLY_FIELDS) {
    expect(signal).not.toHaveProperty(field);
  }
  for (const key of requiredFactKeys) {
    expect(signal.facts).toHaveProperty(key);
  }
}

function expectDryRunBodyEmission(output) {
  expect(output.speak).toBe(true);
  expect(output.source).toBe('live');
  expect(output.claim).toEqual(expect.any(String));
  expect(output.whyNow).toEqual(expect.any(String));
  expect(output.receipts).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: expect.any(String), value: expect.any(String) }),
  ]));
  expect(output.proposedAction).toEqual(expect.objectContaining({
    text: expect.any(String),
    reversible: true,
    executionMode: 'dry-run',
    dryRunLabel: expect.any(String),
  }));
  expect(JSON.stringify(output.proposedAction)).not.toMatch(/autoClose|hm-defi-close|privateKey/i);
  expect(output.proposedAction.dryRunLabel).toMatch(/don't|do not|nothing|no /i);
}

function liveSignal(overrides) {
  return {
    source: 'live',
    observedAtMs: NOW,
    rawRefs: {
      system: 'trustquote',
      collection: 'jobs',
      docId: 'fixture-doc',
      businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
    },
    ...overrides,
  };
}

describe('The Tell Feed->MIND->BODY seam contract', () => {
  test('TrustQuote live feed emits raw facts with provenance, not BODY judgment fields', () => {
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs: NOW,
      source: 'live',
      parkedCustomerIds: [],
      jobs: [{
        id: 'job-469',
        data: {
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
          invoiceNumber: 469,
          type: 'job',
          status: 'sent',
          paymentStatus: 'partial',
          total: '34359.19',
          totalPaid: '30000',
          balanceDue: '4359.19',
          date: '2026-05-20',
          updatedAt: NOW,
          lastEmailSentAt: NOW - 10 * 86400000,
          clientInfo: { email: 'customer@example.com', firstName: 'Deepika' },
          photoCount: 0,
          customerId: 'customer-deepika',
        },
      }],
      quotes: [{
        id: 'quote-ready',
        data: {
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
          invoiceNumber: '109',
          type: 'quote',
          status: 'ready',
          total: 24000,
          updatedAt: NOW,
          customerId: 'customer-ready',
          clientInfo: { firstName: 'Ready', lastName: 'Quote' },
        },
      }],
      events: [{
        id: 'event-a',
        data: {
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
          status: 'scheduled',
          start: NOW + 60 * 60000,
          end: NOW + 120 * 60000,
          title: 'Water heater install',
          clientName: 'Deepika',
          customerId: 'customer-deepika',
          jobId: 'job-469',
        },
      }],
    });

    const byType = new Map(signals.map((signal) => [signal.type, signal]));
    expectFeedSignalContract(byType.get('trustquote:job-margin'), ['bidAmount', 'historicalMargin', 'bidStatus', 'customerIdentityKey']);
    expectFeedSignalContract(byType.get('trustquote:invoice-aging'), ['invoiceAmount', 'dueMs', 'isPendingJob', 'status']);
    expectFeedSignalContract(byType.get('trustquote:job-proof-stale'), ['jobValue', 'proofRequired', 'proofPresent']);
    expectFeedSignalContract(byType.get('promise:collision'), ['commitments']);
    expect(byType.get('promise:collision').facts.commitments[0]).toEqual(expect.objectContaining({
      confirmed: true,
      startMs: expect.any(Number),
      endMs: expect.any(Number),
      relationshipWeight: expect.any(Number),
      madeInContextRef: 'job:job-469',
    }));
  });

  test('Feed contract blocks parked customer facts before the MIND seam', () => {
    const signals = buildTrustQuoteFactSignalsFromDocs({
      nowMs: NOW,
      source: 'live',
      quotes: [{
        id: 'parked-charles-quote',
        data: {
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
          invoiceNumber: '109',
          status: 'ready',
          total: 24000,
          customerId: DEFAULT_PARKED_TRUSTQUOTE_CUSTOMER_IDS[0],
          clientInfo: { firstName: 'Charles', lastName: 'Long' },
        },
      }],
    });

    expect(signals).toEqual([]);
  });

  test('MIND->BODY emissions all carry disabled dry-run action shape', () => {
    const invoice = evaluate({
      nowMs: NOW,
      source: 'live',
      signals: [liveSignal({
        type: 'trustquote:invoice-aging',
        id: 'jobs:invoice-overdue:invoice-aging',
        facts: {
          invoiceAmount: 36500,
          balanceDue: 36500,
          dueMs: NOW - 20 * 86400000,
          documentType: 'job',
          isProposal: false,
          isPendingJob: true,
          status: 'unpaid',
          paymentReceivedMs: null,
          lastChasedMs: null,
          customerReachable: true,
        },
      })],
    });

    const margin = evaluate({
      nowMs: NOW,
      source: 'live',
      signals: [liveSignal({
        type: 'trustquote:job-margin',
        id: 'quotes:under-margin:job-margin',
        rawRefs: {
          system: 'trustquote',
          collection: 'quotes',
          docId: 'under-margin',
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
        },
        facts: {
          bidAmount: 1000,
          bidPrice: 1000,
          bidCost: 900,
          bidMarginPct: 0.1,
          jobType: 'sewer line',
          historicalMargin: { floorPct: 0.25, sampleCount: 3, jobIds: ['job-a', 'job-b', 'job-c'] },
          bidStatus: 'ready-to-send',
        },
      })],
    });

    const collision = evaluate({
      nowMs: NOW,
      source: 'live',
      signals: [liveSignal({
        type: 'promise:collision',
        id: 'calendar-events:schedule-overlap:promise-collision',
        context: 'promise:collision:schedule',
        rawRefs: {
          system: 'trustquote',
          collection: 'calendar-events',
          docId: 'schedule-overlap',
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
        },
        facts: {
          commitments: [{
            who: 'Deepika',
            what: 'Water leak',
            startMs: NOW + 90 * 60000,
            endMs: NOW + 150 * 60000,
            confirmed: true,
            relationshipWeight: 0.8,
            customerId: 'customer-a',
            madeInContextRef: 'job:a',
          }, {
            who: 'Mira',
            what: 'Install',
            startMs: NOW + 100 * 60000,
            endMs: NOW + 160 * 60000,
            confirmed: true,
            relationshipWeight: 0.8,
            customerId: 'customer-b',
            madeInContextRef: 'job:b',
          }],
        },
      })],
    });

    expectDryRunBodyEmission(invoice);
    expectDryRunBodyEmission(margin);
    expectDryRunBodyEmission(collision);
  });
});
