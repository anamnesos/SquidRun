#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function toLocalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function summarizePortfolioAuditEntry(data = {}, filePath, today) {
  const closedTrades = Array.isArray(data.closedTrades) ? data.closedTrades : [];
  const missing = closedTrades.filter((trade) => {
    const closedAt = String(trade?.closedAt || '').trim();
    if (!closedAt || !closedAt.startsWith(today)) return false;
    const review = trade?.rootCauseReview || null;
    const reviewedAt = String(review?.reviewedAt || '').trim();
    const summary = String(review?.plainEnglishSummary || review?.whatWentWrong || '').trim();
    return !review || !reviewedAt.startsWith(today) || !summary;
  });
  return {
    agentId: String(data.agentId || data.agent || path.basename(filePath || '', '.json')).trim(),
    filePath,
    totalPnl: Number(data.totalPnl ?? ((Number(data.equity || data.currentEquity || 0) || 0) - (Number(data.startingBalance || 0) || 0))) || 0,
    openPositionCount: Array.isArray(data.openPositions) ? data.openPositions.length : 0,
    closedTradeCount: closedTrades.length,
    missingSameDayRootCauseReviews: missing.length,
  };
}

function buildAudit(projectRoot = process.cwd(), now = new Date(), portfolioOverrides = null) {
  const dir = path.join(projectRoot, 'workspace', 'agent-trading');
  const today = toLocalDateKey(now);
  const result = {
    ok: true,
    today,
    path: dir,
    missingSameDayRootCauseReviews: 0,
    agents: [],
  };
  if (!fs.existsSync(dir)) {
    return { ...result, ok: false, error: 'missing_agent_trading_dir' };
  }

  if (Array.isArray(portfolioOverrides) && portfolioOverrides.length > 0) {
    result.agents = portfolioOverrides.map((data) => {
      const agentId = String(data?.agentId || data?.agent || 'unknown').trim();
      return summarizePortfolioAuditEntry(data || {}, path.join(dir, `${agentId}-portfolio.json`), today);
    });
  } else {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('-portfolio.json'));
    result.agents = files.map((fileName) => {
      const filePath = path.join(dir, fileName);
      const data = readJson(filePath, {}) || {};
      return summarizePortfolioAuditEntry(data, filePath, today);
    });
  }
  result.missingSameDayRootCauseReviews = result.agents.reduce(
    (sum, entry) => sum + Number(entry?.missingSameDayRootCauseReviews || 0),
    0
  );
  result.ok = result.missingSameDayRootCauseReviews === 0;
  return result;
}

function main() {
  const projectRoot = process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..');
  const result = buildAudit(projectRoot);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAudit,
};
