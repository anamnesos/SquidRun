/**
 * v7 §3 Phase L — the activation mode resolver.
 *
 * There is exactly one recognised value, so almost every test here is about a
 * value that is NOT it. That asymmetry is the point: the failure this module
 * prevents is not "we picked the wrong mode", it is "nobody said, and something
 * decided on their behalf".
 */
const activationModeModule = require('../modules/main/telegram-activation-mode');

const {
  LEGACY_SETTLEMENT,
  ACTIVATION_MODE_VALUES,
  isRecognizedActivationMode,
  resolveActivationMode,
} = activationModeModule;

describe('the one recognised value', () => {
  test('legacy_settlement resolves, and it is the only one', () => {
    expect(LEGACY_SETTLEMENT).toBe('legacy_settlement');
    expect(ACTIVATION_MODE_VALUES).toEqual(['legacy_settlement']);
    expect(resolveActivationMode('legacy_settlement')).toEqual({
      ok: true, mode: 'legacy_settlement', reason: null,
    });
    expect(isRecognizedActivationMode('legacy_settlement')).toBe(true);
  });
});

describe('absent is not a default', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
  ])('%s is activation_mode_missing, never a mode', (_label, value) => {
    // `configured || 'legacy_settlement'` would turn both of these into a
    // confident claim that this install is settling legacy — and Step 3 derives
    // a stable fence whose validity rests on that settlement having actually
    // happened, once, under a known writer.
    const result = resolveActivationMode(value);
    expect(result).toEqual({ ok: false, mode: null, reason: 'activation_mode_missing' });
    expect(isRecognizedActivationMode(value)).toBe(false);
  });

  test.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a tab', '\t'],
  ])('%s is activation_mode_empty, distinct from missing', (_label, value) => {
    // Named apart from missing on purpose: "nobody has set this" and "something
    // wrote a blank here" send an operator to different files.
    expect(resolveActivationMode(value)).toEqual({
      ok: false, mode: null, reason: 'activation_mode_empty',
    });
  });

  test.each([
    ['a number', 7, 'number'],
    ['zero', 0, 'number'],
    ['boolean true', true, 'boolean'],
    ['boolean false', false, 'boolean'],
    ['an object', { mode: 'legacy_settlement' }, 'object'],
    ['an array', ['legacy_settlement'], 'array'],
  ])('%s is activation_mode_not_a_string and names the type', (_label, value, type) => {
    // `true` and `0` are the dangerous ones: a truthiness guard would read the
    // first as configured and the second as unset.
    expect(resolveActivationMode(value)).toEqual({
      ok: false, mode: null, reason: 'activation_mode_not_a_string', detail: { type },
    });
    expect(isRecognizedActivationMode(value)).toBe(false);
  });
});

describe('nothing is normalised into validity', () => {
  test.each([
    ['leading space', ' legacy_settlement'],
    ['trailing space', 'legacy_settlement '],
    ['both', '  legacy_settlement  '],
    ['newline', 'legacy_settlement\n'],
    ['wrong case', 'LEGACY_SETTLEMENT'],
    ['hyphenated', 'legacy-settlement'],
    ['a future mode', 'decision_scheduling'],
    ['plausible nonsense', 'legacy_settlement_v2'],
  ])('%s is unknown, not repaired into the real value', (_label, value) => {
    // A trimmed or case-folded match would accept a value something wrote
    // WRONG, and the next reader could no longer tell a hand-edit from a
    // producer bug. The mode is a protocol state, not user input.
    const result = resolveActivationMode(value);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('activation_mode_unknown');
    expect(result.detail).toEqual({ value });
    expect(isRecognizedActivationMode(value)).toBe(false);
  });
});

describe('the authority cannot be widened by a consumer', () => {
  test('the value list refuses mutation and the exports object is frozen', () => {
    // Same attack surface as telegram-legacy-journal, same answer: a frozen Set
    // is still `.add()`-able, so the recognised values live behind a frozen
    // array and a predicate, and the exports object itself is frozen so require
    // order is not a security assumption (Architect #121/#127).
    expect(Object.isFrozen(activationModeModule)).toBe(true);
    expect(() => ACTIVATION_MODE_VALUES.push('decision_scheduling')).toThrow();
    expect(ACTIVATION_MODE_VALUES).toEqual(['legacy_settlement']);
  });

  test('replacing the exported resolver does not stick', () => {
    const original = activationModeModule.resolveActivationMode;
    try { activationModeModule.resolveActivationMode = () => ({ ok: true, mode: 'anything' }); } catch { /* strict */ }
    expect(activationModeModule.resolveActivationMode).toBe(original);
    expect(activationModeModule.resolveActivationMode('anything').ok).toBe(false);
  });

  test('the resolver is total and never throws', () => {
    const hostile = [
      Symbol('legacy_settlement'), () => 'legacy_settlement', new Date(0), NaN, Infinity,
      Object.create(null), new String('legacy_settlement'), // eslint-disable-line no-new-wrappers
    ];
    for (const value of hostile) {
      const result = resolveActivationMode(value);
      expect(result.ok).toBe(false);
      expect(typeof result.reason).toBe('string');
    }
  });

  test('a String OBJECT is not a string', () => {
    // `new String('legacy_settlement') == 'legacy_settlement'` is true and
    // `Set.has` on it is false, so a looser comparison would have accepted a
    // boxed value that then fails every downstream identity check.
    // eslint-disable-next-line no-new-wrappers
    expect(resolveActivationMode(new String('legacy_settlement')).reason).toBe('activation_mode_not_a_string');
  });
});
