const { registerMcpHandlers } = require('./mcp-handlers');
const { registerMcpAutoconfigHandlers } = require('./mcp-autoconfig-handlers');
const { registerTestExecutionHandlers } = require('./test-execution-handlers');
const { registerPrecommitHandlers } = require('./precommit-handlers');
const { registerTestNotificationHandlers } = require('./test-notification-handlers');
const { registerMessageQueueHandlers } = require('./message-queue-handlers');
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
const { registerPluginHandlers } = require('./plugin-handlers');
const { registerBackupHandlers } = require('./backup-handlers');
const { registerResourceHandlers } = require('./resource-handlers');
const { registerWorkflowHandlers } = require('./workflow-handlers');
const { registerTaskPoolHandlers } = require('./task-pool-handlers');
const { registerOracleHandlers } = require('./oracle-handlers');
const { registerModelSwitchHandlers } = require('./model-switch-handlers');
const { registerOrganicUIHandlers } = require('./organic-ui-handlers');
const { registerDocGeneratorHandlers } = require('./doc-generator-handlers');
const { registerWhisperHandlers } = require('./whisper-handlers');
const { registerEvidenceLedgerHandlers } = require('./evidence-ledger-handlers');
const { registerContractPromotionHandlers } = require('./contract-promotion-handlers');
const { registerTeamMemoryHandlers } = require('./team-memory-handlers');

const DEFAULT_HANDLERS = [
  registerMcpHandlers,
  registerMcpAutoconfigHandlers,
  registerTestExecutionHandlers,
  registerPrecommitHandlers,
  registerTestNotificationHandlers,
  registerMessageQueueHandlers,
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
  registerPluginHandlers,
  registerBackupHandlers,
  registerResourceHandlers,
  registerWorkflowHandlers,
  registerTaskPoolHandlers,
  registerOracleHandlers,
  registerModelSwitchHandlers,
  registerOrganicUIHandlers,
  registerDocGeneratorHandlers,
  registerWhisperHandlers,
  registerEvidenceLedgerHandlers,
  registerContractPromotionHandlers,
  registerTeamMemoryHandlers,
];

function registerAllHandlers(registry, handlers = DEFAULT_HANDLERS) {
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('registerAllHandlers requires a registry with register()');
  }
  for (const handler of handlers) {
    registry.register(handler);
  }
}

function unregisterAllHandlers(registry, ctx, deps) {
  if (!registry || typeof registry.unsetup !== 'function') {
    return;
  }
  registry.unsetup(ctx, deps);
}

function setupAllHandlers(registry, ctx, deps) {
  if (!registry || typeof registry.setup !== 'function') {
    throw new Error('setupAllHandlers requires a registry with setup()');
  }

  // Ensure we remove old ipcMain handlers/listeners before re-registering.
  unregisterAllHandlers(registry, ctx, deps);
  registry.setup(ctx, deps);
}

module.exports = {
  registerAllHandlers,
  unregisterAllHandlers,
  setupAllHandlers,
  DEFAULT_HANDLERS,
};
