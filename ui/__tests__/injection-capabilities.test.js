const {
  getRuntimeInjectionCapabilityDefault,
  resolveInjectionRuntimeKey,
} = require('../modules/terminal/injection-capabilities');

describe('terminal injection capabilities', () => {
  test('uses raw PTY Enter for Windows Codex panes', () => {
    const caps = getRuntimeInjectionCapabilityDefault('codex', { isDarwin: false });

    expect(caps.modeLabel).toBe('codex-pty');
    expect(caps.submitMethod).toBe('codex-pty-enter');
    expect(caps.enterMethod).toBe('pty');
    expect(caps.requiresFocusForEnter).toBe(false);
    expect(caps.enterFailureReason).toBe('pty_enter_failed');
  });

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
