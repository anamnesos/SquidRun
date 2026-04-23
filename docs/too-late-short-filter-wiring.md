# Engine wire-in for oracle-watch-too-late-filter
# Apply these minimal changes to ui/scripts/hm-oracle-watch-engine.js:

# 1. Add import (after oracleWatchRegime require):
+const { evaluateTooLateShortRule } = require('../modules/trading/oracle-watch-too-late-filter');

# 2. Add path constant (near DEFAULT_HARD_RISK_STATE_PATH):
+const DEFAULT_PROMOTION_DECISIONS_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-promotion-decisions.jsonl'), { forWrite: true });

# 3. Add helper function (just before evaluateLoseFailRetest):
+function logPromotionDecision(payload) {
+  try {
+    fs.mkdirSync(path.dirname(DEFAULT_PROMOTION_DECISIONS_PATH), { recursive: true });
+    fs.appendFileSync(DEFAULT_PROMOTION_DECISIONS_PATH, JSON.stringify(payload) + '\n', 'utf8');
+  } catch { /* non-fatal: observability only */ }
+}

# 4. Change evaluateLoseFailRetest signature:
-function evaluateLoseFailRetest(rule = {}, symbolContext = {}, ruleState = {}, nowMs = Date.now()) {
+function evaluateLoseFailRetest(rule = {}, symbolContext = {}, ruleState = {}, nowMs = Date.now(), anchorContext = null) {

# 5. Inside evaluateLoseFailRetest at the failedRetest -> fired branch, BEFORE setting status='fired':
+    const filter = evaluateTooLateShortRule({ rule, symbolContext, btcContext: anchorContext, nowMs });
+    if (filter.decision === 'hard_block' && ruleState.status !== 'fired') {
+      logPromotionDecision({ ts: new Date(nowMs).toISOString(), event: 'fire_blocked', ticker: rule.ticker, ruleId: rule.id, reject_reason: 'too_late_short', reasons: filter.reasons, flaggedFeatures: filter.flaggedFeatures });
+      return { state: nextState, events }; // stay armed, don't transition
+    }
+    if (ruleState.status !== 'fired' && filter.decision === 'soft_block') {
+      nextState.tooLateSoftBlock = { reasons: filter.reasons, recordedAt: new Date(nowMs).toISOString() };
+      logPromotionDecision({ ts: new Date(nowMs).toISOString(), event: 'fire_soft_blocked', ticker: rule.ticker, ruleId: rule.id, reasons: filter.reasons });
+    }

# 6. At evaluateRule dispatcher, pass anchorContext:
-    return evaluateLoseFailRetest(rule, symbolContext, ruleState, nowMs);
+    const anchorContext = context.byTicker?.[normalizeTicker('BTC/USD')] || null;
+    return evaluateLoseFailRetest(rule, symbolContext, ruleState, nowMs, anchorContext);
