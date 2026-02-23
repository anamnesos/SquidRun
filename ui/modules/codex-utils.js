function hasCodexDangerouslyBypassFlag(command) {
  const cmd = String(command || '');
  return cmd.includes('--dangerously-bypass-approvals-and-sandbox') || cmd.includes('-s danger-full-access');
}

function hasCodexAskForApprovalFlag(command) {
  const value = String(command || '');
  return /(?:^|\s)--ask-for-approval(?:\s|=|$)/i.test(value) || /(?:^|\s)-a(?:\s|=|$)/.test(value);
}

module.exports = {
  hasCodexDangerouslyBypassFlag,
  hasCodexAskForApprovalFlag,
};
