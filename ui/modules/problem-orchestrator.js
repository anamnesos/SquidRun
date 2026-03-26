const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { resolveCoordPath } = require('../config');
const log = require('./logger');
const { buildCapabilityPlan } = require('./capability-planner');

const ACTIVE_CASES_SCHEMA_VERSION = 2;
const ACTIVE_CASES_RELATIVE_PATH = path.join('runtime', 'active-cases.json');
const ORACLE_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
const CASE_STATUS = Object.freeze({
  INTAKE: 'intake',
  ARCHITECT_PASS: 'architect_pass',
  ORACLE_VERIFY: 'oracle_verify',
  CAPABILITY_PLAN: 'capability_plan',
  USER_READY: 'user_ready',
  CLOSED: 'closed',
});

function toIso(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function toText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function asObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeList(values = []) {
  return Array.from(new Set(asArray(values).map((item) => toText(item)).filter(Boolean)));
}

function resolveActiveCasesPath() {
  return resolveCoordPath(ACTIVE_CASES_RELATIVE_PATH, { forWrite: true });
}

function createEmptyState() {
  return {
    schemaVersion: ACTIVE_CASES_SCHEMA_VERSION,
    updatedAt: toIso(),
    cases: [],
  };
}

function summarizeCaseTitle(raw, domain) {
  const text = toText(raw);
  if (!text) {
    return domain ? `${domain} case intake` : 'problem intake';
  }
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || text;
  if (firstLine.length <= 120) return firstLine;
  return `${firstLine.slice(0, 117)}...`;
}

function buildIntakeFingerprint(raw, problemIntake = {}) {
  const normalized = `${toText(problemIntake.domain, 'unknown')}|${toText(raw).replace(/\s+/g, ' ').toLowerCase()}`;
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

function buildWorkflowSkeleton(nowIso) {
  return {
    architectPass: {
      status: 'pending',
      assignedRole: 'architect',
      updatedAt: nowIso,
      notes: [],
    },
    oracleVerify: {
      status: 'pending',
      assignedRole: 'oracle',
      timeoutMs: ORACLE_VERIFY_TIMEOUT_MS,
      updatedAt: nowIso,
      warning: null,
      summary: null,
      disagreements: [],
    },
    capabilityPlan: {
      status: 'pending',
      assignedRole: 'architect',
      updatedAt: nowIso,
    },
    userReady: {
      status: 'pending',
      assignedRole: 'architect',
      updatedAt: nowIso,
    },
    artifacts: {
      status: 'pending',
      assignedRole: 'builder',
      updatedAt: nowIso,
    },
  };
}

function normalizeCapabilityPlan(plan = {}, record = {}) {
  const fallback = buildCapabilityPlan(record);
  const safe = asObject(plan);
  const actions = asArray(safe.actions).map((action) => ({
    id: toText(action.id),
    label: toText(action.label),
    summary: toText(action.summary),
  })).filter((action) => action.label);

  return {
    domain: toText(safe.domain, fallback.domain),
    domainLabel: toText(safe.domainLabel, fallback.domainLabel),
    intro: toText(safe.intro, fallback.intro),
    actions: actions.length > 0 ? actions : fallback.actions,
    context: normalizeList(safe.context).length > 0 ? normalizeList(safe.context) : fallback.context,
    shortNotice: toText(safe.shortNotice, fallback.shortNotice),
    markdown: toText(safe.markdown, fallback.markdown),
  };
}

function normalizeDisagreement(disagreement = {}) {
  const safe = asObject(disagreement);
  return {
    topic: toText(safe.topic, 'difference found'),
    architect: toText(safe.architect, null),
    oracle: toText(safe.oracle, null),
    evidence: toText(safe.evidence, null),
  };
}

function buildVerificationSurface(record = {}) {
  const oracleVerify = asObject(record.workflow?.oracleVerify);
  const disagreements = asArray(oracleVerify.disagreements).map((item) => normalizeDisagreement(item)).filter((item) => item.topic);

  if (toText(oracleVerify.status) === 'timeout') {
    return {
      status: 'timeout',
      label: 'Oracle verification timed out',
      warning: toText(oracleVerify.warning, 'Unverified: Oracle did not respond before the timeout.'),
      disagreements,
    };
  }

  if (disagreements.length > 0) {
    return {
      status: 'disagreement',
      label: 'Architect and Oracle disagree',
      warning: toText(oracleVerify.warning, `Disagreement surfaced: ${disagreements[0].topic}`),
      disagreements,
    };
  }

  if (toText(oracleVerify.status) === 'verified') {
    return {
      status: 'verified',
      label: 'Cross-check complete',
      warning: null,
      disagreements: [],
    };
  }

  if (toText(oracleVerify.status) === 'in_progress') {
    return {
      status: 'pending',
      label: 'Oracle verification in progress',
      warning: null,
      disagreements: [],
    };
  }

  return {
    status: 'pending',
    label: 'Oracle verification pending',
    warning: null,
    disagreements: [],
  };
}

function buildUserFacingOutput(record = {}) {
  const capabilityPlan = normalizeCapabilityPlan(record.capabilityPlan, record);
  const verification = buildVerificationSurface(record);
  const lines = [
    capabilityPlan.intro || 'Here is what we can do for you right now.',
    ...capabilityPlan.context,
    ...capabilityPlan.actions.map((action) => `- ${action.label}: ${action.summary}`),
    `Cross-check status: ${verification.label}.`,
  ];

  if (verification.warning) {
    lines.push(`Warning: ${verification.warning}`);
  }
  if (verification.disagreements.length > 0) {
    verification.disagreements.slice(0, 2).forEach((item) => {
      lines.push(`Disagreement: ${item.topic}`);
    });
  }

  const shortNoticeBase = toText(capabilityPlan.shortNotice, 'Here is what we can do for you right now.');
  const shortNotice = verification.warning
    ? `${shortNoticeBase} ${verification.warning}`
    : shortNoticeBase;

  return {
    heading: 'Here is what we can do for you',
    shortNotice,
    verificationLabel: verification.label,
    warning: verification.warning,
    disagreements: verification.disagreements,
    markdown: lines.join('\n'),
  };
}

function attachDerivedState(record = {}) {
  const normalized = {
    ...record,
    capabilityPlan: normalizeCapabilityPlan(record.capabilityPlan, record),
  };
  normalized.userFacing = buildUserFacingOutput(normalized);
  return normalized;
}

function normalizeCaseRecord(record = {}) {
  const safe = asObject(record);
  const normalized = {
    caseId: toText(safe.caseId),
    intakeFingerprint: toText(safe.intakeFingerprint),
    title: toText(safe.title, 'problem intake'),
    domain: toText(safe.domain, null),
    domains: normalizeList(safe.domains),
    status: toText(safe.status, CASE_STATUS.INTAKE),
    confidence: Number.isFinite(Number(safe.confidence)) ? Number(safe.confidence) : 0,
    triggers: normalizeList(safe.triggers),
    institutions: normalizeList(safe.institutions),
    moneyAmounts: normalizeList(safe.moneyAmounts),
    source: toText(safe.source, 'problem-orchestrator'),
    raw: toText(safe.raw),
    createdAt: toIso(safe.createdAt),
    updatedAt: toIso(safe.updatedAt),
    lastSeenAt: toIso(safe.lastSeenAt || safe.updatedAt),
    workflow: {
      ...buildWorkflowSkeleton(toIso(safe.updatedAt)),
      ...asObject(safe.workflow),
      architectPass: {
        ...buildWorkflowSkeleton(toIso(safe.updatedAt)).architectPass,
        ...asObject(safe.workflow?.architectPass),
        notes: normalizeList(safe.workflow?.architectPass?.notes),
      },
      oracleVerify: {
        ...buildWorkflowSkeleton(toIso(safe.updatedAt)).oracleVerify,
        ...asObject(safe.workflow?.oracleVerify),
        disagreements: asArray(safe.workflow?.oracleVerify?.disagreements).map((item) => normalizeDisagreement(item)),
      },
      capabilityPlan: {
        ...buildWorkflowSkeleton(toIso(safe.updatedAt)).capabilityPlan,
        ...asObject(safe.workflow?.capabilityPlan),
      },
      userReady: {
        ...buildWorkflowSkeleton(toIso(safe.updatedAt)).userReady,
        ...asObject(safe.workflow?.userReady),
      },
      artifacts: {
        ...buildWorkflowSkeleton(toIso(safe.updatedAt)).artifacts,
        ...asObject(safe.workflow?.artifacts),
      },
    },
    capabilityPlan: normalizeCapabilityPlan(safe.capabilityPlan, safe),
  };
  return attachDerivedState(normalized);
}

function normalizeState(state = {}) {
  const safe = asObject(state);
  return {
    schemaVersion: ACTIVE_CASES_SCHEMA_VERSION,
    updatedAt: toIso(safe.updatedAt),
    cases: asArray(safe.cases).map((record) => normalizeCaseRecord(record)).filter((record) => record.caseId),
  };
}

function readActiveCasesState() {
  const filePath = resolveActiveCasesPath();
  try {
    if (!fs.existsSync(filePath)) {
      return createEmptyState();
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeState(parsed);
  } catch (error) {
    log.warn('ProblemOrchestrator', `Failed reading active cases: ${error.message}`);
    return createEmptyState();
  }
}

function writeActiveCasesState(state = {}) {
  const filePath = resolveActiveCasesPath();
  const nextState = normalizeState({
    ...createEmptyState(),
    ...state,
    updatedAt: toIso(),
  });
  const tempPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(nextState, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
  return {
    ok: true,
    path: filePath,
    state: nextState,
  };
}

function listActiveCases(input = {}) {
  const state = Array.isArray(input.cases) ? input : readActiveCasesState();
  return normalizeState(state).cases
    .filter((record) => record.status !== CASE_STATUS.CLOSED)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt) || 0;
      const rightTime = Date.parse(right.updatedAt) || 0;
      return rightTime - leftTime;
    });
}

function summarizeCaseForResume(record = {}) {
  const verification = buildVerificationSurface(record);
  const warningSuffix = verification.warning
    ? ` [${toText(verification.status, 'warning')}]`
    : '';
  return `${toText(record.domain, 'general').toUpperCase()} ${record.status}: ${record.title}${warningSuffix}`;
}

function buildStartupResumeSummary(input = {}, options = {}) {
  const state = Array.isArray(input.cases) ? input : readActiveCasesState();
  const limit = Math.max(1, Number(options.limit) || 3);
  const activeCases = listActiveCases(state);
  return {
    count: activeCases.length,
    updatedAt: state.updatedAt || null,
    items: activeCases.slice(0, limit).map((record) => summarizeCaseForResume(record)),
    cases: activeCases.slice(0, limit).map((record) => ({
      caseId: record.caseId,
      title: record.title,
      domain: record.domain,
      status: record.status,
      updatedAt: record.updatedAt,
      warning: record.userFacing?.warning || null,
    })),
  };
}

function buildProblemCaseSnapshot(payload = {}) {
  const parsed = asObject(payload.parsed);
  const problemIntake = asObject(parsed.problemIntake);
  if (problemIntake.detected !== true || !toText(parsed.raw)) {
    return {
      ok: false,
      skipped: true,
      reason: 'problem_not_detected',
    };
  }

  const nowIso = toIso();
  const intakeFingerprint = buildIntakeFingerprint(parsed.raw, problemIntake);
  const workflow = {
    ...buildWorkflowSkeleton(nowIso),
    ...asObject(payload.workflow),
  };

  const caseRecord = normalizeCaseRecord({
    caseId: toText(payload.caseId, `case-${Date.now()}-${intakeFingerprint.slice(0, 6)}`),
    intakeFingerprint,
    title: summarizeCaseTitle(parsed.raw, problemIntake.domain),
    domain: toText(problemIntake.domain, null),
    domains: normalizeList(problemIntake.domains),
    status: toText(payload.status, CASE_STATUS.CAPABILITY_PLAN),
    confidence: Number.isFinite(Number(problemIntake.confidence)) ? Number(problemIntake.confidence) : 0,
    triggers: normalizeList(problemIntake.triggers),
    institutions: normalizeList(problemIntake.institutions),
    moneyAmounts: normalizeList(problemIntake.moneyAmounts),
    source: toText(payload.source, 'route-task-input'),
    raw: toText(parsed.raw),
    createdAt: toIso(payload.createdAt || nowIso),
    updatedAt: nowIso,
    lastSeenAt: nowIso,
    workflow: {
      ...workflow,
      capabilityPlan: {
        ...asObject(workflow.capabilityPlan),
        status: 'ready',
        updatedAt: nowIso,
      },
      userReady: {
        ...asObject(workflow.userReady),
        status: 'ready',
        updatedAt: nowIso,
      },
    },
    capabilityPlan: buildCapabilityPlan({
      domain: problemIntake.domain,
      raw: parsed.raw,
      institutions: problemIntake.institutions,
      moneyAmounts: problemIntake.moneyAmounts,
    }),
  });

  return {
    ok: true,
    case: caseRecord,
  };
}

function previewProblemCase(payload = {}) {
  return buildProblemCaseSnapshot(payload);
}

function upsertProblemCase(payload = {}) {
  const snapshot = buildProblemCaseSnapshot(payload);
  if (!snapshot.ok) {
    return snapshot;
  }

  const state = readActiveCasesState();
  const intakeFingerprint = snapshot.case.intakeFingerprint;
  const existingIndex = state.cases.findIndex((record) => record.intakeFingerprint === intakeFingerprint);

  if (existingIndex >= 0) {
    const existing = normalizeCaseRecord(state.cases[existingIndex]);
    state.cases[existingIndex] = normalizeCaseRecord({
      ...existing,
      ...snapshot.case,
      caseId: existing.caseId,
      createdAt: existing.createdAt,
      status: existing.status || snapshot.case.status,
      workflow: {
        ...existing.workflow,
        architectPass: {
          ...existing.workflow.architectPass,
          updatedAt: snapshot.case.updatedAt,
        },
        capabilityPlan: {
          ...existing.workflow.capabilityPlan,
          status: 'ready',
          updatedAt: snapshot.case.updatedAt,
        },
        userReady: {
          ...existing.workflow.userReady,
          status: 'ready',
          updatedAt: snapshot.case.updatedAt,
        },
      },
    });
  } else {
    state.cases.push(snapshot.case);
  }

  const writeResult = writeActiveCasesState(state);
  const caseRecord = listActiveCases(writeResult.state).find((record) => record.intakeFingerprint === intakeFingerprint) || null;
  return {
    ok: true,
    created: existingIndex < 0,
    case: caseRecord,
    path: writeResult.path,
    state: writeResult.state,
  };
}

function updateProblemCase(caseId, patch = {}) {
  const normalizedCaseId = toText(caseId);
  if (!normalizedCaseId) {
    return {
      ok: false,
      reason: 'case_id_required',
    };
  }

  const state = readActiveCasesState();
  const index = state.cases.findIndex((record) => record.caseId === normalizedCaseId);
  if (index < 0) {
    return {
      ok: false,
      reason: 'case_not_found',
    };
  }

  const nowIso = toIso();
  state.cases[index] = normalizeCaseRecord({
    ...state.cases[index],
    ...asObject(patch),
    workflow: {
      ...asObject(state.cases[index].workflow),
      ...asObject(patch.workflow),
    },
    capabilityPlan: patch.capabilityPlan || state.cases[index].capabilityPlan,
    updatedAt: nowIso,
    lastSeenAt: nowIso,
  });
  const writeResult = writeActiveCasesState(state);
  return {
    ok: true,
    case: writeResult.state.cases.find((record) => record.caseId === normalizedCaseId) || null,
    path: writeResult.path,
    state: writeResult.state,
  };
}

function recordOracleOutcome(caseId, payload = {}) {
  const normalizedCaseId = toText(caseId);
  if (!normalizedCaseId) {
    return {
      ok: false,
      reason: 'case_id_required',
    };
  }

  const nowIso = toIso();
  const disagreements = asArray(payload.disagreements).map((item) => normalizeDisagreement(item)).filter((item) => item.topic);
  let oracleStatus = 'verified';
  if (payload.timeout === true) {
    oracleStatus = 'timeout';
  } else if (disagreements.length > 0) {
    oracleStatus = 'disagreement';
  } else if (payload.verified === false) {
    oracleStatus = 'pending';
  }

  const warning = payload.timeout === true
    ? toText(payload.warning, 'Unverified: Oracle did not respond before the timeout.')
    : (disagreements.length > 0 ? toText(payload.warning, `Disagreement surfaced: ${disagreements[0].topic}`) : null);

  const nextStatus = payload.timeout === true || disagreements.length > 0
    ? CASE_STATUS.ORACLE_VERIFY
    : CASE_STATUS.USER_READY;

  return updateProblemCase(normalizedCaseId, {
    status: nextStatus,
    workflow: {
      oracleVerify: {
        status: oracleStatus,
        updatedAt: nowIso,
        timeoutMs: Number.isFinite(Number(payload.timeoutMs)) ? Number(payload.timeoutMs) : ORACLE_VERIFY_TIMEOUT_MS,
        summary: toText(payload.summary, null),
        warning,
        disagreements,
      },
      userReady: {
        status: payload.timeout === true || disagreements.length > 0 ? 'warning' : 'ready',
        updatedAt: nowIso,
      },
    },
  });
}

function createProblemOrchestrator() {
  return {
    ensureState() {
      const state = readActiveCasesState();
      const filePath = resolveActiveCasesPath();
      if (!fs.existsSync(filePath)) {
        return writeActiveCasesState(state);
      }
      return { ok: true, path: filePath, state };
    },
    resolveActiveCasesPath,
    readState: readActiveCasesState,
    writeState: writeActiveCasesState,
    listActiveCases,
    buildStartupResumeSummary,
    previewProblemCase,
    upsertProblemCase,
    updateProblemCase,
    recordOracleOutcome,
  };
}

let sharedProblemOrchestrator = null;

function getSharedProblemOrchestrator() {
  if (!sharedProblemOrchestrator) {
    sharedProblemOrchestrator = createProblemOrchestrator();
  }
  return sharedProblemOrchestrator;
}

module.exports = {
  ACTIVE_CASES_RELATIVE_PATH,
  ACTIVE_CASES_SCHEMA_VERSION,
  CASE_STATUS,
  ORACLE_VERIFY_TIMEOUT_MS,
  buildCapabilityPlan,
  buildProblemCaseSnapshot,
  buildStartupResumeSummary,
  buildUserFacingOutput,
  createEmptyState,
  createProblemOrchestrator,
  getSharedProblemOrchestrator,
  listActiveCases,
  normalizeCaseRecord,
  normalizeState,
  previewProblemCase,
  readActiveCasesState,
  recordOracleOutcome,
  resolveActiveCasesPath,
  updateProblemCase,
  upsertProblemCase,
  writeActiveCasesState,
};
