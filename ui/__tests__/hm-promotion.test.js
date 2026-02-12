const hmPromotion = require('../scripts/hm-promotion');

describe('hm-promotion CLI helpers', () => {
  test('normalizeCommand handles aliases', () => {
    expect(hmPromotion.normalizeCommand('list-promotions')).toBe('list');
    expect(hmPromotion.normalizeCommand('signoff')).toBe('approve');
    expect(hmPromotion.normalizeCommand('false-positive')).toBe('reject');
  });

  test('toAction maps supported commands', () => {
    expect(hmPromotion.toAction('list')).toBe('list');
    expect(hmPromotion.toAction('approve')).toBe('approve');
    expect(hmPromotion.toAction('reject')).toBe('reject');
  });

  test('buildPayload creates list payload options', () => {
    const options = new Map([
      ['include-enforced', true],
      ['include-unknown', true],
    ]);

    expect(hmPromotion.buildPayload('list', options)).toEqual({
      includeEnforced: true,
      includeUnknown: true,
    });
  });

  test('buildPayload creates approve payload', () => {
    const options = new Map([
      ['contract', 'overlay-fit-exclusion-shadow'],
      ['agent', 'devops'],
    ]);

    expect(hmPromotion.buildPayload('approve', options)).toEqual({
      contractId: 'overlay-fit-exclusion-shadow',
      agent: 'devops',
    });
  });

  test('buildPayload creates reject payload with reason', () => {
    const options = new Map([
      ['contract', 'overlay-fit-exclusion-shadow'],
      ['reason', 'false positive'],
    ]);

    expect(hmPromotion.buildPayload('reject', options)).toEqual({
      contractId: 'overlay-fit-exclusion-shadow',
      reason: 'false positive',
    });
  });
});
