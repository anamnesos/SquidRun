# ARCHITECTURE

## 1) APP OVERVIEW
SquidRun is an Electron desktop app that runs a 3-pane, multi-model agent team (Architect, Builder, Oracle) in parallel. The main process orchestrates pane lifecycle, messaging, persistence, and runtime services; renderers and hidden pane hosts provide the terminal UX and agent I/O path. Agent-to-agent coordination is driven by WebSocket messaging (`hm-send.js`) with trigger-file fallback for resilience.

## 2) PROCESS MODEL
1. `ui/main.js` starts Electron, enforces single-instance lock, installs global error handlers, builds managers, and calls `SquidRunApp.init()`.
2. `ui/modules/main/squidrun-app.js` loads settings, creates the main BrowserWindow, runs firmware/CLI identity startup work, sets session scope, and starts WebSocket + runtime services.
3. Main window preload (`ui/preload.js`) exposes safe bridge APIs to renderer (`window.squidrun` / `window.squidrunAPI`) under context isolation.
4. Hidden pane hosts are created by `ui/modules/main/pane-host-window-manager.js` as offscreen BrowserWindows (`pane-host.html`) for robust PTY injection and delivery acknowledgements.
5. PTY runtime is managed by daemon client (`ui/daemon-client.js`) connecting to `ui/terminal-daemon.js`; panes attach through renderer/hidden-host bridges.
6. Watchers (`ui/modules/watcher.js` + `ui/modules/watcher-worker.js`) monitor workspace/trigger/message paths and route payloads through `ui/modules/triggers.js`.
7. IPC handlers are registered via `ui/modules/ipc-handlers.js` + `ui/modules/ipc/handler-registry.js`; websocket dispatch uses `ui/modules/websocket-server.js` / `ui/modules/websocket-runtime.js`.
8. `ui/supervisor-daemon.js` runs a user-session durable background supervisor backed by SQLite for queued async work; it survives UI closure and writes PID/status/task logs under `.squidrun/runtime/`.
9. Startup and coordination state is continuously materialized into `.squidrun/` (status, handoffs, snapshots, runtime ledgers).

## 3) KEY FILE MAP
- ui/config.js: Shared runtime constants and path resolution (project root, coord root, pane cwd, trigger targets, role maps).
- ui/daemon-client.js: Electron-side daemon client for PTY lifecycle, reconnect logic, write-ack tracking, and kernel event forwarding.
- ui/index.html: Main renderer shell (3-pane layout, broadcast input, settings panel, right tabs, and startup overlays).
- ui/jsconfig.json: Scoped JavaScript type-check configuration for the first-stage JSDoc + `checkJs` gate (`tsc --noEmit`) over selected contract-heavy modules.
- ui/pane-host.html: Hidden pane-host window document that mounts xterm and loads `pane-host-renderer.js`.
- ui/pane-host-renderer.js: Hidden pane PTY bridge that injects messages, dispatches Enter, and reports delivery ack/outcome to main.
- ui/preload.js: Context-isolated bridge bootstrap exposing `window.squidrun` / `window.squidrunAPI` and renderer module adapters.
- ui/renderer.js: Main renderer entrypoint wiring terminals, IPC listeners, settings/tabs, pane controls, and command dispatch UX.
- ui/styles/base.css: Design-system base stylesheet (tokens, resets, global UX primitives, context-menu styling, and motion/accessibility rules).
- ui/terminal-daemon.js: Detached PTY daemon process that owns terminal sessions, transport protocol handling, and daemon-side event kernel.
- ui/modules/agent-templates.js: Built-in agent templates library Provides curated configurations for common team setups.
- ui/modules/backup-manager.js: Backup Manager Automated backups of .squidrun/config/state with restore points and versioning.
- ui/modules/bridge/channel-policy.js: Exports INVOKE_CHANNELS, SEND_CHANNELS, ON_CHANNELS, DYNAMIC_ON_CHANNEL_PATTERNS, ....
- ui/modules/bridge/preload-api.js: Exports createPreloadApi.
- ui/modules/bridge/renderer-modules.js: Exports createRendererModules.
- ui/modules/bridge/safe-ipc.js: Exports createSafeIpc.
- ui/modules/buffered-file-writer.js: Exports createBufferedFileWriter.
- ui/modules/codex-utils.js: Exports hasCodexDangerouslyBypassFlag, hasCodexAskForApprovalFlag.
- ui/modules/command-palette.js: Exports initCommandPalette.
- ui/modules/comms-worker-client.js: Exports start, stop, isRunning, getPort, ....
- ui/modules/comms-worker.js: Child-process worker entrypoint for async runtime tasks.
- ui/modules/comms/message-envelope.js: Exports ENVELOPE_VERSION, buildOutboundMessageEnvelope, buildCanonicalEnvelopeMetadata, buildWebSocketDispatchMessage, ....
- ui/modules/compaction-detector.js: Exports init, processChunk, getState, reset, ....
- ui/modules/cognitive-memory-api.js: Lease-backed cognitive memory API for ingest, retrieve, patch, salience updates, transactive expertise lookup, and runtime IPC/websocket access over the cognitive memory store/search index.
- ui/modules/cognitive-memory-immunity.js: Behavioral immunity layer that stages post-task heuristics and promotes matched failure->success corrections into immune cognitive-memory nodes.
- ui/modules/constants.js: Exports BYPASS_CLEAR_DELAY_MS, BUTTON_DEBOUNCE_MS, SPINNER_INTERVAL_MS, UI_IDLE_THRESHOLD_MS, ....
- ui/modules/context-compressor.js: Exports init, generateSnapshot, refreshAll, refresh, ....
- ui/modules/contract-promotion-service.js: Exports ACTIONS, normalizeAction, getContractStatsSnapshot, approvePromotion, ....
- ui/modules/contract-promotion.js: Exports init, saveStats, syncStatsFromDisk, checkPromotions, ....
- ui/modules/contracts.js: Exports init, CONTRACTS, SHADOW_CONTRACTS, ENFORCED_CONTRACTS, ....
- ui/modules/daemon-handlers.js: Exports setStatusCallbacks, teardownDaemonListeners, setupDaemonListeners, setupSyncIndicator, ....
- ui/modules/diagnostic-log.js: Exports write, _flushForTesting, flush, LOG_PATH, ....
- ui/modules/event-bus.js: Exports emit, ingest, on, off, ....
- ui/modules/experiment/index.js: Exports initializeExperimentRuntime, executeExperimentOperation, closeExperimentRuntime, createExperimentRuntime, ....
- ui/modules/experiment/profiles.js: Exports DEFAULT_PROFILES_PATH, resolveDefaultProfilesPath.
- ui/modules/experiment/runtime.js: Exports ExperimentRuntime, createExperimentRuntime, initializeExperimentRuntime, executeExperimentOperation, ....
- ui/modules/experiment/worker-client.js: Exports initializeRuntime, executeOperation, closeRuntime, resetForTests, ....
- ui/modules/experiment/worker.js: Child-process worker entrypoint for async runtime tasks.
- ui/modules/external-notifications.js: Exports createExternalNotifier.
- ui/modules/feature-capabilities.js: Exports getFeatureCapabilities, hasKey.
- ui/modules/formatters.js: Exports formatDuration, formatTimeSince, formatShort, formatCompound, ....
- ui/modules/image-gen.js: Exports generateImage, removeHistoryEntryByPath, resolveProvider, detectImageExt, ....
- ui/modules/ipc-handlers.js: Exports init, setDaemonClient, setExternalNotifier, setupIPCHandlers, ....
- ui/modules/ipc/agent-claims-handlers.js: Registers IPC channels (claim-agent, release-agent, get-claims, ...).
- ui/modules/ipc/agent-metrics-handlers.js: Registers IPC channels (record-completion, record-error, record-response-time, ...).
- ui/modules/ipc/auto-handoff-handlers.js: Registers IPC channels (trigger-handoff, get-handoff-chain).
- ui/modules/ipc/auto-nudge-handlers.js: Registers IPC channels (get-agent-health, nudge-pane, restart-pane, ...).
- ui/modules/ipc/background-processes.js: Tracks background child processes, broadcasts process state to renderer, and terminates running processes on cleanup.
- ui/modules/ipc/backup-handlers.js: Registers IPC channels (backup-list, backup-create, backup-restore, ...).
- ui/modules/ipc/checkpoint-handlers.js: Registers IPC channels (create-checkpoint, list-checkpoints, get-checkpoint-diff, ...).
- ui/modules/ipc/completion-detection-handlers.js: Registers IPC channels (check-completion, get-completion-patterns) and fires non-blocking post-task immunity extraction on completion/handoff signals.
- ui/modules/ipc/completion-quality-handlers.js: Registers IPC channels (check-completion-quality, validate-state-transition, get-quality-rules, ...).
- ui/modules/ipc/conflict-detection-handlers.js: Registers IPC channels (get-file-conflicts, check-file-conflicts).
- ui/modules/ipc/contract-promotion-handlers.js: Exports registerContractPromotionHandlers, unregisterContractPromotionHandlers, CONTRACT_PROMOTION_CHANNEL_ACTIONS.
- ui/modules/ipc/cognitive-memory-handlers.js: Exports COGNITIVE_MEMORY_CHANNELS, executeCognitiveMemoryOperation, registerCognitiveMemoryHandlers, unregisterCognitiveMemoryHandlers, closeSharedCognitiveMemoryRuntime.
- ui/modules/ipc/debug-replay-handlers.js: Registers IPC channels (debug-load-session, debug-load-timerange, debug-step-forward, ...).
- ui/modules/ipc/device-pairing-handlers.js: Registers IPC channels (bridge:get-devices, bridge:get-status, bridge:get-pairing-state, bridge:pairing-init, bridge:pairing-join).
- ui/modules/ipc/error-handlers.js: Registers IPC channels (get-error-message, show-error-toast, list-error-codes, ...).
- ui/modules/ipc/evidence-ledger-handlers.js: Exports registerEvidenceLedgerHandlers, unregisterEvidenceLedgerHandlers, createEvidenceLedgerRuntime, initializeEvidenceLedgerRuntime, ....
- ui/modules/ipc/evidence-ledger-runtime.js: Exports createEvidenceLedgerRuntime, initializeEvidenceLedgerRuntime, executeEvidenceLedgerOperation, closeSharedRuntime, ....
- ui/modules/ipc/evidence-ledger-worker-client.js: Exports initializeRuntime, executeOperation, closeRuntime, resetForTests, ....
- ui/modules/ipc/evidence-ledger-worker.js: Child-process worker entrypoint for async runtime tasks.
- ui/modules/ipc/external-notification-handlers.js: Registers IPC channels (notify-external-test).
- ui/modules/ipc/friction-handlers.js: Registers IPC channels (list-friction, read-friction, delete-friction, ...).
- ui/modules/ipc/git-handlers.js: Registers IPC channels (git-status, git-diff, git-log, ...).
- ui/modules/ipc/github-handlers.js: Exports GITHUB_CHANNEL_ACTIONS, executeGitHubOperation, registerGitHubHandlers, unregisterGitHubHandlers, ....
- ui/modules/ipc/handler-registry.js: Exports registerAllHandlers, unregisterAllHandlers, setupAllHandlers, DEFAULT_HANDLERS, ....
- ui/modules/ipc/index.js: Exports createIpcContext, createIpcRegistry, DEFAULT_STATE_KEYS.
- ui/modules/ipc/ipc-state.js: Exports state, initState, setDaemonClient.
- ui/modules/ipc/knowledge-graph-handlers.js: Registers IPC channels (graph-query, graph-visualize, graph-stats, ...).
- ui/modules/ipc/knowledge-handlers.js: Registers IPC channels (knowledge-ingest, knowledge-search, knowledge-stats, ...).
- ui/modules/ipc/mcp-autoconfig-handlers.js: Registers IPC channels (mcp-configure-agent, mcp-reconnect-agent, mcp-remove-agent-config, ...).
- ui/modules/ipc/mcp-handlers.js: Registers IPC channels (mcp-register-agent, mcp-unregister-agent, mcp-get-connected-agents, ...).
- ui/modules/ipc/message-queue-handlers.js: Registers IPC channels (init-message-queue, send-message, send-broadcast-message, ...).
- ui/modules/ipc/model-switch-handlers.js: Registers IPC channels (get-pane-commands, switch-pane-model).
- ui/modules/ipc/oracle-handlers.js: Registers IPC channels (oracle:generateImage, oracle:deleteImage, oracle:listImages, ...).
- ui/modules/ipc/organic-ui-handlers.js: Registers IPC channels (organic:get-agent-states, organic:get-agent-state, organic:set-agent-state, ...).
- ui/modules/ipc/output-validation-handlers.js: Registers IPC channels (validate-output, validate-file, get-validation-patterns, ...).
- ui/modules/ipc/perf-audit-handlers.js: Registers IPC channels (get-perf-profile, set-perf-enabled, set-slow-threshold, ...).
- ui/modules/ipc/plugin-handlers.js: Registers IPC channels (list-plugins, enable-plugin, disable-plugin, ...).
- ui/modules/ipc/preflight-handlers.js: Registers IPC channels (run-preflight-check) and executes startup health checks (env, CLIs, relay reachability, workspace writeability, system Node version).
- ui/modules/ipc/precommit-handlers.js: Registers IPC channels (run-pre-commit-checks, get-ci-status, set-ci-enabled, ...).
- ui/modules/ipc/process-handlers.js: Registers IPC channels (spawn-process, list-processes, kill-process, ...).
- ui/modules/ipc/project-handlers.js: Registers IPC channels (select-project, get-project, get-recent-projects, ...).
- ui/modules/ipc/pty-handlers.js: Registers IPC channels (pty-create, pty-write, pty-write-chunked, ...).
- ui/modules/ipc/recovery-handlers.js: Registers IPC channels (get-recovery-status, get-health-snapshot, get-recovery-playbooks, ...).
- ui/modules/ipc/resource-handlers.js: Registers IPC channels (resource:get-usage).
- ui/modules/ipc/scheduler-handlers.js: Registers IPC channels (get-schedules, add-schedule, update-schedule, ...).
- ui/modules/ipc/screenshot-handlers.js: Registers IPC channels (capture-screenshot, save-screenshot, list-screenshots, ...).
- ui/modules/ipc/session-history-handlers.js: Registers IPC channels (get-session-history).
- ui/modules/ipc/session-summary-handlers.js: Registers IPC channels (save-session-summary, get-session-summaries, get-latest-summary, ...).
- ui/modules/ipc/settings-handlers.js: Registers IPC channels (get-settings, set-setting, get-all-settings, ...).
- ui/modules/ipc/shared-context-handlers.js: Registers IPC channels (read-shared-context, write-shared-context, get-shared-context-path, ...).
- ui/modules/ipc/smart-routing-handlers.js: Registers IPC channels (route-task, get-best-agent, get-agent-roles, ...).
- ui/modules/ipc/state-handlers.js: Registers IPC channels (get-state, set-state, trigger-sync, ...).
- ui/modules/ipc/task-parser-handlers.js: Registers IPC channels (parse-task-input, route-task-input).
- ui/modules/ipc/task-pool-handlers.js: Registers IPC channels (get-task-list, claim-task, update-task-status, ...).
- ui/modules/ipc/team-memory-handlers.js: Exports TEAM_MEMORY_CHANNELS, registerTeamMemoryHandlers, unregisterTeamMemoryHandlers.
- ui/modules/ipc/template-handlers.js: Registers IPC channels (save-template, load-template, list-templates, ...).
- ui/modules/ipc/test-execution-handlers.js: Registers IPC channels (detect-test-framework, run-tests, get-test-results, ...).
- ui/modules/ipc/test-notification-handlers.js: Registers IPC channels (notify-test-failure, get-test-notification-settings, set-test-notification-settings, ...).
- ui/modules/ipc/transition-ledger-handlers.js: Exports TRANSITION_LEDGER_CHANNEL_ACTIONS, executeTransitionLedgerOperation, registerTransitionLedgerHandlers, unregisterTransitionLedgerHandlers, ....
- ui/modules/ipc/user-profile-handlers.js: Registers IPC channels (get-user-profile, save-user-profile).
- ui/modules/ipc/whisper-handlers.js: Registers IPC channels (voice:transcribe).
- ui/modules/ipc/workflow-handlers.js: Registers IPC channels (workflow-list, workflow-save, workflow-load, ...).
- ui/modules/knowledge-base.js: Exports KnowledgeBase.
- ui/modules/knowledge/knowledge-graph-service.js: Exports initialize, queryGraph, getGraphVisualization, getGraphStats, ....
- ui/modules/knowledge/knowledge-graph-store.js: Exports NODE_TYPES, EDGE_TYPES, initialize, save, ....
- ui/modules/local-embedder.js: Local embeddings via Python sentence-transformers subprocess.
- ui/modules/logger.js: Exports logger.
- ui/modules/main/activity-manager.js: Exports ActivityManager.
- ui/modules/main/app-context.js: Exports new.
- ui/modules/main/auto-handoff-materializer.js: Exports materializeSessionHandoff, buildSessionHandoffMarkdown, removeLegacyPaneHandoffFiles, _internals, ....
- ui/modules/main/background-agent-manager.js: Exports BackgroundAgentManager, createBackgroundAgentManager, containsCompletionSignal, appendCompletionDirective, ....
- ui/modules/main/cli-identity.js: Exports CliIdentityManager.
- ui/modules/main/comms-journal.js: Exports appendCommsJournalEntry, queryCommsJournalEntries, closeCommsJournalStores, resolveDefaultEvidenceLedgerDbPath, ....
- ui/modules/main/evidence-ledger-ingest.js: Exports REQUIRED_FIELDS, normalizeEnvelope, validateEnvelope, buildEdgeRows, ....
- ui/modules/main/evidence-ledger-investigator.js: Exports EvidenceLedgerInvestigator.
- ui/modules/main/evidence-ledger-memory-seed.js: Exports stableId, deriveSeedRecords, seedDecisionMemory.
- ui/modules/main/evidence-ledger-memory.js: Exports EvidenceLedgerMemory, DECISION_CATEGORIES, DECISION_STATUSES, DECISION_AUTHORS, ....
- ui/modules/main/evidence-ledger-store.js: Exports EvidenceLedgerStore, DEFAULT_DB_PATH, resolveDefaultDbPath, DEFAULT_MAX_ROWS, ....
- ui/modules/main/firmware-manager.js: Exports FirmwareManager.
- ui/modules/main/github-service.js: Exports createGitHubService, execAsync, toGhError.
- ui/modules/main/kernel-bridge.js: Exports KernelBridge, createKernelBridge, BRIDGE_VERSION, BRIDGE_EVENT_CHANNEL, ....
- ui/modules/main/pane-control-service.js: Exports executePaneControlAction, detectPaneModel, normalizeAction.
- ui/modules/main/pane-host-window-manager.js: Creates/manages hidden pane-host BrowserWindows and routes bridge messages into pane-host renderers.
- ui/modules/main/settings-manager.js: Exports SettingsManager.
- ui/modules/main/squidrun-app.js: Registers IPC channels (pane-host-ready, pane-host-inject, pane-host-dispatch-enter, ...).
- ui/modules/memory-consistency-check.js: On-demand drift checker that compares `workspace/knowledge/` chunks against knowledge-backed nodes in `workspace/memory/cognitive-memory.db`.
- ui/modules/memory-ingest/delivery.js: Proactive memory delivery engine (trigger matching, injection budgets, handoff packets, and compaction survival persistence).
- ui/modules/memory-ingest/journal.js: Shared ingest journal / retry queue / dedupe state backing Phases 1-4 of the memory contract.
- ui/modules/memory-ingest/lifecycle.js: Session-based lifecycle advancement for memory objects (stale/archive/reactivation review flows).
- ui/modules/memory-ingest/promotion.js: Promotion target resolution and canonical knowledge-file patch application helpers.
- ui/modules/memory-ingest/router.js: Tier-routing logic that classifies incoming memory payloads before ingest/promotion.
- ui/modules/memory-ingest/schema.js: Shared schema/constants for memory-ingest statuses, tiers, and validation rules.
- ui/modules/memory-ingest/service.js: Canonical ingest + recovery service handling crash-safe routing, compaction locks, replay, and Tier 4 override notes.
- ui/modules/memory-ingest/shutdown-marker.js: Crash/restart coordination helper for marking interrupted ingest runtime shutdowns.
- ui/modules/main/usage-manager.js: Exports UsageManager.
- ui/modules/mcp-bridge.js: Exports MC5, registerAgent, unregisterAgent, heartbeat, ....
- ui/modules/model-selector.js: Exports initModelSelectors, setupModelSelectorListeners, setupModelChangeListener, setPaneCliAttribute, ....
- ui/modules/notifications.js: Exports showNotification, showToast, showStatusNotice, DEFAULT_TOAST_TIMEOUT, ....
- ui/modules/performance-data.js: Exports DEFAULT_PERFORMANCE, createDefaultPerformance, createPerformanceLoader.
- ui/modules/pipeline.js: Exports init, setMainWindow, onMessage, markCommitted, ....
- ui/modules/plugins/index.js: Plugin-module entrypoint that re-exports `createPluginManager`.
- ui/modules/plugins/plugin-manager.js: Plugin Manager Loads plugin manifests, manages lifecycle, and dispatches hook events.
- ui/modules/recovery-manager.js: Self-Healing Recovery Manager Detects stuck/failed agents, restarts with backoff, and enforces circuit breakers.
- ui/modules/renderer-bridge.js: Exports resolveBridgeApi, invokeBridge, sendBridge, onBridge, ....
- ui/modules/renderer-ipc-registry.js: Exports registerScopedIpcListener, clearScopedIpcListeners.
- ui/modules/replay/debug-replay.js: Exports loadSession, loadTimeRangeSession, exportSession, stepForward, ....
- ui/modules/scheduler.js: Exports createScheduler, matchesCron, computeNextRun.
- ui/modules/settings.js: Exports setConnectionStatusCallback, setSettingsLoadedCallback, loadSettings, applySettingsToUI, ....
- ui/modules/shared-state.js: Exports init, getState, getChangesSince, getChangelogForPane, ....
- ui/modules/smart-routing.js: Exports getBestAgent, inferTaskType, scoreAgents.
- ui/modules/sms-poller.js: Exports start, stop, isRunning, _internals, ....
- ui/modules/status-strip.js: Exports initStatusStrip, shutdownStatusStrip.
- ui/modules/tabs.js: Exports setConnectionStatusCallback, togglePanel, isPanelOpen, switchTab, .... Manages the existing right-side tabbed utility panel (bridge, screenshots, comms, oracle, api-keys).
- ui/modules/tabs/activity.js: Exports setupActivityTab, destroyActivityTab, addActivityEntry.
- ui/modules/tabs/api-keys.js: Exports setupApiKeysTab, destroyApiKeysTab, loadApiKeys.
- ui/modules/tabs/bridge.js: Exports setupBridgeTab. Renders the existing Bridge tab in the right-side panel and hydrates relay health from `bridge:get-status` plus live kernel bridge events.
- ui/modules/tabs/comms-console.js: Exports setupCommsConsoleTab, destroy. The existing Comms tab backfills `comms_journal`, correlates live `comms.*` events by `messageId`, and surfaces delivery status/attempt/error metadata for external channels.
- ui/modules/tabs/git.js: Exports setupGitTab, destroyGitTab.
- ui/modules/tabs/oracle.js: Exports setupOracleTab, destroyOracleTab, applyImageGenCapability.
- ui/modules/tabs/screenshots.js: Exports setupScreenshots, destroyScreenshots, loadScreenshots.
- ui/modules/tabs/utils.js: Exports escapeHtml.
- ui/modules/task-parser.js: Exports parseTaskInput.
- ui/modules/team-memory/backfill.js: Exports runBackfill, buildBackfillRecord, resolveDefaultEvidenceLedgerDbPath.
- ui/modules/team-memory/claims.js: Exports TeamMemoryClaims, CLAIM_TYPES, CLAIM_STATUS, CONSENSUS_POSITIONS, ....
- ui/modules/team-memory/comms-tagged-extractor.js: Exports TAG_RULES, extractTaggedItems, buildTaggedClaimRecord, extractTaggedClaimsFromComms, ....
- ui/modules/team-memory/daily-integration.js: Exports roleFromPaneId, normalizeDomain, deriveTaskScopes, buildReadBeforeWorkQueryPayloads, ....
- ui/modules/team-memory/guards.js: Exports TeamMemoryGuards, GUARD_ACTIONS.
- ui/modules/team-memory/index.js: Exports initializeTeamMemoryRuntime, executeTeamMemoryOperation, runBackfill, runIntegrityCheck, ....
- ui/modules/team-memory/integrity-checker.js: Exports scanOrphanedEvidenceRefs, repairOrphanedEvidenceRefs, upsertIntegrityReport, resolveDefaultEvidenceLedgerDbPath, ....
- ui/modules/team-memory/migrations.js: Exports MIGRATIONS, runMigrations.
- ui/modules/team-memory/migrations/001-initial-schema.js: Exports version, description, schema, sql, ....
- ui/modules/team-memory/migrations/002-phase1-compat.js: Exports version, description, patch, up, ....
- ui/modules/team-memory/migrations/003-phase2-search.js: Exports version, description, index, up, ....
- ui/modules/team-memory/migrations/004-phase4-patterns.js: Exports version, description, up.
- ui/modules/team-memory/migrations/005-phase5-guards.js: Exports version, description, up.
- ui/modules/team-memory/migrations/006-phase6-experiments.js: Exports version, description, up.
- ui/modules/team-memory/migrations/007-phase6b-pending-proof.js: Exports version, description, up.
- ui/modules/team-memory/migrations/008-phase6c-contradiction-resolution.js: Exports version, description, up.
- ui/modules/team-memory/patterns.js: Exports TeamMemoryPatterns, DEFAULT_PATTERN_SPOOL_PATH, resolveDefaultPatternSpoolPath.
- ui/modules/team-memory/runtime.js: Exports createTeamMemoryRuntime, initializeTeamMemoryRuntime, executeTeamMemoryOperation, closeSharedRuntime, ....
- ui/modules/team-memory/store.js: Exports TeamMemoryStore, DEFAULT_DB_PATH, resolveDefaultDbPath, loadSqliteDriver, ....
- ui/modules/team-memory/worker-client.js: Exports initializeRuntime, executeOperation, closeRuntime, resetForTests, ....
- ui/modules/team-memory/worker.js: Child-process worker entrypoint for async runtime tasks.
- ui/modules/telegram-poller.js: Exports start, stop, isRunning, _internals, ....
- ui/modules/terminal.js: Exports PANE_IDS, terminals, fitAddons, setStatusCallbacks, ....
- ui/modules/terminal/agent-colors.js: Exports attachAgentColors, AGENT_COLORS.
- ui/modules/terminal/injection.js: Terminal injection helpers Extracted from terminal.js to isolate fragile send/verify logic.
- ui/modules/terminal/recovery.js: Terminal recovery helpers (unstick, restart, sweeper) Extracted from terminal.js to isolate recovery logic.
- ui/modules/trading/broker-adapter.js: Unified trading-broker factory that presents the common account/positions/orders/snapshots/news interface used by the trading stack and dispatches requests to PaperBroker or [private-live-ops] implementations.
- ui/modules/trading/data-ingestion.js: Trading data access layer for market clock/calendar, watchlist snapshots, bars, news, SEC filings, and Yahoo fallbacks; now broker-routes watchlist snapshot/news fetches so PaperBroker and [private-live-ops] symbols can coexist in the same run.
- ui/modules/trading/executor.js: Broker-routed order execution and account/position access layer that preserves the PaperBroker flow while delegating [private-live-ops] orders and liquidation/account reads through the shared broker adapter.
- ui/modules/trading/ibkr-client.js: [private-live-ops] client wrapper built on `@stoqey/ib`; handles env-based connection config, account summary reads, positions, stock order submission, market-data snapshots, and a unified [private-live-ops] broker surface for Asian-market routing.
- ui/modules/trading/orchestrator.js: Phase coordinator for the autonomous trading workflow; stores per-ticker agent signals, auto-backfills missing Architect/Builder/Oracle signals from the live signal producer during premarket/consensus, runs consensus/risk gating, executes market-open and midday actions, journals end-of-day summaries, and chains the full trading-day loop.
- ui/modules/trading/polymarket-client.js: LiveOps CLOB wrapper for Rabby/EOA authentication, L2 API-key derivation, market discovery pagination, order-book and price reads, dry-run-first GTC order placement, and wallet balance/open-position access over Polygon USDC.e.
- ui/modules/trading/polymarket-scanner.js: LiveOps market scanner that filters binary markets by liquidity, spread, category, and 1-90 day resolution horizon, then ranks candidates by consensus-vs-market edge for downstream signal and sizing modules.
- ui/modules/trading/polymarket-signals.js: LiveOps probability-signal layer that produces deterministic per-agent yes/no estimates from scanner context and aggregates them with a 2-of-3, confidence-weighted edge consensus.
- ui/modules/trading/signal-producer.js: Live market-data signal generator for trading agents; fetches broker-routed watchlist snapshots, 5-day bars, and routed news, scores momentum/news/volume with agent-specific weighting, and returns/registers BUY/SELL/HOLD signals for the orchestrator.
- ui/modules/trading/watchlist.js: Watchlist registry for the autonomous trading stack; now stores normalized ticker metadata including broker and exchange so PaperBroker and [private-live-ops] assets can share the same consensus pipeline.
- ui/modules/token-utils.js: Exports estimateTokens, truncateToTokenBudget.
- ui/modules/transition-ledger.js: Exports init, stop, reset, getTransition, ....
- ui/modules/triggers.js: Exports init, setSelfHealing, setPluginManager, setWatcher, ....
- ui/modules/triggers/metrics.js: Exports recordSent, recordDelivered, recordFailed, recordTimeout, ....
- ui/modules/triggers/routing.js: Exports setSharedState, routeTask, triggerAutoHandoff, formatAuxEvent, ....
- ui/modules/triggers/sequencing.js: Exports loadMessageState, saveMessageState, parseMessageSequence, isDuplicateMessage, ....
- ui/types/contracts.d.ts: Shared contract types used by JSDoc-annotated JS surfaces (message envelopes, IPC payloads, device pairing, cognitive memory, app status).
- ui/modules/ui-view.js: Exports PANE_IDS, PANE_ROLES, SYNC_FILES, flashPaneHeader, ....
- ui/modules/utils.js: Exports debounceButton, applyShortcutTooltips.
- ui/modules/utils/transcript-store.js: Exports TRANSCRIPTS_DIR, getDateString, getTranscriptPath, parseTranscriptLines, ....
- ui/modules/watcher-worker.js: File watcher worker process.
- ui/modules/watcher.js: Exports init, States, ACTIVE_AGENTS, CONTEXT_MESSAGES, ....
- ui/modules/websocket-runtime.js: Exports start, stop, isRunning, getPort, ....
- ui/modules/websocket-server.js: Exports start, stop, isRunning, getPort, ....
- ui/scripts/coverage-report.js: Prints coverage-summary breakdown (under 50%, 50-80%, and overall statement/branch/function/line percentages).
- ui/scripts/doc-lint.js: Lints `.squidrun/build/*.md` docs for active-item caps, required metadata fields, and stale-marker correctness.
- ui/scripts/evidence-ledger-seed-memory.js: Seeds Evidence Ledger decision memory from context snapshot markdown/JSON with deterministic IDs.
- ui/scripts/hm-bg.js: Background Builder control CLI; uses WebSocket for live PTY agents and the durable supervisor queue CLI for queued work.
- ui/scripts/hm-ci-check.js: CLI utility for reading the latest CI/pre-commit gate status used by review and release workflows.
- ui/scripts/hm-claim.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-comms.js: CLI utility that reads comms history from `.squidrun/runtime/evidence-ledger.db` via `node:sqlite`.
- ui/scripts/hm-compat-count.js: Utility script for compatibility/counting diagnostics used in release and audit workflows.
- ui/scripts/hm-doctor.js: Preflight health-check CLI for dependencies, native modules, transport port, shell defaults, and `.squidrun` permissions.
- ui/scripts/hm-experiment.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-github.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-hook-afteragent.js: Post-agent hook script for runtime follow-up after pane activity.
- ui/scripts/hm-hook-precompress.js: Pre-compaction hook that extracts/stages memory candidates before context compression.
- ui/scripts/hm-image-gen.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-investigate.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-memory-api.js: Cognitive memory CLI for direct node operations; supports `retrieve`, `ingest`, `patch`, `salience`, and `set-immune` over the cognitive-memory store.
- ui/scripts/hm-memory-consistency.js: On-demand CLI that reports drift between tracked knowledge markdown and knowledge-backed cognitive-memory nodes.
- ui/scripts/hm-memory-extract.js: Extracts memory candidates from runtime/session artifacts for staged promotion review.
- ui/scripts/hm-memory-index.js: Builds or refreshes the cognitive/vector memory index from workspace knowledge files.
- ui/scripts/hm-memory-ingest.js: Strict ingest CLI for canonical team-memory objects with promotion/review routing.
- ui/scripts/hm-memory-promote.js: Reviews pending memory promotion candidates and applies approved updates into tracked knowledge files.
- ui/scripts/hm-memory-registry.js: CLI for transactive memory registry updates and expertise tracking by domain/agent.
- ui/scripts/hm-memory-search.js: Queries the cognitive/vector memory index and returns ranked semantic matches.
- ui/scripts/hm-memory.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-pane.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-path-audit.js: Audits documented/runtime paths and path-safety constraints across the workspace.
- ui/scripts/hm-preflight.js: Scans protocol docs (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, `CODEX.md`) for potential coordination-rule conflicts.
- ui/scripts/hm-promotion.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-reddit.js: Exports parseArgs, getRedditConfig, getMissingConfigKeys, getAccessToken, ....
- ui/scripts/hm-screenshot-window.ps1: PowerShell helper script (window/screenshot automation).
- ui/scripts/hm-screenshot.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-search.js: Safe `rg` wrapper for Windows/PowerShell with optional glob filters and escaped-pattern default behavior.
- ui/scripts/hm-send.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-sms.js: Exports parseMessage, getTwilioConfig, getMissingConfigKeys, buildAuthHeader, ....
- ui/scripts/hm-surface-audit.js: UI/documentation surface audit helper used to check exposed commands and runtime-facing features.
- ui/scripts/hm-telegram.js: Exports parseMessage, getTelegramConfig, getMissingConfigKeys, requestTelegram, .... Outbound sends reuse caller-provided journal `messageId` when present so live comms events and evidence-ledger rows stay correlated.
- ui/scripts/hm-visual-capture.js: Playwright sidecar CLI for URL resolution/readiness checks and visual artifact bundle capture (screenshot, trace, console/request diagnostics, DOM/ARIA snapshot) with optional Telegram photo send.
- ui/scripts/hm-smoke-runner.js: Deterministic autonomous QA sidecar used by workflow-triggered smoke runs; captures screenshot/trace/DOM, axe-core a11y report, accessibility snapshot, DOM summary, link validation, before/after pixel diff artifacts (pixelmatch), failure debug packages (trace/screenshots/network summary/explanation), and assistive Playwright draft spec generation from successful runs.
- ui/scripts/hm-supervisor.js: CLI utility for supervisor queue inspection/enqueue/requeue against `.squidrun/runtime/supervisor.sqlite`.
- ui/scripts/hm-visual-utils.js: Shared helpers for hm-visual-capture URL candidate resolution (explicit/cache/heuristic), readiness probes, cache persistence, and artifact layout/writers.
- ui/scripts/hm-transition.js: CLI utility that sends/queries runtime actions via WebSocket.
- ui/scripts/hm-twitter.js: Exports parseArgs, getTwitterConfig, getMissingConfigKeys, percentEncode, ....
- ui/scripts/install-supervisor-task.ps1: PowerShell installer for registering the durable supervisor as a Windows scheduled task.
- ui/scripts/local_embedder.py: Python helper worker for local embeddings.
- ui/scripts/test-image-gen.js: Standalone diagnostic for Recraft/OpenAI image APIs with payload logging and variation testing.
- ui/modules/cognitive-memory-sleep.js: Exports SleepConsolidator, resolves sleep threshold configs, manages background semantic clustering, and auto-promotes matched supervisor failure->success antibodies into immune nodes.
- ui/modules/cognitive-memory-store.js: Cognitive memory vector and metadata store wrapper over sqlite-vec.
- ui/modules/memory-search.js: Hybrid FTS and sqlite-vec memory search index and chunking engine.
- ui/modules/supervisor/index.js: Supervisor module entrypoint.
- ui/modules/supervisor/store.js: SQLite-backed store for durable background supervisor tasks.
- ui/scripts/hm-health-snapshot.js: Startup pipeline script that captures codebase and system health for cognitive memory ingest, including the shared startup-health scoring contract (100-point base, threshold mapping, and probe penalties).

## 4) OUTER-LOOP CO[private-live-ops]NATOR MODEL (3-PANE + BACKGROUND)
- **Architect (Pane 1):** The outer-loop coordinator. Handles decomposition, review, and release gating (no direct implementation). Elevates the AI from individual workers to a management layer over native sub-agents.
- **Builder (Pane 2):** The working lead. Executes implementation and autonomously spawns up to 3 background agents (`builder-bg-1..3`) for parallel execution.
- **Oracle (Pane 3):** The high-level system monitor and vision-provider. Shifted from the old per-pane "Analyst" role to provide system-wide investigation, root-cause evidence, documentation, and benchmarks.
- Primary comms path: `node ui/scripts/hm-send.js <target> "(ROLE #N): ..."` sends WebSocket envelopes into the comms runtime.
- Fallback comms path: if WebSocket delivery is unverified/fails, `hm-send.js` writes `.squidrun/triggers/<role>.txt` atomically.
- Trigger/watch path: `ui/modules/watcher.js` watches trigger/message/workspace paths and calls `ui/modules/triggers.js` for routing and delivery tracking.
- PTY injection path: `ui/modules/main/squidrun-app.js` routes to hidden pane host first (`pane-host-inject`), with visible renderer fallback.
- Hidden pane host architecture: one hidden BrowserWindow per pane, with explicit ready/ack/outcome signaling to main process for delivery verification.

## 5) CROSS-DEVICE RELAY
- Topology: `Architect (Device A) <-> WebSocket Relay <-> Architect (Device B)`.
- Architect-only gate: cross-device relay targeting is restricted to `@<DEVICE>-architect`; role gate enforced in `ui/modules/main/squidrun-app.js` (around line 1900).
- Local routing model: Builder/Oracle never target external devices directly. Inbound cross-device payloads terminate at local Architect, which then routes to local Builder/Oracle via `hm-send.js`.
- Phase 4 handoffs: cross-device work transfer is carried as structured `HandoffPacket` relay metadata, journaled in `team-memory.sqlite`, and surfaced locally as Tier 4 continuation context.
- Bridge status is surfaced with an explicit operator mode (`disabled`, `connecting`, `connected`) layered over the lower-level relay state/status. Startup health and the Bridge tab treat `enabled + not connected` as a degraded condition without conflating it with intentional disablement.

## 5A) MEMORY DELIVERY
- Canonical memory ingest lands in `team-memory.sqlite` through `ui/modules/memory-ingest/service.js` and `ui/modules/memory-ingest/journal.js`, which guarantee durable envelopes before routing and replay pending writes after crashes or compaction locks.
- Proactive injection is resolved by `ui/modules/memory-ingest/delivery.js`: triggers (`error_signature_match`, `file_path_affinity`, `task_domain_match`, `session_rollover`, `user_preference_activation`) query routed memory objects, apply budgets/rank-down/suppression, and emit ephemeral Tier 4 assistive or authoritative notes into pane context.
- Delivery budgets are enforced per pane through `memory_injection_events` / `memory_injection_suppressions` (max 1 per trigger event, max 3 per 10 minutes unless explicit, rank-down after 2 unreferenced injections, dismissal suppression until context changes).
- Compaction survival persists pre-compact active-task notes plus Tier 3 extracted insights into `memory_compaction_survival`, then re-reads Tier 1 files from disk on resume before reinjecting the survival summary.

## 5B) COGNITIVE MEMORY (CURRENT RUNTIME STATE)
- Runtime access is live, not CLI-only: `ui/modules/ipc/cognitive-memory-handlers.js`, `ui/modules/bridge/preload-api.js`, and `ui/modules/main/squidrun-app.js` expose ingest/retrieve/patch/salience operations over IPC plus structured websocket routing.
- Retrieval scoring now applies bounded age decay in both `ui/modules/cognitive-memory-api.js` and `ui/modules/memory-search.js`, so older high-salience memories lose rank over time instead of permanently dominating fresh evidence.
- Retrieval access is tiered: exploratory reads update `last_accessed_at` / `access_count`, while repeated or explicit use reactivates recency. This prevents casual lookups from fully refreshing stale memories.
- `transactive_meta` is consulted during `retrieve()`. When expertise rows exist, the API returns additive transactive guidance (`matches`, `recommendedAgentId`) alongside normal content results.
- Patch writes stay in sync with search: `cognitive-memory-api.patch()` updates linked `memory-document:<id>` entries in `search-index.db`, including the FTS and vector-backed rows managed by `ui/modules/memory-search.js`.
- Supervisor-backed maintenance is live: `ui/supervisor-daemon.js` initializes the sleep consolidator and lease janitor during startup, then reruns housekeeping on each supervisor tick while writing status under `.squidrun/runtime/`.
- Startup health scoring contract is explicit in `ui/scripts/hm-health-snapshot.js`: score starts at 100, penalties subtract from named findings, thresholds map score bands to `OK`/`WARN`/`DEGRADED`/`CRITICAL`, and new probes are expected to register a stable warning code plus a documented penalty instead of open-coded score math. Current operational probes are bridge connectivity (`bridge_enabled_unconfigured`, `bridge_enabled_not_connected`) and memory consistency (`memory_consistency_drift`, generic unsynced fallback).
- Sleep consolidation is wired through the supervisor, but it is intentionally gated by idle/activity thresholds. Its tables initialize at supervisor startup; full clustering/extraction runs only when the session is idle enough.
- Memory expiration is enforced in active delivery paths: `ui/modules/memory-ingest/delivery.js` excludes expired rows from proactive injection, and `ui/modules/memory-ingest/lifecycle.js` advances expired memories to `status='expired'`.
- Lifecycle maintenance is no longer dead code: successful delivery records access, and session rollover in `ui/modules/main/squidrun-app.js` runs `advance-memory-lifecycle` plus `review-stale-memories` before proactive injection.
- Promotion corrections now supersede originals: approved correction candidates persist `correction_of` / `supersedes` links and move the original memory to `superseded` instead of leaving both memories active.
- Knowledge-backed memory can be audited on demand: `ui/modules/memory-consistency-check.js` compares the current `workspace/knowledge/` chunk set against `nodes.source_type='knowledge'` in `cognitive-memory.db`, reporting missing flat-file coverage, orphaned nodes, and duplicate knowledge hashes via `ui/scripts/hm-memory-consistency.js`.

## 6) DATA FLOW
1. User types in pane 1 broadcast input (`ui/index.html#broadcastInput`, `ui/renderer.js`).
2. Renderer forwards through IPC (`send-broadcast-message` / task-parser handlers) into main process routing.
3. Architect delegates via `hm-send.js` to target role/pane.
4. `hm-send.js` sends a canonical envelope over WebSocket and records outbound comms metadata.
5. WebSocket runtime dispatch in `squidrun-app.js` calls `triggers.sendDirectMessage()` / `broadcastToAllAgents()`.
6. If direct WS verification fails, `hm-send.js` writes trigger fallback file under `.squidrun/triggers/`.
7. Watcher picks trigger/message changes, parses target/sequence, and routes to injection.
8. Main routes injection to hidden pane host PTY (or visible fallback), then receives delivery ack/outcome.
9. Target agent processes and replies via `hm-send.js` back to Architect, repeating the same envelope + verification flow.
10. Handoff materializer compacts comms journal/evidence into `.squidrun/handoffs/session.md` and context snapshots.
11. Team-memory delivery can proactively inject Tier 3/Tier 4 memory into a pane, send cross-device handoff packets over relay, and restore compaction survival notes after context compression.

## 7) CONFIG FILES
- `ui/settings.json`: user/runtime settings (pane commands, watcher/autospawn flags, hidden pane-host toggle). **Gitignored** (`.gitignore`).
- `.squidrun/link.json`: bootstrap metadata (workspace root, comms script path, role targets). **Runtime-generated, gitignored**.
- `.squidrun/app-status.json`: current runtime status/session/pane-host health. **Runtime-generated, gitignored**.
- `workspace/user-profile.json`: user-editable profile used by agent startup behavior. **Tracked**.
- `workspace/knowledge/runtime-environment.md`: shared device registry and machine/runtime environment quirks. **Tracked**.
- `docs/diagrams-reference.md`: ASCII templates for system topology (Agent Message Flow and Knowledge & Memory System) intended for Excalidraw visualization.
- `ROLES.md`: canonical role boundaries/startup baseline/operating rules. **Tracked**.
- `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`: CLI-specific config files auto-read by Claude Code, Gemini CLI, and Codex CLI respectively. Each contains CLI quirks + mandatory directive to read `ROLES.md`. **Tracked**.

## 8) CO[private-live-ops]NATION STATE (`.squidrun/`)
- `.squidrun/handoffs/`: materialized session handoff index (`session.md`) from comms journal.
- `.squidrun/context-snapshots/`: per-pane startup context snapshots (`1.md`, `2.md`, `3.md`, etc.).
- `.squidrun/runtime/`: live SQLite stores (`evidence-ledger.db*`, `team-memory.sqlite*`, `supervisor.sqlite*`).
- `.squidrun/reports/`: generated audit/review reports.
- `.squidrun/state/`: runtime queue/state artifacts (e.g., `comms-outbound-queue.json`).
- `.squidrun/triggers/`: fallback trigger files consumed by watcher for agent delivery.
- `.squidrun/build/`: build blockers/errors/status artifacts used by restart gates.
- `.squidrun/app-status.json` + `.squidrun/link.json`: runtime truth + bootstrap metadata.
- `.squidrun/fresh-install.json`: marker file indicating a new installation before onboarding completion.

## 9) TEST INFRASTRUCTURE
- Test suite root: `ui/__tests__/` (Jest, Node environment) with shared setup in `ui/__tests__/setup.js`.
- Core commands (from `ui/package.json`): `npm test`, `npm run test:watch`, `npm run test:coverage`, `npm run lint`, `npm run typecheck`.
- Jest config: `ui/jest.config.js` (coverage thresholds, module mapping, setup files).
- Typecheck config: `ui/jsconfig.json` scopes the initial `tsc --noEmit` gate to JSDoc-annotated contract modules instead of the full legacy JS codebase.
- Mock patterns:
  - Electron API mocks in `ui/__tests__/mocks/electron.js`.
  - Shared IPC harness helpers in `ui/__tests__/helpers/ipc-harness.js`.
  - Config mocking helpers in `ui/__tests__/helpers/mock-config.js` and `ui/__tests__/helpers/real-config.js`.
  - Frequent fake-timer tests for watcher/terminal/runtime behavior.
- Current suite scale: 193 suites / 3494 tests in the active Jest gate, with handler-heavy coverage across main/ipc/runtime modules.
