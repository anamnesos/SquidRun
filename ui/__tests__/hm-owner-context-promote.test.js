const {
  inferScope,
  normalizeSourceType,
  validateCandidateForApply,
} = require('../scripts/hm-owner-context-promote');

function baseCandidate(overrides = {}) {
  return {
    status: 'candidate',
    sourceReceipt: 'life-back-on-track-2026-04-28.md',
    candidate: 'Address must remain visible on TrustQuote operating dashboards.',
    promotionReason: 'Operational safety.',
    expectedBehaviorChange: 'Future dashboards preserve address actions.',
    tags: ['dashboard'],
    ...overrides,
  };
}

describe('hm-owner-context-promote gates', () => {
  test('blocks agent-derived customer tone without James sign-off', () => {
    const candidate = baseCandidate({
      sourceType: 'agent',
      candidate: 'Lynette Butsuda should be treated as a steady high-value customer; use warm close-out tone.',
      promotionReason: 'Agent inferred relationship risk from receivables review.',
      tags: ['customer-tone', 'receivables', 'lynette'],
    });

    expect(inferScope(candidate)).toEqual({
      scopeType: 'customer',
      customerName: 'Lynette Butsuda',
    });
    expect(() => validateCandidateForApply(candidate)).toThrow(
      /Agent-derived customer tone\/judgment requires James\/customer sign-off/
    );
  });

  test('allows James-sourced customer tone instructions', () => {
    const candidate = baseCandidate({
      sourceType: 'james',
      candidate: 'James said to use warm close-out tone for Lynette Butsuda.',
      promotionReason: 'James explicitly instructed this customer communication style.',
      expectedBehaviorChange: 'Future Lynette close-out drafts should follow James-authored tone.',
      tags: ['customer-tone', 'receivables', 'lynette', 'james-sourced'],
    });

    expect(() => validateCandidateForApply(candidate)).not.toThrow();
  });

  test('allows customer-sourced customer preferences', () => {
    const candidate = baseCandidate({
      sourceType: 'customer',
      candidate: 'Customer said she prefers text updates before phone calls.',
      promotionReason: 'Customer-sourced communication preference from job conversation.',
      expectedBehaviorChange: 'Future customer contact should try text before calling.',
      tags: ['lynette', 'customer-sourced', 'communication'],
    });

    expect(() => validateCandidateForApply(candidate)).not.toThrow();
  });

  test('allows factual customer records without James-authored tone', () => {
    const candidate = baseCandidate({
      sourceType: 'factual',
      candidate: 'Lynette Butsuda invoice #469 balanceDue is 2509.',
      promotionReason: 'Factual payment record from TrustQuote invoice data.',
      expectedBehaviorChange: 'Future receivables status should use corrected balance.',
      tags: ['lynette', 'fact-record', 'payment-record'],
    });

    expect(() => validateCandidateForApply(candidate)).not.toThrow();
  });

  test('requires structured sourceType for customer and owner scope', () => {
    const candidate = baseCandidate({
      sourceReceipt: 'raw-conversation-2026-04-29.md',
      candidate: 'James prefers concise updates.',
      promotionReason: 'Agent inferred from recent interaction pattern.',
      expectedBehaviorChange: 'Future replies should be concise.',
      tags: ['james', 'communication'],
    });

    expect(() => validateCandidateForApply(candidate)).toThrow(
      /Customer\/owner-scope promotion requires structured sourceType/
    );
  });

  test('does not treat raw-conversation sourceReceipt alone as James-sourced', () => {
    const candidate = baseCandidate({
      sourceType: 'agent',
      sourceReceipt: 'raw-conversation-2026-04-29.md',
      candidate: 'James prefers concise updates.',
      promotionReason: 'Agent inferred from recent interaction pattern.',
      expectedBehaviorChange: 'Future replies should be concise.',
      tags: ['james', 'communication'],
    });

    expect(() => validateCandidateForApply(candidate)).toThrow(
      /Owner-scope promotion requires direct James source/
    );
  });

  test('allows owner-scope rules only when James-sourced', () => {
    const candidate = baseCandidate({
      sourceType: 'james',
      sourceReceipt: 'raw-conversation-2026-04-29.md',
      candidate: 'When James is painting product feel, do not correct every detail too quickly.',
      promotionReason: 'James explicitly called out this behavior as not-partner-like.',
      expectedBehaviorChange: 'Future agent replies preserve felt vision first.',
      tags: ['james', 'taste', 'communication'],
    });

    expect(inferScope(candidate)).toEqual({ scopeType: 'owner' });
    expect(() => validateCandidateForApply(candidate)).not.toThrow();
  });

  test('blocks owner-scope rules without direct James source', () => {
    const candidate = baseCandidate({
      sourceType: 'agent',
      sourceReceipt: 'agent-analysis.md',
      candidate: 'James prefers concise updates.',
      promotionReason: 'Agent inferred from recent interaction pattern.',
      expectedBehaviorChange: 'Future replies should be concise.',
      tags: ['james', 'communication'],
    });

    expect(() => validateCandidateForApply(candidate)).toThrow(
      /Owner-scope promotion requires direct James source/
    );
  });

  test('rejects invalid structured sourceType', () => {
    const candidate = baseCandidate({
      sourceType: 'vibes',
      candidate: 'Lynette Butsuda prefers warm tone.',
      promotionReason: 'Invalid source type should not silently become heuristic source.',
      tags: ['lynette', 'customer-tone'],
    });

    expect(normalizeSourceType(candidate)).toBe('invalid');
    expect(() => validateCandidateForApply(candidate)).toThrow(
      /Candidate sourceType must be one of/
    );
  });
});
