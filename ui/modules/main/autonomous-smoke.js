const BUILDER_ROLE_PATTERN = /^builder(?:-bg-[a-z0-9-]+)?$/i;
const SMOKE_TAG_PATTERN = /\[SMOKE\]/i;
const VISUAL_TAG_PATTERN = /\[VISUAL\]/i;
const READY_FOR_REVIEW_PATTERN = /\bready\s+for\s+review\b/i;
const COMPLETED_PATTERN = /\bcompleted?\b/i;
const DONE_PATTERN = /\bdone\b/i;

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function toToken(value) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.replace(/\s+/g, '_');
}

function isAllowedSenderRole(senderRole) {
  return BUILDER_ROLE_PATTERN.test(normalizeText(senderRole));
}

function shouldTriggerAutonomousSmoke({ senderRole, messageContent } = {}) {
  if (!isAllowedSenderRole(senderRole)) {
    return { trigger: false, reason: 'sender_not_allowed' };
  }

  const message = normalizeText(messageContent);
  if (!message) {
    return { trigger: false, reason: 'empty_message' };
  }

  if (SMOKE_TAG_PATTERN.test(message)) {
    return { trigger: true, reason: 'smoke_tag' };
  }

  if (VISUAL_TAG_PATTERN.test(message)) {
    return { trigger: true, reason: 'visual_tag' };
  }

  if (READY_FOR_REVIEW_PATTERN.test(message)) {
    return { trigger: true, reason: 'builder_ready_for_review' };
  }

  if (COMPLETED_PATTERN.test(message)) {
    return { trigger: true, reason: 'builder_completed' };
  }

  if (DONE_PATTERN.test(message)) {
    return { trigger: true, reason: 'builder_done' };
  }

  return { trigger: false, reason: null };
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function pushOption(args, flag, value) {
  if (value === undefined || value === null) return;
  const text = String(value).trim();
  if (!text) return;
  args.push(flag, text);
}

function pushIntegerOption(args, flag, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  if (value < 0) return;
  args.push(flag, String(Math.trunc(value)));
}

function buildSmokeRunnerArgs(options = {}) {
  const opts = asObject(options);
  const args = [];

  pushOption(args, '--sender-role', opts.senderRole);
  pushOption(args, '--trigger-reason', opts.triggerReason);
  pushOption(args, '--message', opts.messageContent);
  pushOption(args, '--run-id', opts.runId);
  pushOption(args, '--session-id', opts.sessionId);
  pushOption(args, '--project-path', opts.projectPath);
  pushOption(args, '--target-url', opts.targetUrl);

  pushIntegerOption(args, '--timeout-ms', opts.timeoutMs);
  pushIntegerOption(args, '--max-failures', opts.maxFailures);

  if (opts.visual === true) args.push('--visual');
  if (opts.visual === false) args.push('--no-visual');
  if (opts.headless === true) args.push('--headless');
  if (opts.headless === false) args.push('--headed');
  if (opts.dryRun === true) args.push('--dry-run');

  if (Array.isArray(opts.tags)) {
    for (const tag of opts.tags) {
      const token = toToken(tag);
      if (token) args.push('--tag', token);
    }
  }

  if (Array.isArray(opts.extraArgs)) {
    for (const arg of opts.extraArgs) {
      if (typeof arg !== 'string') continue;
      const token = arg.trim();
      if (token) args.push(token);
    }
  }

  return args;
}

function toCount(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return null;
}

function resolveCount(result, keys) {
  for (const key of keys) {
    const direct = toCount(result[key]);
    if (direct !== null) return direct;

    const stats = asObject(result.stats);
    const nested = toCount(stats[key]);
    if (nested !== null) return nested;
  }
  return 0;
}

function formatSmokeResultMessage(result = {}, context = {}) {
  const safeResult = asObject(result);
  const safeContext = asObject(context);

  const passed = resolveCount(safeResult, ['passed', 'passCount', 'passes']);
  const failed = resolveCount(safeResult, ['failed', 'failCount', 'failures']);
  const skipped = resolveCount(safeResult, ['skipped', 'skipCount', 'skips']);

  let total = resolveCount(safeResult, ['total', 'totalCount', 'testsTotal']);
  if (total === 0 && (passed > 0 || failed > 0 || skipped > 0)) {
    total = passed + failed + skipped;
  }

  const explicitSuccess = typeof safeResult.success === 'boolean' ? safeResult.success : null;
  const status = explicitSuccess !== null
    ? (explicitSuccess ? 'PASS' : 'FAIL')
    : (failed > 0 ? 'FAIL' : 'PASS');

  const roleToken = toToken(safeContext.senderRole || safeContext.role || '');
  const reasonToken = toToken(safeContext.reason || safeContext.triggerReason || '');
  const runToken = toToken(safeContext.runId || safeResult.runId || '');

  const parts = [
    '[AUTONOMOUS_SMOKE]',
    status,
    `pass=${passed}`,
    `fail=${failed}`,
    `skip=${skipped}`,
    `total=${total}`,
  ];

  if (roleToken) parts.push(`role=${roleToken}`);
  if (reasonToken) parts.push(`reason=${reasonToken}`);
  if (runToken) parts.push(`run=${runToken}`);

  return parts.join(' ');
}

module.exports = {
  shouldTriggerAutonomousSmoke,
  buildSmokeRunnerArgs,
  formatSmokeResultMessage,
};
