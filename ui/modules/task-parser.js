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

function normalize(text) {
  return (text || '').trim();
}

function normalizeLower(text) {
  return normalize(text).toLowerCase();
}

function hasBulletLines(text) {
  return text.split('\n').some(line => /^\s*(?:[-*•]|\d+\.)\s+/.test(line));
}

function splitBullets(text) {
  const lines = text.split('\n');
  const items = [];
  let current = null;
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const match = trimmed.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
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

  let chunks = normalized.split(/[;\n]/).map(part => part.trim()).filter(Boolean);
  if (chunks.length <= 1 && normalized.length > 80 && normalized.includes(' and ')) {
    chunks = normalized.split(/\s+and\s+/i).map(part => part.trim()).filter(Boolean);
  }
  return chunks;
}

function detectAmbiguity(text, analysisConfidence) {
  const reasons = [];
  const questions = [];
  const lower = normalizeLower(text);

  if (!lower || lower.length < 12) {
    reasons.push('Task description too short');
    questions.push('Can you add a bit more detail about the desired outcome?');
  }

  if (AMBIGUOUS_TERMS.some(term => lower.includes(term))) {
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
  const hasHints = DEPENDENCY_HINTS.some(hint => normalizeLower(originalText).includes(hint));
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
      ambiguity: { isAmbiguous: true, reasons: ['Empty task'], questions: ['Provide a task description.'] },
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

  const withDependencies = inferDependencies(subtasks, raw);

  return {
    success: true,
    raw,
    subtasks: withDependencies,
    ambiguity: {
      isAmbiguous: aggregateReasons.length > 0,
      reasons: Array.from(new Set(aggregateReasons)),
      questions: Array.from(new Set(aggregateQuestions)),
    },
  };
}

module.exports = {
  parseTaskInput,
};
