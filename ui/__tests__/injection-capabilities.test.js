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

  test('classifies ExampleApp arm panes as PTY-enter runtimes in the fallback resolver', () => {
    expect(resolveInjectionRuntimeKey('exampleapp-lead', {
      isCodexPane: () => false,
      isGeminiPane: () => false,
      fallback: 'claude',
    })).toBe('exampleapp');

    const caps = getRuntimeInjectionCapabilityDefault('exampleapp', { isDarwin: false });
    expect(caps.submitMethod).toBe('exampleapp-pty-enter');
    expect(caps.enterMethod).toBe('pty');
    expect(caps.requiresFocusForEnter).toBe(false);
  });
});
