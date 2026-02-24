function toNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function getRuntimeInjectionCapabilityDefaults(options = {}) {
  const isDarwin = Boolean(options.isDarwin);
  const codexEnterDelayMs = toNonNegativeNumber(options.codexEnterDelayMs, 200);
  const geminiEnterDelayMs = toNonNegativeNumber(options.geminiEnterDelayMs, 75);
  const claudeEnterDelayMs = toNonNegativeNumber(options.claudeEnterDelayMs, 50);
  const codexVerifySubmitAccepted = typeof options.codexVerifySubmitAccepted === 'boolean'
    ? options.codexVerifySubmitAccepted
    : false;

  return {
    codex: {
      mode: 'pty',
      modeLabel: 'codex-pty',
      appliedMethod: 'codex-pty',
      submitMethod: 'codex-pty-enter',
      bypassGlobalLock: false,
      applyCompactionGate: true,
      requiresFocusForEnter: false,
      enterMethod: 'pty',
      enterDelayMs: codexEnterDelayMs,
      sanitizeMultiline: true,
      clearLineBeforeWrite: true,
      useChunkedWrite: false,
      homeResetBeforeWrite: false,
      verifySubmitAccepted: codexVerifySubmitAccepted,
      deferSubmitWhilePaneActive: false,
      scaleEnterDelayByPayload: true,
      typingGuardWhenBypassing: false,
      sanitizeTransform: 'none',
      enterFailureReason: 'pty_enter_failed',
      displayName: 'Codex',
    },
    gemini: {
      mode: 'pty',
      modeLabel: 'gemini-pty',
      appliedMethod: 'gemini-pty',
      submitMethod: 'gemini-pty-enter',
      bypassGlobalLock: true,
      applyCompactionGate: false,
      requiresFocusForEnter: false,
      enterMethod: 'pty',
      enterDelayMs: geminiEnterDelayMs,
      sanitizeMultiline: true,
      clearLineBeforeWrite: true,
      useChunkedWrite: false,
      homeResetBeforeWrite: false,
      verifySubmitAccepted: false,
      deferSubmitWhilePaneActive: false,
      scaleEnterDelayByPayload: false,
      typingGuardWhenBypassing: true,
      sanitizeTransform: 'gemini-sanitize',
      enterFailureReason: 'pty_enter_failed',
      displayName: 'Gemini',
    },
    claude: {
      mode: 'pty',
      modeLabel: 'claude-pty',
      appliedMethod: 'claude-pty',
      submitMethod: 'sendTrustedEnter',
      bypassGlobalLock: false,
      applyCompactionGate: true,
      requiresFocusForEnter: !isDarwin,
      enterMethod: isDarwin ? 'pty' : 'trusted',
      enterDelayMs: claudeEnterDelayMs,
      sanitizeMultiline: false,
      clearLineBeforeWrite: true,
      useChunkedWrite: true,
      homeResetBeforeWrite: true,
      verifySubmitAccepted: !isDarwin,
      deferSubmitWhilePaneActive: !isDarwin,
      scaleEnterDelayByPayload: true,
      typingGuardWhenBypassing: false,
      sanitizeTransform: 'none',
      enterFailureReason: 'enter_failed',
      displayName: 'Claude',
    },
    unknown: {
      mode: 'pty',
      modeLabel: 'generic-pty',
      appliedMethod: 'generic-pty',
      submitMethod: 'pty-enter',
      bypassGlobalLock: true,
      applyCompactionGate: false,
      requiresFocusForEnter: false,
      enterMethod: 'pty',
      enterDelayMs: claudeEnterDelayMs,
      sanitizeMultiline: false,
      clearLineBeforeWrite: true,
      useChunkedWrite: true,
      homeResetBeforeWrite: true,
      verifySubmitAccepted: true,
      deferSubmitWhilePaneActive: true,
      scaleEnterDelayByPayload: false,
      typingGuardWhenBypassing: true,
      sanitizeTransform: 'sanitize-multiline',
      enterFailureReason: 'enter_failed',
      displayName: 'Generic',
    },
  };
}

function getRuntimeInjectionCapabilityDefault(runtimeKey, options = {}) {
  const defaults = getRuntimeInjectionCapabilityDefaults(options);
  const key = String(runtimeKey || '').toLowerCase();
  return { ...(defaults[key] || defaults.unknown) };
}

function resolveInjectionRuntimeKey(paneId, helpers = {}) {
  const id = String(paneId || '');
  const fallback = String(helpers.fallback || 'claude');
  const isCodex = typeof helpers.isCodexPane === 'function' ? helpers.isCodexPane(id) : false;
  if (isCodex) return 'codex';
  const isGemini = typeof helpers.isGeminiPane === 'function' ? helpers.isGeminiPane(id) : false;
  if (isGemini) return 'gemini';
  return fallback;
}

module.exports = {
  getRuntimeInjectionCapabilityDefaults,
  getRuntimeInjectionCapabilityDefault,
  resolveInjectionRuntimeKey,
};
