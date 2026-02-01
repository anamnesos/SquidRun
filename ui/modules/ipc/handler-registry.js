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
const { registerAgentMetricsHandlers } = require('./agent-metrics-handlers');
const { registerOutputValidationHandlers } = require('./output-validation-handlers');
const { registerCompletionQualityHandlers } = require('./completion-quality-handlers');
const { registerCheckpointHandlers } = require('./checkpoint-handlers');
const { registerAutoNudgeHandlers } = require('./auto-nudge-handlers');
const { registerCompletionDetectionHandlers } = require('./completion-detection-handlers');
const { registerAgentClaimsHandlers } = require('./agent-claims-handlers');
const { registerSessionSummaryHandlers } = require('./session-summary-handlers');
const { registerTemplateHandlers } = require('./template-handlers');
const { registerSkillMarketplaceHandlers } = require('./skill-marketplace-handlers');
const { registerProcessHandlers } = require('./process-handlers');
const { registerSessionHistoryHandlers } = require('./session-history-handlers');
const { registerConflictDetectionHandlers } = require('./conflict-detection-handlers');
const { registerSettingsHandlers } = require('./settings-handlers');
const { registerExternalNotificationHandlers } = require('./external-notification-handlers');
const { registerPtyHandlers } = require('./pty-handlers');
const { registerGitHandlers } = require('./git-handlers');
const { registerKnowledgeHandlers } = require('./knowledge-handlers');
const { registerKnowledgeGraphHandlers } = require('./knowledge-graph-handlers');
const { registerDebugReplayHandlers } = require('./debug-replay-handlers');
const { registerTaskParserHandlers } = require('./task-parser-handlers');
const { registerSchedulerHandlers } = require('./scheduler-handlers');
const { registerRecoveryHandlers } = require('./recovery-handlers');
const { registerCodeReviewHandlers } = require('./code-review-handlers');
const { registerDocGeneratorHandlers } = require('./doc-generator-handlers');
const { registerPluginHandlers } = require('./plugin-handlers');
const { registerBackupHandlers } = require('./backup-handlers');
const { registerResourceHandlers } = require('./resource-handlers');
const { registerScaffoldingHandlers } = require('./scaffolding-handlers');
const { registerAgentSharingHandlers } = require('./agent-sharing-handlers');
const { registerWorkflowHandlers } = require('./workflow-handlers');
const { registerTaskPoolHandlers } = require('./task-pool-handlers');
const { registerOracleHandlers } = require('./oracle-handlers');
const { registerModelSwitchHandlers } = require('./model-switch-handlers');

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
  registerAgentMetricsHandlers,
  registerOutputValidationHandlers,
  registerCompletionQualityHandlers,
  registerCheckpointHandlers,
  registerAutoNudgeHandlers,
  registerCompletionDetectionHandlers,
  registerAgentClaimsHandlers,
  registerSessionSummaryHandlers,
  registerTemplateHandlers,
  registerSkillMarketplaceHandlers,
  registerProcessHandlers,
  registerSessionHistoryHandlers,
  registerConflictDetectionHandlers,
  registerSettingsHandlers,
  registerExternalNotificationHandlers,
  registerPtyHandlers,
  registerGitHandlers,
  registerKnowledgeHandlers,
  registerKnowledgeGraphHandlers,
  registerDebugReplayHandlers,
  registerTaskParserHandlers,
  registerSchedulerHandlers,
  registerRecoveryHandlers,
  registerCodeReviewHandlers,
  registerDocGeneratorHandlers,
  registerPluginHandlers,
  registerBackupHandlers,
  registerResourceHandlers,
  registerScaffoldingHandlers,
  registerAgentSharingHandlers,
  registerWorkflowHandlers,
  registerTaskPoolHandlers,
  registerOracleHandlers,
  registerModelSwitchHandlers,
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
