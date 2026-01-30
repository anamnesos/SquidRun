const { registerSdkHandlers } = require('./sdk-handlers');
const { registerSdkV2Handlers } = require('./sdk-v2-handlers');
const { registerMcpHandlers } = require('./mcp-handlers');
const { registerMcpAutoconfigHandlers } = require('./mcp-autoconfig-handlers');
const { registerTestExecutionHandlers } = require('./test-execution-handlers');
const { registerPrecommitHandlers } = require('./precommit-handlers');
const { registerTestNotificationHandlers } = require('./test-notification-handlers');
const { registerMessageQueueHandlers } = require('./message-queue-handlers');
const { registerApiDocsHandlers } = require('./api-docs-handlers');
const { registerPerfAuditHandlers } = require('./perf-audit-handlers');
const { registerErrorHandlers } = require('./error-handlers');
const { registerStateHandlers } = require('./state-handlers');
const { registerSharedContextHandlers } = require('./shared-context-handlers');
const { registerFrictionHandlers } = require('./friction-handlers');
const { registerScreenshotHandlers } = require('./screenshot-handlers');
const { registerProjectHandlers } = require('./project-handlers');
const { registerSmartRoutingHandlers } = require('./smart-routing-handlers');
const { registerAutoHandoffHandlers } = require('./auto-handoff-handlers');
const { registerConflictQueueHandlers } = require('./conflict-queue-handlers');
const { registerLearningDataHandlers } = require('./learning-data-handlers');
const { registerOutputValidationHandlers } = require('./output-validation-handlers');
const { registerCompletionQualityHandlers } = require('./completion-quality-handlers');
const { registerCheckpointHandlers } = require('./checkpoint-handlers');
const { registerActivityLogHandlers } = require('./activity-log-handlers');
const { registerAutoNudgeHandlers } = require('./auto-nudge-handlers');
const { registerCompletionDetectionHandlers } = require('./completion-detection-handlers');
const { registerAgentClaimsHandlers } = require('./agent-claims-handlers');
const { registerSessionSummaryHandlers } = require('./session-summary-handlers');
const { registerPerformanceTrackingHandlers } = require('./performance-tracking-handlers');
const { registerTemplateHandlers } = require('./template-handlers');
const { registerProcessHandlers } = require('./process-handlers');
const { registerUsageStatsHandlers } = require('./usage-stats-handlers');
const { registerSessionHistoryHandlers } = require('./session-history-handlers');
const { registerConflictDetectionHandlers } = require('./conflict-detection-handlers');
const { registerSettingsHandlers } = require('./settings-handlers');
const { registerPtyHandlers } = require('./pty-handlers');

const DEFAULT_HANDLERS = [
  registerSdkHandlers,
  registerSdkV2Handlers,
  registerMcpHandlers,
  registerMcpAutoconfigHandlers,
  registerTestExecutionHandlers,
  registerPrecommitHandlers,
  registerTestNotificationHandlers,
  registerMessageQueueHandlers,
  registerApiDocsHandlers,
  registerPerfAuditHandlers,
  registerErrorHandlers,
  registerStateHandlers,
  registerSharedContextHandlers,
  registerFrictionHandlers,
  registerScreenshotHandlers,
  registerProjectHandlers,
  registerSmartRoutingHandlers,
  registerAutoHandoffHandlers,
  registerConflictQueueHandlers,
  registerLearningDataHandlers,
  registerOutputValidationHandlers,
  registerCompletionQualityHandlers,
  registerCheckpointHandlers,
  registerActivityLogHandlers,
  registerAutoNudgeHandlers,
  registerCompletionDetectionHandlers,
  registerAgentClaimsHandlers,
  registerSessionSummaryHandlers,
  registerPerformanceTrackingHandlers,
  registerTemplateHandlers,
  registerProcessHandlers,
  registerUsageStatsHandlers,
  registerSessionHistoryHandlers,
  registerConflictDetectionHandlers,
  registerSettingsHandlers,
  registerPtyHandlers,
];

function registerAllHandlers(registry, handlers = DEFAULT_HANDLERS) {
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('registerAllHandlers requires a registry with register()');
  }
  for (const handler of handlers) {
    registry.register(handler);
  }
}

module.exports = { registerAllHandlers, DEFAULT_HANDLERS };
