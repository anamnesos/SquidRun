/**
 * Smart Routing - scoring and selection
 * Computes best agent based on task content, skills, learning outcomes,
 * performance metrics, and load balancing.
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const ROUTING_HISTORY_LIMIT = 500;
const LOAD_HALF_LIFE_MS = 5 * 60 * 1000;

const DEFAULT_LEARNING = {
  taskTypes: {},
  routingWeights: { '1': 1.0, '2': 1.0, '3': 1.0 },
  totalDecisions: 0,
  routingHistory: [],
  lastUpdated: null,
};

const TASK_TYPE_ALIASES = {
  thinking: 'analysis',
  analysis: 'analysis',
  investigate: 'analysis',
  investigation: 'analysis',
  debugging: 'analysis',
  implementation: 'implementation',
  implement: 'implementation',
  build: 'implementation',
  ui: 'ui',
  frontend: 'ui',
  renderer: 'ui',
  css: 'ui',
  backend: 'backend',
  daemon: 'backend',
  ipc: 'backend',
  review: 'review',
  testing: 'review',
  verification: 'review',
  planning: 'planning',
  coordination: 'coordination',
  routing: 'coordination',
};

const TASK_TYPE_KEYWORDS = {
  ui: ['ui', 'frontend', 'css', 'html', 'layout', 'renderer', 'styles', 'design', 'ux', 'webgl', 'xterm'],
  backend: ['backend', 'daemon', 'ipc', 'node', 'process', 'pty', 'server', 'api'],
  review: ['review', 'verify', 'verification', 'qa', 'audit', 'approve', 'coverage'],
  analysis: ['investigate', 'analysis', 'debug', 'trace', 'repro', 'root cause', 'diagnose'],
  planning: ['plan', 'roadmap', 'architecture', 'design', 'spec', 'strategy'],
  coordination: ['route', 'routing', 'assign', 'handoff', 'sync', 'coordination'],
  implementation: ['implement', 'build', 'code', 'feature', 'fix', 'ship'],
};

const SKILL_SYNONYMS = {
  ui: ['ui', 'frontend', 'css', 'html', 'layout', 'styles', 'design', 'ux', 'renderer', 'webgl'],
  frontend: ['frontend', 'ui', 'renderer', 'dom'],
  renderer: ['renderer', 'ui', 'xterm', 'dom'],
  implementation: ['implement', 'build', 'code', 'feature', 'fix', 'ship'],
  backend: ['backend', 'daemon', 'ipc', 'node', 'process', 'server', 'api'],
  ipc: ['ipc', 'channel', 'handler', 'main process', 'renderer'],
  refactor: ['refactor', 'cleanup', 'split', 'modularize'],
  debugging: ['debug', 'investigate', 'trace', 'log', 'root cause', 'repro'],
  testing: ['test', 'verify', 'qa', 'coverage', 'assert'],
  analysis: ['analysis', 'investigate', 'diagnose', 'triage'],
  review: ['review', 'verify', 'audit', 'approve'],
  planning: ['plan', 'strategy', 'roadmap', 'spec', 'architecture'],
  coordination: ['coordinate', 'routing', 'handoff', 'sync'],
  routing: ['route', 'routing', 'assign'],
  verification: ['verify', 'validate', 'confirm'],
  architecture: ['architecture', 'design', 'system'],
};

const agentLoad = new Map();

function normalizeText(text) {
  if (!text) return '';
  return String(text).toLowerCase();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function includesPhrase(text, phrase) {
  return text.includes(phrase);
}

function inferTaskType(taskType, message) {
  const normalizedType = TASK_TYPE_ALIASES[normalizeText(taskType)] || normalizeText(taskType);
  const text = normalizeText(message);

  let bestType = normalizedType || null;
  let bestScore = 0;

  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (keyword.includes(' ')) {
        if (includesPhrase(text, keyword)) score += 2;
      } else {
        if (text.includes(keyword)) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  const confidence = bestScore >= 3 ? 0.8 : bestScore >= 1 ? 0.5 : 0.2;
  return { taskType: bestType || normalizedType || 'general', inferred: bestType !== normalizedType, confidence };
}

function buildSkillKeywords(skills) {
  const set = new Set();
  skills.forEach(skill => {
    set.add(skill);
    const synonyms = SKILL_SYNONYMS[skill];
    if (synonyms) {
      synonyms.forEach(s => set.add(s));
    }
  });
  return Array.from(set);
}

function calculateSkillMatch(role, taskType, message) {
  const text = normalizeText(message);
  const keywords = buildSkillKeywords(role.skills || []);
  let hits = 0;

  for (const keyword of keywords) {
    if (keyword.includes(' ')) {
      if (includesPhrase(text, keyword)) hits += 2;
    } else if (text.includes(keyword)) {
      hits += 1;
    }
  }

  const baseMatch = clamp(hits / Math.max(4, keywords.length / 3), 0, 1);
  const typeMatch = role.type === taskType || (role.skills || []).includes(taskType) ? 0.6 : 0;
  return clamp(Math.max(baseMatch, typeMatch), 0, 1);
}

function normalizePerformance(stats) {
  if (!stats) return 0.5;
  const completions = stats.completions || 0;
  const errors = stats.errors || 0;
  const total = completions + errors;
  const successRate = total > 0 ? completions / total : 0.5;
  const avgTime = stats.responseCount > 0
    ? stats.totalResponseTime / stats.responseCount
    : 12000;
  const timeScore = 1 / (1 + (avgTime / 10000));
  return clamp((successRate * 0.6) + (timeScore * 0.4), 0, 1);
}

function normalizeLearning(taskType, paneId, learning) {
  if (!learning || !learning.taskTypes || !learning.taskTypes[taskType]) {
    return { score: 0.5, attempts: 0 };
  }

  const stats = learning.taskTypes[taskType].agentStats?.[paneId];
  if (!stats || stats.attempts === 0) {
    return { score: 0.5, attempts: 0 };
  }

  const successRate = stats.success / stats.attempts;
  const avgTime = stats.attempts > 0 ? stats.totalTime / stats.attempts : 12000;
  const timeScore = 1 / (1 + (avgTime / 12000));
  const score = clamp((successRate * 0.7) + (timeScore * 0.3), 0, 1);
  return { score, attempts: stats.attempts };
}

function decayLoad(loadEntry) {
  if (!loadEntry) return 0;
  const now = Date.now();
  const elapsed = Math.max(0, now - loadEntry.lastUpdated);
  const decayFactor = Math.pow(0.5, elapsed / LOAD_HALF_LIFE_MS);
  loadEntry.count *= decayFactor;
  loadEntry.lastUpdated = now;
  return loadEntry.count;
}

function getLoadScore(paneId) {
  const entry = agentLoad.get(paneId);
  const load = decayLoad(entry || { count: 0, lastUpdated: Date.now() });
  const score = 1 / (1 + load);
  return clamp(score, 0, 1);
}

function recordAssignment(paneId) {
  const entry = agentLoad.get(paneId) || { count: 0, lastUpdated: Date.now() };
  decayLoad(entry);
  entry.count += 1;
  agentLoad.set(paneId, entry);
}

function loadLearning(workspacePath) {
  if (!workspacePath) return { ...DEFAULT_LEARNING };
  const filePath = path.join(workspacePath, 'learning.json');
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { ...DEFAULT_LEARNING, ...JSON.parse(content) };
    }
  } catch (err) {
    log.error('SmartRouting', 'Failed to load learning data:', err.message);
  }
  return { ...DEFAULT_LEARNING };
}

function saveLearning(workspacePath, data) {
  if (!workspacePath) return;
  const filePath = path.join(workspacePath, 'learning.json');
  try {
    data.lastUpdated = new Date().toISOString();
    const tempPath = filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    log.error('SmartRouting', 'Failed to save learning data:', err.message);
  }
}

function scoreAgents({ taskType, message, roles, runningMap, performance, learning }) {
  const scores = [];

  for (const [paneId, role] of Object.entries(roles)) {
    if (runningMap && runningMap.get && runningMap.get(paneId) !== 'running') {
      continue;
    }

    const skillMatch = calculateSkillMatch(role, taskType, message);
    const learningData = normalizeLearning(taskType, paneId, learning);
    const performanceScore = normalizePerformance(performance?.agents?.[paneId]);
    const loadScore = getLoadScore(paneId);
    const availability = 1;

    const total = (skillMatch * 0.35) + (learningData.score * 0.25) + (performanceScore * 0.2) + (loadScore * 0.15) + (availability * 0.05);

    scores.push({
      paneId,
      role: role.name,
      total,
      breakdown: {
        skillMatch,
        learning: learningData.score,
        performance: performanceScore,
        load: loadScore,
        availability,
      },
      attempts: learningData.attempts,
    });
  }

  return scores.sort((a, b) => b.total - a.total);
}

function buildDecision(scores) {
  if (scores.length === 0) {
    return { paneId: null, reason: 'no_running_candidates', confidence: 0 };
  }

  const [best, second] = scores;
  const spread = second ? best.total - second.total : best.total;
  const spreadFactor = best.total > 0 ? spread / best.total : 0;
  const dataQuality = clamp(best.attempts / 5, 0, 1);

  let confidence = clamp(0.1 + (spreadFactor * 0.6) + (dataQuality * 0.3), 0, 0.99);
  if (best.total < 0.35) {
    confidence = Math.min(confidence, 0.4);
  }

  let reason = 'balanced';
  const { skillMatch, learning, performance, load } = best.breakdown;
  const maxComponent = Math.max(skillMatch, learning, performance, load);

  const weakSignals = skillMatch < 0.2 && learning <= 0.55 && performance <= 0.55;
  if (weakSignals) {
    reason = 'first_available';
  } else if (maxComponent === performance && performance > 0.6) {
    reason = 'performance_based';
  } else if (maxComponent === learning && learning > 0.6) {
    reason = 'learning_based';
  } else if (maxComponent === skillMatch && skillMatch > 0.6) {
    reason = 'skill_match';
  } else if (maxComponent === load) {
    reason = 'load_balanced';
  }

  return {
    paneId: best.paneId,
    reason,
    confidence,
    score: best.total,
    scores,
    breakdown: best.breakdown,
  };
}

function recordDecision(workspacePath, decision) {
  if (!workspacePath || !decision || !decision.paneId) return;
  const learning = loadLearning(workspacePath);
  learning.routingHistory = learning.routingHistory || [];
  learning.routingHistory.push({
    timestamp: new Date().toISOString(),
    paneId: decision.paneId,
    reason: decision.reason,
    confidence: decision.confidence,
    score: decision.score,
  });
  if (learning.routingHistory.length > ROUTING_HISTORY_LIMIT) {
    learning.routingHistory = learning.routingHistory.slice(-ROUTING_HISTORY_LIMIT);
  }
  saveLearning(workspacePath, learning);
}

function getBestAgent({ taskType, message, roles, runningMap, performance, workspacePath }) {
  const analyzed = inferTaskType(taskType, message);
  const learning = loadLearning(workspacePath);
  const scores = scoreAgents({
    taskType: analyzed.taskType,
    message,
    roles,
    runningMap,
    performance,
    learning,
  });

  const decision = buildDecision(scores);
  if (decision.paneId) {
    recordAssignment(decision.paneId);
    recordDecision(workspacePath, decision);
  }

  return {
    ...decision,
    taskType: analyzed.taskType,
    inferred: analyzed.inferred,
    analysisConfidence: analyzed.confidence,
  };
}

module.exports = {
  getBestAgent,
  inferTaskType,
  scoreAgents,
};
