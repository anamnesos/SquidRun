const hmTransition = require('../scripts/hm-transition');

describe('hm-transition CLI helpers', () => {
  test('normalizeCommand handles aliases', () => {
    expect(hmTransition.normalizeCommand('list-transitions')).toBe('list');
    expect(hmTransition.normalizeCommand('get-by-id')).toBe('get');
    expect(hmTransition.normalizeCommand('get-by-correlation')).toBe('get');
    expect(hmTransition.normalizeCommand('get-stats')).toBe('stats');
  });

  test('toAction maps commands and get payload variants', () => {
    expect(hmTransition.toAction('list')).toBe('list');
    expect(hmTransition.toAction('stats')).toBe('getStats');
    expect(hmTransition.toAction('get', { transitionId: 'tr-1' })).toBe('getById');
    expect(hmTransition.toAction('get', { correlationId: 'corr-1' })).toBe('getByCorrelation');
  });

  test('buildPayload creates list payload with filters', () => {
    const options = new Map([
      ['include-closed', 'false'],
      ['pane', '2'],
      ['phase', 'verifying'],
      ['intent', 'inject.requested'],
      ['reason', 'timeout_without_evidence'],
      ['limit', '10'],
      ['since', '1000'],
      ['until', '2000'],
    ]);

    expect(hmTransition.buildPayload('list', options)).toEqual({
      includeClosed: false,
      paneId: '2',
      phase: 'verifying',
      intentType: 'inject.requested',
      reasonCode: 'timeout_without_evidence',
      limit: 10,
      since: 1000,
      until: 2000,
    });
  });

  test('buildPayload creates get payload for transition id', () => {
    const options = new Map([
      ['id', 'tr-123'],
    ]);

    expect(hmTransition.buildPayload('get', options)).toEqual({
      transitionId: 'tr-123',
    });
  });

  test('buildPayload creates get payload for correlation query', () => {
    const options = new Map([
      ['correlation', 'corr-abc'],
      ['pane', '5'],
      ['include-closed', 'false'],
    ]);

    expect(hmTransition.buildPayload('get', options)).toEqual({
      correlationId: 'corr-abc',
      paneId: '5',
      includeClosed: false,
    });
  });

  test('buildPayload get throws when id/correlation is missing', () => {
    expect(() => hmTransition.buildPayload('get', new Map())).toThrow(
      'get command requires --id <transitionId> or --correlation <correlationId>'
    );
  });
});
