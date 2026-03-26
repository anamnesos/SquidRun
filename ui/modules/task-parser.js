/**
 * Natural language task parsing
 * Converts free-form task input into structured subtasks with dependency hints.
 */

const smartRouting = require('./smart-routing');

const AMBIGUOUS_TERMS = [
  'something',
  'stuff',
  'etc',
  'maybe',
  'kind of',
  'sort of',
  'whatever',
  'anything',
  'things',
  'misc',
  'around',
  'somehow',
];

const DEPENDENCY_HINTS = ['then', 'after', 'afterward', 'afterwards', 'once', 'when', 'following', 'next', 'finally', 'before'];
const PROBLEM_DOMAIN_KEYWORDS = Object.freeze({
  legal: [
    'legal',
    'lawyer',
    'attorney',
    'lawsuit',
    'sue',
    'court',
    'judge',
    'complaint',
    'contract',
    'lease',
    'eviction',
    'settlement',
    'statute of limitations',
    'landlord',
    'tenant',
    'debt collector',
    'small claims',
    'cease and desist',
    'sosong',
    'gyeyak',
  ],
  financial: [
    'debt',
    'loan',
    'credit card',
    'bank',
    'mortgage',
    'foreclosure',
    'collections',
    'bankruptcy',
    'interest rate',
    'payment plan',
    'irs',
    'tax',
    'refund',
    'overdraft',
    'rent assistance',
    'financial aid',
    'insurance claim',
    'budget shortfall',
  ],
  medical: [
    'doctor',
    'hospital',
    'clinic',
    'diagnosis',
    'symptom',
    'symptoms',
    'medication',
    'prescription',
    'treatment',
    'surgery',
    'emergency room',
    'mental health',
    'therapy',
    'side effect',
    'illness',
    'injury',
    'medical bill',
  ],
});
const PROBLEM_INSTITUTIONS = [
  'bank',
  'court',
  'hospital',
  'insurance',
  'landlord',
  'employer',
  'school',
  'police',
  'government',
  'irs',
  'collector',
];
const PROBLEM_CONTEXT_TERMS = [
  'help',
  'problem',
  'issue',
  'urgent',
  'stuck',
  'need advice',
  'what should i do',
  'can i',
  'am i allowed',
  'they refused',
  'they denied',
  'they charged',
  'i was billed',
  'i need to fight',
  'i need to dispute',
];
const MONEY_AMOUNT_PATTERN = /(?:\$|usd\s*)\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:usd|dollars|won|krw)\b/gi;
const PROBLEM_STATUS = Object.freeze({
  DETECTED: 'detected',
  NONE: 'none',
});

function normalize(text) {
  return (text || '').trim();
}

function normalizeLower(text) {
  return normalize(text).toLowerCase();
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function collectKeywordHits(lowerText, keywords = []) {
  return keywords.filter((keyword) => lowerText.includes(String(keyword).toLowerCase()));
}

function hasBulletLines(text) {
  return text.split('\n').some((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line));
}

function splitBullets(text) {
  const lines = text.split('\n');
  const items = [];
  let current = null;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const match = trimmed.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (match) {
      if (current) items.push(current);
      current = match[1].trim();
    } else if (current) {
      current += ` ${trimmed}`;
    }
  });
  if (current) items.push(current);
  return items;
}

function splitByConnectors(text) {
  let normalized = text;
  normalized = normalized.replace(/\s+and then\s+/gi, '; ');
  normalized = normalized.replace(/\s+then\s+/gi, '; ');
  normalized = normalized.replace(/\s+after that\s+/gi, '; ');
  normalized = normalized.replace(/\s+afterwards?\s+/gi, '; ');
  normalized = normalized.replace(/\s+next\s+/gi, '; ');
  normalized = normalized.replace(/\s+finally\s+/gi, '; ');
  normalized = normalized.replace(/\s+lastly\s+/gi, '; ');

  let chunks = normalized.split(/[;\n]/).map((part) => part.trim()).filter(Boolean);
  if (chunks.length <= 1 && normalized.length > 80 && normalized.includes(' and ')) {
    chunks = normalized.split(/\s+and\s+/i).map((part) => part.trim()).filter(Boolean);
  }
  return chunks;
}

function detectProblemIntake(text) {
  const raw = normalize(text);
  const lower = normalizeLower(raw);
  if (!lower) {
    return {
      status: PROBLEM_STATUS.NONE,
      detected: false,
      domain: null,
      domains: [],
      confidence: 0,
      triggers: [],
      institutions: [],
      moneyAmounts: [],
      recommendedFlow: null,
    };
  }

  const domainHits = Object.entries(PROBLEM_DOMAIN_KEYWORDS).map(([domain, keywords]) => {
    const hits = collectKeywordHits(lower, keywords);
    return { domain, hits, score: hits.length };
  });
  const sortedDomains = domainHits
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.domain.localeCompare(right.domain));
  const institutions = collectKeywordHits(lower, PROBLEM_INSTITUTIONS);
  const moneyAmounts = Array.from(raw.matchAll(MONEY_AMOUNT_PATTERN)).map((match) => match[0].trim());
  const contextHits = collectKeywordHits(lower, PROBLEM_CONTEXT_TERMS);
  const topDomain = sortedDomains[0] || null;
  const weightedScore = (topDomain ? topDomain.score : 0)
    + (institutions.length > 0 ? 1 : 0)
    + (moneyAmounts.length > 0 ? 1 : 0)
    + (contextHits.length > 0 ? 1 : 0);
  const detected = Boolean(topDomain && weightedScore >= 2);
  const confidence = detected
    ? Math.min(
      0.95,
      0.42
        + ((topDomain ? topDomain.score : 0) * 0.14)
        + (institutions.length ? 0.12 : 0)
        + (moneyAmounts.length ? 0.1 : 0)
        + (contextHits.length ? 0.08 : 0)
    )
    : 0;

  return {
    status: detected ? PROBLEM_STATUS.DETECTED : PROBLEM_STATUS.NONE,
    detected,
    domain: detected ? topDomain.domain : null,
    domains: detected ? sortedDomains.map((entry) => entry.domain) : [],
    confidence: detected ? Number(confidence.toFixed(2)) : 0,
    triggers: uniqueSorted([
      ...(topDomain ? topDomain.hits.map((keyword) => `${topDomain.domain}:${keyword}`) : []),
      ...institutions.map((institution) => `institution:${institution}`),
      ...(moneyAmounts.length > 0 ? ['money-amount'] : []),
      ...contextHits.map((term) => `problem:${term}`),
    ]),
    institutions: uniqueSorted(institutions),
    moneyAmounts: uniqueSorted(moneyAmounts),
    recommendedFlow: detected ? 'problem-orchestration' : null,
  };
}

function detectAmbiguity(text, analysisConfidence) {
  const reasons = [];
  const questions = [];
  const lower = normalizeLower(text);

  if (!lower || lower.length < 12) {
    reasons.push('Task description too short');
    questions.push('Can you add a bit more detail about the desired outcome?');
  }

  if (AMBIGUOUS_TERMS.some((term) => lower.includes(term))) {
    reasons.push('Task contains vague wording');
    questions.push('Can you replace vague terms (e.g., "stuff", "something") with concrete actions?');
  }

  if (analysisConfidence !== null && analysisConfidence < 0.35) {
    reasons.push('Task category unclear');
    questions.push('Is this primarily UI, backend/daemon, debugging, review, or coordination?');
  }

  return {
    isAmbiguous: reasons.length > 0,
    reasons,
    questions,
  };
}

function inferDependencies(subtasks, originalText) {
  const hasHints = DEPENDENCY_HINTS.some((hint) => normalizeLower(originalText).includes(hint));
  return subtasks.map((task, idx) => {
    if (idx === 0) return task;
    const dependsOn = [];
    if (hasHints) {
      dependsOn.push(subtasks[idx - 1].id);
    }
    return {
      ...task,
      dependsOn,
    };
  });
}

function parseTaskInput(text) {
  const raw = normalize(text);
  if (!raw) {
    return {
      success: false,
      error: 'empty',
      ambiguity: {
        isAmbiguous: true,
        reasons: ['Empty task'],
        questions: ['Provide a task description.'],
      },
      problemIntake: detectProblemIntake(raw),
      subtasks: [],
    };
  }

  const useBullets = hasBulletLines(raw);
  const parts = useBullets ? splitBullets(raw) : splitByConnectors(raw);
  const subtasks = [];
  const aggregateQuestions = [];
  const aggregateReasons = [];

  parts.forEach((part, index) => {
    if (!part) return;
    const analysis = smartRouting.inferTaskType(null, part);
    const ambiguity = detectAmbiguity(part, analysis.confidence);
    if (ambiguity.isAmbiguous) {
      aggregateReasons.push(...ambiguity.reasons);
      aggregateQuestions.push(...ambiguity.questions);
    }

    subtasks.push({
      id: `task-${index + 1}`,
      text: part,
      taskType: analysis.taskType,
      inferred: analysis.inferred,
      analysisConfidence: analysis.confidence,
      dependsOn: [],
    });
  });

  return {
    success: true,
    raw,
    problemIntake: detectProblemIntake(raw),
    subtasks: inferDependencies(subtasks, raw),
    ambiguity: {
      isAmbiguous: aggregateReasons.length > 0,
      reasons: Array.from(new Set(aggregateReasons)),
      questions: Array.from(new Set(aggregateQuestions)),
    },
  };
}

module.exports = {
  detectProblemIntake,
  parseTaskInput,
  PROBLEM_STATUS,
};
