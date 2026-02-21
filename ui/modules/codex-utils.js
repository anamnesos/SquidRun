function hasCodexDangerouslyBypassFlag(command) {
  return /(?:^|\s)--dangerously-bypass(?:\s|=|$)/i.test(String(command || ''));
}

function hasCodexAskForApprovalFlag(command) {
  const value = String(command || '');
  return /(?:^|\s)--ask-for-approval(?:\s|=|$)/i.test(value) || /(?:^|\s)-a(?:\s|=|$)/.test(value);
}

module.exports = {
  hasCodexDangerouslyBypassFlag,
  hasCodexAskForApprovalFlag,
};
