const AGENT_ROLE_ALIASES = new Map([
  ['arch', 'architect'],
  ['architect', 'architect'],
  ['builder', 'builder'],
  ['oracle', 'oracle'],
]);

const AGENT_REF_PATTERN = /\b(ARCHITECT|ARCH|BUILDER|ORACLE)\s+#(\d+)\b/gi;

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function normalizeAgentRole(value) {
  const normalized = toOptionalString(value, '')?.toLowerCase();
  return AGENT_ROLE_ALIASES.get(normalized) || null;
}

function normalizeAgentRef(ref) {
  const role = normalizeAgentRole(ref?.role);
  const seq = Number.parseInt(ref?.seq, 10);
  if (!role || !Number.isInteger(seq) || seq <= 0) return null;
  return { role, seq };
}

function sameAgentRef(left, right) {
  const normalizedLeft = normalizeAgentRef(left);
  const normalizedRight = normalizeAgentRef(right);
  return Boolean(
    normalizedLeft
    && normalizedRight
    && normalizedLeft.role === normalizedRight.role
    && normalizedLeft.seq === normalizedRight.seq
  );
}

function parseLeadingAgentRef(rawBody) {
  const text = toOptionalString(rawBody, '');
  if (!text) return null;
  const match = text.match(/^\s*\((ARCHITECT|ARCH|BUILDER|ORACLE)\s+#(\d+)\)\s*:/i);
  return normalizeAgentRef(match ? { role: match[1], seq: match[2] } : null);
}

function extractAgentRefs(rawBody) {
  const text = toOptionalString(rawBody, '');
  if (!text) return [];
  const refs = [];
  for (const match of text.matchAll(AGENT_REF_PATTERN)) {
    const ref = normalizeAgentRef({ role: match[1], seq: match[2] });
    if (!ref) continue;
    if (refs.some((existing) => sameAgentRef(existing, ref))) continue;
    refs.push(ref);
  }
  return refs;
}

function bodyReferencesAgentRef(rawBody, ref) {
  const normalizedRef = normalizeAgentRef(ref);
  if (!normalizedRef) return false;
  return extractAgentRefs(rawBody).some((candidate) => sameAgentRef(candidate, normalizedRef));
}

function hasClosureSignal(rawBody, options = {}) {
  const text = toOptionalString(rawBody, '');
  if (!text) return false;
  const includeReceipt = options.includeReceipt !== false;
  return (
    (includeReceipt && /\back(?:nowledged|ed)?\b/i.test(text))
    || (includeReceipt && /\breceived\b/i.test(text))
    || (includeReceipt && /\bquote[- ]?back\b/i.test(text))
    || /\bcomplete(?:d)?\b/i.test(text)
    || /\bdone\b/i.test(text)
    || /\bcleanup(?:\/revert)?(?:\s+complete)?\b/i.test(text)
    || /\brevert(?:ed)?\b/i.test(text)
    || /\bcancel(?:led|ed|ing)?\b/i.test(text)
    || /\bsupersed(?:e|ed|ing)\b/i.test(text)
    || /\bstop(?:ped|ping)?\b/i.test(text)
  );
}

function hasSameSenderClosureSignal(rawBody) {
  const text = toOptionalString(rawBody, '');
  if (!text) return false;
  return (
    /\b(?:builder|oracle)\s+(?:completion|delivery)\s+received\b/i.test(text)
    || /\b(?:builder|oracle)\s+final\s+verdict\s+accepted\b/i.test(text)
    || /\bcancel(?:led|ed|ing)?\b/i.test(text)
    || /\bsupersed(?:e|ed|ing)\b/i.test(text)
    || /\bstop(?:ped|ping)?\b/i.test(text)
  );
}

function roleRefPattern(ref) {
  const normalized = normalizeAgentRef(ref);
  if (!normalized) return null;
  const rolePattern = normalized.role === 'architect'
    ? '(?:ARCHITECT|ARCH)'
    : normalized.role.toUpperCase();
  return `${rolePattern}\\s+#${normalized.seq}`;
}

function hasDirectQuoteBackClosureSignal(rawBody, taskRef, options = {}) {
  const text = toOptionalString(rawBody, '');
  const refPattern = roleRefPattern(taskRef);
  if (!text || !refPattern) return false;
  const includeReceipt = options.includeReceipt !== false;
  const ackedRef = new RegExp(`\\bACK(?:NOWLEDGED|ED)?\\s+${refPattern}\\b`, 'i').test(text);
  return (
    (includeReceipt && ackedRef)
    ||
    new RegExp(`\\b${refPattern}\\s+(?:complete|completed|done)\\b`, 'i').test(text)
    || new RegExp(`\\b(?:complete|completed|done)\\s+${refPattern}\\b`, 'i').test(text)
    || (ackedRef && /\b(?:cleanup(?:\/revert)?\s+complete|patch\s+reverted|validation\s+passed)\b/i.test(text))
  );
}

function isLaterAgentClosureRow(taskRow = {}, candidateRow = {}, options = {}) {
  const taskRef = parseLeadingAgentRef(taskRow?.rawBody || '');
  if (!taskRef) return false;

  const body = toOptionalString(candidateRow?.rawBody, '');
  if (!body || !hasClosureSignal(body, options)) return false;
  if (!bodyReferencesAgentRef(body, taskRef)) return false;

  const taskSender = normalizeAgentRole(taskRow?.senderRole);
  const taskTarget = normalizeAgentRole(taskRow?.targetRole);
  const candidateSender = normalizeAgentRole(candidateRow?.senderRole);
  const candidateTarget = normalizeAgentRole(candidateRow?.targetRole);
  if (!taskSender || !taskTarget || !candidateSender) return false;

  const directQuoteBack = candidateSender === taskTarget
    && (!candidateTarget || candidateTarget === taskSender);
  const sameSenderSupersession = candidateSender === taskSender
    && (!candidateTarget || candidateTarget === taskTarget);

  if (directQuoteBack) return hasDirectQuoteBackClosureSignal(body, taskRef, options);
  if (sameSenderSupersession) return hasSameSenderClosureSignal(body);
  return false;
}

function toEventTsMs(row) {
  const candidates = [
    row?.brokeredAtMs,
    row?.sentAtMs,
    row?.updatedAtMs,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.floor(numeric);
    }
  }
  return 0;
}

function isAgentTaskResolvedByLaterSignal(taskRow = {}, rows = [], startIndex = -1, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return false;

  const taskTs = toEventTsMs(taskRow);
  const begin = Number.isInteger(startIndex) && startIndex >= 0 ? startIndex + 1 : 0;
  for (let index = begin; index < rows.length; index += 1) {
    const candidate = rows[index];
    if (!candidate || candidate === taskRow) continue;
    if (Number.isFinite(taskTs) && taskTs > 0 && toEventTsMs(candidate) < taskTs) continue;
    if (isLaterAgentClosureRow(taskRow, candidate, options)) return true;
  }
  return false;
}

function stripAgentPrefix(line = '') {
  return String(line || '')
    .replace(/^\s*\[[^\]]+\]\s*/g, '')
    .replace(/^\s*\((?:ARCHITECT|ARCH|BUILDER|ORACLE)\s+#\d+\)\s*:?\s*/i, '')
    .trim();
}

function normalizeLaneObjective(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstStrippedLine(rawBody) {
  const lines = String(rawBody || '').split(/\r?\n/);
  for (const line of lines) {
    const stripped = stripAgentPrefix(line);
    if (stripped) return stripped;
  }
  return '';
}

function isReportSectionHeading(line) {
  const stripped = String(line || '').trim();
  if (!stripped) return false;
  return /^(?:findings?|fix(?:es|ed)?|validation|changed\s+files?|residual\s+risk|risk|root\s+cause|review\s+finding|tests?|verification|summary)\b(?:\s*:|\s+-|$)/i.test(stripped);
}

function isReportLikeDirectiveBody(rawBody) {
  return isReportSectionHeading(firstStrippedLine(rawBody));
}

function redactQuotedDirectiveText(value) {
  return String(value || '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/'[^']*'/g, ' ');
}

function firstObjectiveSentence(value) {
  const normalized = normalizeLaneObjective(value);
  if (!normalized) return '';
  const match = normalized.match(/^(.+?[.!?])(?:\s+|$)/);
  return match ? match[1].trim() : normalized;
}

function selectHigherPriorityDirective(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  if (candidate.priority !== current.priority) {
    return candidate.priority > current.priority ? candidate : current;
  }
  return candidate;
}

function hasLiveRiskEvidence(rawBody) {
  const body = toOptionalString(rawBody, '').toLowerCase();
  if (!body) return false;
  return (
    /\blive[-\s]risk\s*:\s*(?!none\b|no\b)/i.test(body)
    || /\bactive\s+live\s+financial\s+risk\b/i.test(body)
    || /\birreversible\s+(?:data\s+)?(?:state|change|operation)\b/i.test(body)
    || /\bactive\s+(?:trade|trading|position|order|customer\s+send|production\s+deploy)\b/i.test(body)
  );
}

function withLiveRiskPriority(directive, rawBody) {
  if (!directive) return null;
  if (!hasLiveRiskEvidence(rawBody)) return directive;
  return {
    ...directive,
    priority: Math.max(directive.priority, 130),
  };
}

function extractNaturalCurrentLaneDirective(rawBody) {
  if (isReportLikeDirectiveBody(rawBody)) return null;
  const stripped = stripAgentPrefix(normalizeLaneObjective(redactQuotedDirectiveText(rawBody)));
  if (!stripped) return null;
  if (/^(?:ack|findings?|validation|review\s+finding|root\s+cause)\b/i.test(stripped)) {
    return null;
  }

  let match = stripped.match(/^(?:new\s+)?user[-\s]facing\s+priority\s*:\s*(.+)$/i)
    || stripped.match(/^current\s+user[-\s]facing\s+priority\s*:\s*(.+)$/i);
  if (match) {
    const objective = firstObjectiveSentence(match[1]);
    if (objective) {
      return {
        kind: 'user_facing_priority',
        objective,
        priority: 120,
      };
    }
  }

  match = stripped.match(/\b(architect|builder|oracle)\s+task\s*:\s*(.+)$/i);
  if (match) {
    const role = String(match[1] || '').toLowerCase();
    const objective = firstObjectiveSentence(match[2]);
    if (objective) {
      return {
        kind: 'role_task',
        objective,
        priority: role === 'builder' ? 84 : (role === 'oracle' ? 82 : 80),
      };
    }
  }

  match = stripped.match(/\bplease\s+make\s+this\s+current[-\s]lane\s+implementation\s*:\s*(.+)$/i)
    || stripped.match(/\bmake\s+this\s+current[-\s]lane\s+implementation\s*:\s*(.+)$/i)
    || stripped.match(/\bcurrent[-\s]lane\s+implementation\s*:\s*(.+)$/i);
  if (match) {
    const detail = firstObjectiveSentence(match[1]);
    const objective = /mira/i.test(stripped)
      ? normalizeLaneObjective(['Mira panel model attachment', detail].filter(Boolean).join(': '))
      : detail;
    if (objective) {
      return {
        kind: 'current_lane_implementation',
        objective,
        priority: 125,
      };
    }
  }

  if (/\btreat\s+as\s+(?:the\s+)?current[-\s]lane\b/i.test(stripped)) {
    const objective = firstObjectiveSentence(stripped.replace(/\btreat\s+as\s+(?:the\s+)?current[-\s]lane\b[\s\S]*$/i, ''));
    if (objective) {
      return {
        kind: 'current_lane_directive',
        objective,
        priority: 118,
      };
    }
  }

  return null;
}

function extractCurrentLaneDirective(rawBody) {
  const body = toOptionalString(rawBody, '');
  if (!body) return null;

  const lines = body.split(/\r?\n/);
  let bestDirective = null;
  let insideReportSection = isReportLikeDirectiveBody(body);
  for (const line of lines) {
    const stripped = stripAgentPrefix(line);
    if (!stripped) continue;
    if (isReportSectionHeading(stripped)) {
      insideReportSection = true;
      continue;
    }
    if (insideReportSection) continue;

    let match = stripped.match(/^(?:[-*]\s*)?(?:CURRENT\s+(?:LANE|PRIORITY|FOCUS)|ACTIVE\s+LANE|FOCUS)\s*:\s*(.+)$/i);
    if (match) {
      const objective = normalizeLaneObjective(match[1]);
      if (objective) {
        bestDirective = selectHigherPriorityDirective(bestDirective, {
          kind: 'current_lane',
          objective,
          priority: 100,
        });
      }
    }

    match = stripped.match(/^(?:[-*]\s*)?TASK\s*:\s*(.+)$/i);
    if (match) {
      const objective = normalizeLaneObjective(match[1]);
      if (objective) {
        bestDirective = selectHigherPriorityDirective(bestDirective, {
          kind: 'task',
          objective,
          priority: 80,
        });
      }
    }

    match = stripped.match(/^(?:[-*]\s*)?OBJECTIVE\s*:\s*(.+)$/i);
    if (match) {
      const objective = normalizeLaneObjective(match[1]);
      if (objective) {
        bestDirective = selectHigherPriorityDirective(bestDirective, {
          kind: 'objective',
          objective,
          priority: 70,
        });
      }
    }
  }

  bestDirective = selectHigherPriorityDirective(bestDirective, extractNaturalCurrentLaneDirective(body));

  if (/\bactual focus\b[\s\S]{0,120}\bnew\s+mira\b/i.test(body)) {
    bestDirective = selectHigherPriorityDirective(bestDirective, {
      kind: 'current_focus',
      objective: 'New Mira',
      priority: 110,
    });
  }

  if (/\bcurrent priority\b[\s\S]{0,120}\bnew\s+mira\b/i.test(body)) {
    bestDirective = selectHigherPriorityDirective(bestDirective, {
      kind: 'current_priority',
      objective: 'New Mira',
      priority: 105,
    });
  }

  return withLiveRiskPriority(bestDirective, body);
}

function buildLaneId(sessionId, row, ref) {
  const sessionPart = toOptionalString(sessionId, 'session') || 'session';
  const refPart = ref ? `${ref.role}-${ref.seq}` : 'unsequenced';
  const messagePart = toOptionalString(row?.messageId, null);
  return [sessionPart, refPart, messagePart].filter(Boolean).join(':');
}

function deriveCurrentLaneSnapshot(rows = [], options = {}) {
  const orderedRows = Array.isArray(rows) ? rows : [];
  const sessionId = toOptionalString(options.sessionId, null);
  const generatedAt = toOptionalString(options.generatedAt, null)
    || new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
  const candidates = [];
  const resolved = [];

  for (let index = 0; index < orderedRows.length; index += 1) {
    const row = orderedRows[index];
    const directive = extractCurrentLaneDirective(row?.rawBody || '');
    if (!directive) continue;
    const ref = parseLeadingAgentRef(row?.rawBody || '');
    const terminallyResolved = isAgentTaskResolvedByLaterSignal(row, orderedRows, index, {
      includeReceipt: false,
    });
    const entry = {
      laneId: buildLaneId(sessionId, row, ref),
      objective: directive.objective,
      kind: directive.kind,
      priority: directive.priority,
      status: terminallyResolved ? 'resolved_or_superseded' : 'active',
      sourceMessageId: toOptionalString(row?.messageId, null),
      sourceRef: ref ? `${ref.role}#${ref.seq}` : null,
      sourceTimestampMs: toEventTsMs(row),
      senderRole: normalizeAgentRole(row?.senderRole) || toOptionalString(row?.senderRole, null),
      targetRole: normalizeAgentRole(row?.targetRole) || toOptionalString(row?.targetRole, null),
    };
    if (terminallyResolved) {
      resolved.push(entry);
    } else {
      candidates.push(entry);
    }
  }

  candidates.sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    return right.sourceTimestampMs - left.sourceTimestampMs;
  });

  const active = candidates[0] || null;
  return {
    version: 1,
    generatedAt,
    sessionId,
    source: 'comms_journal',
    status: active ? 'active' : 'none',
    activeLane: active,
    activeLaneCount: active ? 1 : 0,
    candidateCount: candidates.length,
    resolvedOrSupersededCount: resolved.length,
  };
}

module.exports = {
  normalizeAgentRole,
  parseLeadingAgentRef,
  extractAgentRefs,
  bodyReferencesAgentRef,
  hasClosureSignal,
  isLaterAgentClosureRow,
  isAgentTaskResolvedByLaterSignal,
  extractCurrentLaneDirective,
  deriveCurrentLaneSnapshot,
};
