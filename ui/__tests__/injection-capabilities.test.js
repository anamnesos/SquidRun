const {
  getRuntimeInjectionCapabilityDefault,
  resolveInjectionRuntimeKey,
} = require('../modules/terminal/injection-capabilities');

describe('terminal injection capabilities', () => {
  test('classifies TrustQuote arm panes as PTY-enter runtimes in the fallback resolver', () => {
    expect(resolveInjectionRuntimeKey('trustquote-lead', {
      isCodexPane: () => false,
      isGeminiPane: () => false,
      fallback: 'claude',
    })).toBe('trustquote');

    const caps = getRuntimeInjectionCapabilityDefault('trustquote', { isDarwin: false });
    expect(caps.submitMethod).toBe('trustquote-pty-enter');
    expect(caps.enterMethod).toBe('pty');
    expect(caps.requiresFocusForEnter).toBe(false);
  });
});
