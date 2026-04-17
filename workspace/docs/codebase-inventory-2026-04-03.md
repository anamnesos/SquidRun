# SquidRun Codebase Inventory

Generated: 2026-04-03T22:06:19.522Z

Scope: every `*.js` file under `ui/modules/` and `ui/scripts/`.

Usage status meanings:
- `active (N direct deps)`: imported by other code files.
- `active/manual (N refs)`: script is referenced by code or config and/or intended for direct CLI use.
- `test-only`: under `__tests__`, used by Jest rather than runtime.
- `deprecated`: stored under `ui/scripts/deprecated/`.
- `string-referenced`: not imported directly, but referenced by name/path elsewhere.
- `manual/no direct refs found` or `no direct refs found`: candidate audit targets, not automatically dead code.

Counts: 290 modules, 62 scripts.

## Modules

| Path | Description | Usage |
|---|---|---|
| ui/modules/agent-templates.js | Built-in agent templates library | active (2 direct deps) |
| ui/modules/analysis/doc-generator.js | Automated Documentation Generator - Task #23 | active (1 direct deps) |
| ui/modules/backup-manager.js | Backup Manager | active (4 direct deps) |
| ui/modules/bridge-client.js | Module for bridge client. | active (4 direct deps) |
| ui/modules/bridge/channel-policy.js | Module for channel policy. | active (1 direct deps) |
| ui/modules/bridge/preload-api.js | Module for preload api. | active (1 direct deps) |
| ui/modules/bridge/renderer-modules.js | Module for renderer modules. | active (1 direct deps) |
| ui/modules/bridge/safe-ipc.js | Module for safe ipc. | active (1 direct deps) |
| ui/modules/buffered-file-writer.js | Module for buffered file writer. | active (3 direct deps) |
| ui/modules/capability-planner.js | Module for capability planner. | active (2 direct deps) |
| ui/modules/codex-utils.js | Module for codex utils. | active (2 direct deps) |
| ui/modules/cognitive-memory-antibody.js | Module for cognitive memory antibody. | active (2 direct deps) |
| ui/modules/cognitive-memory-api.js | Module for cognitive memory api. | active (10 direct deps) |
| ui/modules/cognitive-memory-immunity.js | Module for cognitive memory immunity. | active (6 direct deps) |
| ui/modules/cognitive-memory-sleep.js | Module for cognitive memory sleep. | active (2 direct deps) |
| ui/modules/cognitive-memory-store.js | Module for cognitive memory store. | active (12 direct deps) |
| ui/modules/command-palette.js | SquidRun Command Palette - Quick access to all actions (Ctrl+K) | active (2 direct deps) |
| ui/modules/comms-worker-client.js | Module for comms worker client. | active (2 direct deps) |
| ui/modules/comms-worker.js | Comms worker process. | string-referenced (14 mentions) |
| ui/modules/comms/message-envelope.js | @ts-check | active (3 direct deps) |
| ui/modules/compaction-detector.js | Compaction Detector - 4-state machine per pane | active (2 direct deps) |
| ui/modules/constants.js | Shared constants for UI modules. | active (5 direct deps) |
| ui/modules/context-compressor.js | Context Compressor - Smart context restoration after Claude Code compaction | active (2 direct deps) |
| ui/modules/contract-promotion-service.js | Module for contract promotion service. | active (3 direct deps) |
| ui/modules/contract-promotion.js | Contract Promotion Engine | active (3 direct deps) |
| ui/modules/contracts.js | Contract Engine - Day-1 contracts for the Event Kernel | active (5 direct deps) |
| ui/modules/cross-device-target.js | Module for cross device target. | active (7 direct deps) |
| ui/modules/daemon-handlers.js | Daemon handlers module | active (4 direct deps) |
| ui/modules/diagnostic-log.js | Diagnostic log writer for message delivery traces. | active (2 direct deps) |
| ui/modules/event-bus.js | Event Kernel - Two-lane event system for SquidRun | active (15 direct deps) |
| ui/modules/experiment/index.js | Module for index. | active (2 direct deps) |
| ui/modules/experiment/profiles.js | Module for profiles. | active (2 direct deps) |
| ui/modules/experiment/runtime.js | Module for runtime. | active (7 direct deps) |
| ui/modules/experiment/worker-client.js | Module for worker client. | active (2 direct deps) |
| ui/modules/experiment/worker.js | Experiment worker process. | string-referenced (56 mentions) |
| ui/modules/external-notifications.js | Module for external notifications. | active (3 direct deps) |
| ui/modules/feature-capabilities.js | Feature Capability Registry | active (2 direct deps) |
| ui/modules/formatters.js | Unified formatting utilities for SquidRun UI. | active (5 direct deps) |
| ui/modules/gemini-command.js | Module for gemini command. | active (4 direct deps) |
| ui/modules/image-gen.js | Image Generation Module | active (4 direct deps) |
| ui/modules/inject-message-ipc.js | Module for inject message ipc. | active (8 direct deps) |
| ui/modules/ipc-handlers.js | IPC handlers for Electron main process | active (2 direct deps) |
| ui/modules/ipc/agent-claims-handlers.js | Agent Claims IPC Handlers | active (3 direct deps) |
| ui/modules/ipc/agent-metrics-handlers.js | Agent Metrics IPC Handlers | active (5 direct deps) |
| ui/modules/ipc/auto-handoff-handlers.js | Auto-Handoff IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/auto-nudge-handlers.js | Auto-Nudge and Health Monitoring IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/background-processes.js | IPC handler/runtime module for background processes. | active (3 direct deps) |
| ui/modules/ipc/backup-handlers.js | Backup IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/checkpoint-handlers.js | Checkpoint IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/cognitive-memory-handlers.js | @ts-check | active (4 direct deps) |
| ui/modules/ipc/completion-detection-handlers.js | Completion Detection IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/completion-quality-handlers.js | Completion Quality IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/conflict-detection-handlers.js | Conflict Detection IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/contract-promotion-handlers.js | IPC handler/runtime module for contract promotion handlers. | active (2 direct deps) |
| ui/modules/ipc/debug-replay-handlers.js | Debug Replay IPC Handlers - Task #21 | active (2 direct deps) |
| ui/modules/ipc/device-pairing-handlers.js | @ts-check | active (2 direct deps) |
| ui/modules/ipc/error-handlers.js | IPC handler/runtime module for error handlers. | active (2 direct deps) |
| ui/modules/ipc/evidence-ledger-handlers.js | Evidence Ledger IPC Handlers | active (6 direct deps) |
| ui/modules/ipc/evidence-ledger-runtime.js | Evidence Ledger runtime execution (in-process). | active (5 direct deps) |
| ui/modules/ipc/evidence-ledger-worker-client.js | IPC handler/runtime module for evidence ledger worker client. | active (3 direct deps) |
| ui/modules/ipc/evidence-ledger-worker.js | Evidence Ledger worker process. | string-referenced (15 mentions) |
| ui/modules/ipc/external-notification-handlers.js | External Notification IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/friction-handlers.js | Friction Panel IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/git-handlers.js | Git IPC Handlers - Task #6 + Task #18 | active (2 direct deps) |
| ui/modules/ipc/github-handlers.js | GitHub IPC Handlers | active (3 direct deps) |
| ui/modules/ipc/handler-registry.js | IPC handler/runtime module for handler registry. | active (2 direct deps) |
| ui/modules/ipc/index.js | IPC handler/runtime module for index. | active (1 direct deps) |
| ui/modules/ipc/ipc-state.js | IPC handler/runtime module for ipc state. | active (1 direct deps) |
| ui/modules/ipc/knowledge-graph-handlers.js | Knowledge Graph IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/knowledge-handlers.js | Knowledge Base IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/mcp-autoconfig-handlers.js | IPC handler/runtime module for mcp autoconfig handlers. | active (2 direct deps) |
| ui/modules/ipc/mcp-handlers.js | IPC handler/runtime module for mcp handlers. | active (2 direct deps) |
| ui/modules/ipc/message-queue-handlers.js | IPC handler/runtime module for message queue handlers. | active (2 direct deps) |
| ui/modules/ipc/model-switch-handlers.js | Model Switch IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/oracle-handlers.js | Oracle IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/organic-ui-handlers.js | Organic UI IPC Handlers | active (6 direct deps) |
| ui/modules/ipc/output-validation-handlers.js | Output Validation IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/perf-audit-handlers.js | IPC handler/runtime module for perf audit handlers. | active (2 direct deps) |
| ui/modules/ipc/plugin-handlers.js | Plugin IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/precommit-handlers.js | IPC handler/runtime module for precommit handlers. | active (2 direct deps) |
| ui/modules/ipc/preflight-handlers.js | IPC handler/runtime module for preflight handlers. | active (1 direct deps) |
| ui/modules/ipc/process-handlers.js | Background Process IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/project-handlers.js | Project IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/pty-handlers.js | PTY IPC Handlers (via Daemon) | active (2 direct deps) |
| ui/modules/ipc/recovery-handlers.js | Recovery IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/resource-handlers.js | Resource usage IPC handlers | active (2 direct deps) |
| ui/modules/ipc/scheduler-handlers.js | Scheduler IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/screenshot-handlers.js | Screenshot IPC Handlers | active (3 direct deps) |
| ui/modules/ipc/session-history-handlers.js | Session History IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/session-summary-handlers.js | Session Summary IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/settings-handlers.js | Settings IPC Handlers | active (4 direct deps) |
| ui/modules/ipc/shared-context-handlers.js | Shared Context IPC Handlers | active (3 direct deps) |
| ui/modules/ipc/smart-routing-handlers.js | Smart Routing IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/state-handlers.js | State IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/task-parser-handlers.js | Task Parser IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/task-pool-handlers.js | Task Pool IPC Handlers - Smart Parallelism Phase 3 | active (3 direct deps) |
| ui/modules/ipc/team-memory-handlers.js | IPC handler/runtime module for team memory handlers. | active (2 direct deps) |
| ui/modules/ipc/template-handlers.js | Template IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/test-execution-handlers.js | IPC handler/runtime module for test execution handlers. | active (2 direct deps) |
| ui/modules/ipc/test-notification-handlers.js | IPC handler/runtime module for test notification handlers. | active (2 direct deps) |
| ui/modules/ipc/transition-ledger-handlers.js | Transition Ledger IPC Handlers | active (3 direct deps) |
| ui/modules/ipc/user-profile-handlers.js | IPC handler/runtime module for user profile handlers. | active (2 direct deps) |
| ui/modules/ipc/whisper-handlers.js | Whisper Voice Input IPC Handlers | active (2 direct deps) |
| ui/modules/ipc/workflow-handlers.js | Workflow Builder IPC Handlers (Task #19) | active (2 direct deps) |
| ui/modules/knowledge-base.js | Knowledge Base (RAG) - Minimal JSON + cosine MVP | active (2 direct deps) |
| ui/modules/knowledge/knowledge-graph-service.js | Runtime knowledge graph service. | active (2 direct deps) |
| ui/modules/knowledge/knowledge-graph-store.js | Knowledge Graph - Cross-Session Relationship Tracking | active (1 direct deps) |
| ui/modules/local-embedder.js | Local embeddings via Python sentence-transformers subprocess. | active (2 direct deps) |
| ui/modules/local-model-capabilities.js | Module for local model capabilities. | active (7 direct deps) |
| ui/modules/logger.js | Structured logger for SquidRun | active (106 direct deps) |
| ui/modules/main/activity-manager.js | Activity Manager | active (1 direct deps) |
| ui/modules/main/app-context.js | Application Context | active (1 direct deps) |
| ui/modules/main/auto-handoff-materializer.js | Main-process app module for auto handoff materializer. | active (3 direct deps) |
| ui/modules/main/autonomous-smoke.js | Main-process app module for autonomous smoke. | active (2 direct deps) |
| ui/modules/main/background-agent-manager.js | Main-process app module for background agent manager. | active (2 direct deps) |
| ui/modules/main/cli-identity.js | CLI Identity | active (1 direct deps) |
| ui/modules/main/comms-journal.js | Main-process app module for comms journal. | active (16 direct deps) |
| ui/modules/main/device-pairing-store.js | Main-process app module for device pairing store. | active (1 direct deps) |
| ui/modules/main/evidence-ledger-ingest.js | Evidence Ledger Ingest | active (5 direct deps) |
| ui/modules/main/evidence-ledger-investigator.js | Evidence Ledger Investigator | active (2 direct deps) |
| ui/modules/main/evidence-ledger-memory-seed.js | Evidence Ledger Memory Seed Utility | active (3 direct deps) |
| ui/modules/main/evidence-ledger-memory.js | Evidence Ledger Memory | active (5 direct deps) |
| ui/modules/main/evidence-ledger-store.js | Evidence Ledger Store | active (20 direct deps) |
| ui/modules/main/firmware-manager.js | Firmware Manager | active (2 direct deps) |
| ui/modules/main/github-service.js | Main-process app module for github service. | active (2 direct deps) |
| ui/modules/main/kernel-bridge.js | Event Kernel bridge (main process) | active (2 direct deps) |
| ui/modules/main/pane-control-service.js | Main-process app module for pane control service. | active (2 direct deps) |
| ui/modules/main/pane-host-window-manager.js | Main-process app module for pane host window manager. | active (2 direct deps) |
| ui/modules/main/pty-output-filter.js | Main-process app module for pty output filter. | active (2 direct deps) |
| ui/modules/main/settings-manager.js | Settings Manager | active (2 direct deps) |
| ui/modules/main/squidrun-app.js | SquidRun Application | active (3 direct deps) |
| ui/modules/main/usage-manager.js | Usage Manager | active (2 direct deps) |
| ui/modules/mcp-bridge.js | V11 MCP Bridge Module | active (3 direct deps) |
| ui/modules/memory-consistency-check.js | Module for memory consistency check. | active (6 direct deps) |
| ui/modules/memory-ingest/delivery.js | Module for delivery. | active (1 direct deps) |
| ui/modules/memory-ingest/journal.js | Module for journal. | active (2 direct deps) |
| ui/modules/memory-ingest/lifecycle.js | Module for lifecycle. | active (1 direct deps) |
| ui/modules/memory-ingest/promotion.js | Module for promotion. | active (3 direct deps) |
| ui/modules/memory-ingest/router.js | Module for router. | active (3 direct deps) |
| ui/modules/memory-ingest/schema.js | Module for schema. | active (6 direct deps) |
| ui/modules/memory-ingest/service.js | Module for service. | active (3 direct deps) |
| ui/modules/memory-ingest/shutdown-marker.js | Module for shutdown marker. | active (1 direct deps) |
| ui/modules/memory-recall.js | Module for memory recall. | active (7 direct deps) |
| ui/modules/memory-search.js | Module for memory search. | active (11 direct deps) |
| ui/modules/model-selector.js | SquidRun Model Selector - Per-pane model switching (Claude/Codex/Gemini) | active (2 direct deps) |
| ui/modules/notifications.js | Consolidated notification system for SquidRun UI. | active (7 direct deps) |
| ui/modules/performance-data.js | Module for performance data. | active (4 direct deps) |
| ui/modules/pipeline.js | Pipeline - Conversation-aware pipeline state machine | active (4 direct deps) |
| ui/modules/plugins/index.js | Module for index. | active (1 direct deps) |
| ui/modules/plugins/plugin-manager.js | Plugin Manager | active (1 direct deps) |
| ui/modules/problem-orchestrator.js | Module for problem orchestrator. | active (4 direct deps) |
| ui/modules/recovery-manager.js | Self-Healing Recovery Manager | active (2 direct deps) |
| ui/modules/renderer-bridge.js | Module for renderer bridge. | active (15 direct deps) |
| ui/modules/renderer-ipc-registry.js | Renderer-scoped IPC listener registry. | active (5 direct deps) |
| ui/modules/replay/debug-replay.js | Debug Replay System - Task #21 | active (2 direct deps) |
| ui/modules/scheduler.js | Task Scheduler | active (2 direct deps) |
| ui/modules/settings.js | Settings module | active (6 direct deps) |
| ui/modules/shared-state.js | Shared State - Live state aggregator with rolling changelog | active (2 direct deps) |
| ui/modules/smart-routing.js | Smart Routing - scoring and selection | active (4 direct deps) |
| ui/modules/sms-poller.js | Twilio SMS inbound poller. | active (3 direct deps) |
| ui/modules/sqlite-compat.js | SQLite compatibility shim. | active (11 direct deps) |
| ui/modules/startup-transcript-context.js | Module for startup transcript context. | active (4 direct deps) |
| ui/modules/status-strip.js | SquidRun Status Strip (legacy module) | active (2 direct deps) |
| ui/modules/subtitles/pipeline.js | Module for pipeline. | active (2 direct deps) |
| ui/modules/supervisor/index.js | Module for index. | active (3 direct deps) |
| ui/modules/supervisor/migrations.js | Module for migrations. | active (2 direct deps) |
| ui/modules/supervisor/migrations/001-initial-schema.js | Schema migration for 001 initial schema. | active (1 direct deps) |
| ui/modules/supervisor/store.js | Module for store. | active (1 direct deps) |
| ui/modules/tabs.js | Tabs and panels module | active (2 direct deps) |
| ui/modules/tabs/api-keys.js | API Keys Tab Module | active (1 direct deps) |
| ui/modules/tabs/bridge.js | Bridge Tab — System dashboard showing agent status, metrics, and event stream | active (2 direct deps) |
| ui/modules/tabs/comms-console.js | Comms Console tab module | active (2 direct deps) |
| ui/modules/tabs/oracle.js | Oracle Image Generation Module | active (2 direct deps) |
| ui/modules/tabs/screenshots.js | Screenshots Module | active (1 direct deps) |
| ui/modules/tabs/utils.js | Shared utilities for tabs modules | active (3 direct deps) |
| ui/modules/task-parser.js | Natural language task parsing | active (5 direct deps) |
| ui/modules/team-memory/backfill.js | Team Memory module for backfill. | active (1 direct deps) |
| ui/modules/team-memory/claims.js | Team Memory module for claims. | active (6 direct deps) |
| ui/modules/team-memory/comms-tagged-extractor.js | Team Memory module for comms tagged extractor. | active (2 direct deps) |
| ui/modules/team-memory/daily-integration.js | Team Memory module for daily integration. | active (4 direct deps) |
| ui/modules/team-memory/guards.js | Team Memory module for guards. | active (2 direct deps) |
| ui/modules/team-memory/index.js | Team Memory module for index. | active (7 direct deps) |
| ui/modules/team-memory/integrity-checker.js | Team Memory module for integrity checker. | active (3 direct deps) |
| ui/modules/team-memory/migrations.js | Team Memory module for migrations. | active (1 direct deps) |
| ui/modules/team-memory/migrations/001-initial-schema.js | Team Memory schema migration v1. | active (1 direct deps) |
| ui/modules/team-memory/migrations/002-phase1-compat.js | Team Memory schema migration v2. | active (1 direct deps) |
| ui/modules/team-memory/migrations/003-phase2-search.js | Team Memory schema migration v3. | active (1 direct deps) |
| ui/modules/team-memory/migrations/004-phase4-patterns.js | Team Memory schema migration v4. | active (1 direct deps) |
| ui/modules/team-memory/migrations/005-phase5-guards.js | Team Memory schema migration v5. | active (1 direct deps) |
| ui/modules/team-memory/migrations/006-phase6-experiments.js | Team Memory schema migration v6. | active (1 direct deps) |
| ui/modules/team-memory/migrations/007-phase6b-pending-proof.js | Team Memory schema migration v7. | active (2 direct deps) |
| ui/modules/team-memory/migrations/008-phase6c-contradiction-resolution.js | Team Memory schema migration v8. | active (2 direct deps) |
| ui/modules/team-memory/migrations/009-phase7-memory-ingest.js | Team Memory schema migration v9. | active (1 direct deps) |
| ui/modules/team-memory/migrations/010-phase8-memory-ingest-recovery.js | Team Memory schema migration v10. | active (1 direct deps) |
| ui/modules/team-memory/migrations/011-phase9-memory-promotion-lifecycle.js | Team Memory schema migration v11. | active (1 direct deps) |
| ui/modules/team-memory/migrations/012-phase10-memory-delivery.js | Team Memory schema migration v12. | active (1 direct deps) |
| ui/modules/team-memory/migrations/013-phase10b-memory-class-expansion.js | Team Memory schema migration v13. | string-referenced (1 mentions) |
| ui/modules/team-memory/migrations/014-phase10c-promotion-correction-links.js | Team Memory schema migration v14. | active (1 direct deps) |
| ui/modules/team-memory/migrations/015-phase11-recall-feedback.js | Team Memory schema migration v15. | active (1 direct deps) |
| ui/modules/team-memory/patterns.js | Team Memory module for patterns. | active (4 direct deps) |
| ui/modules/team-memory/recall-feedback.js | Team Memory module for recall feedback. | active (2 direct deps) |
| ui/modules/team-memory/runtime.js | Team Memory module for runtime. | active (10 direct deps) |
| ui/modules/team-memory/store.js | Team Memory module for store. | active (20 direct deps) |
| ui/modules/team-memory/worker-client.js | Team Memory module for worker client. | active (4 direct deps) |
| ui/modules/team-memory/worker.js | Team Memory worker process. | string-referenced (56 mentions) |
| ui/modules/telegram-poller.js | Telegram inbound poller. | active (3 direct deps) |
| ui/modules/terminal.js | Terminal management module | active (9 direct deps) |
| ui/modules/terminal/agent-colors.js | Agent message color indicators for xterm.js terminals | active (2 direct deps) |
| ui/modules/terminal/injection-capabilities.js | Module for injection capabilities. | active (2 direct deps) |
| ui/modules/terminal/injection.js | Terminal injection helpers | active (4 direct deps) |
| ui/modules/terminal/recovery.js | Terminal recovery helpers (unstick, restart, sweeper) | active (2 direct deps) |
| ui/modules/token-utils.js | Token estimation utilities | active (3 direct deps) |
| ui/modules/trading/__tests__/agent-attribution.test.js | Jest coverage for agent attribution.test. | test-only |
| ui/modules/trading/__tests__/backtesting.test.js | Jest coverage for backtesting.test. | test-only |
| ui/modules/trading/__tests__/broker-adapter.test.js | Jest coverage for broker adapter.test. | test-only |
| ui/modules/trading/__tests__/circuit-breaker.test.js | Jest coverage for circuit breaker.test. | test-only |
| ui/modules/trading/__tests__/consensus-sizer.test.js | Jest coverage for consensus sizer.test. | test-only |
| ui/modules/trading/__tests__/consultation-persistence.test.js | Jest coverage for consultation persistence.test. | test-only |
| ui/modules/trading/__tests__/consultation-store.test.js | Jest coverage for consultation store.test. | test-only |
| ui/modules/trading/__tests__/crisis-mode.test.js | Jest coverage for crisis mode.test. | test-only |
| ui/modules/trading/__tests__/crypto-mech-board.test.js | Jest coverage for crypto mech board.test. | test-only |
| ui/modules/trading/__tests__/crypto-support.test.js | Jest coverage for crypto support.test. | test-only |
| ui/modules/trading/__tests__/dynamic-watchlist.test.js | Jest coverage for dynamic watchlist.test. | test-only |
| ui/modules/trading/__tests__/event-veto.test.js | Jest coverage for event veto.test. | test-only |
| ui/modules/trading/__tests__/hm-defi-execute.test.js | Jest coverage for hm defi execute.test. | test-only |
| ui/modules/trading/__tests__/journal.test.js | Jest coverage for journal.test. | test-only |
| ui/modules/trading/__tests__/launch-radar.test.js | Jest coverage for launch radar.test. | test-only |
| ui/modules/trading/__tests__/macro-risk-gate.test.js | Jest coverage for macro risk gate.test. | test-only |
| ui/modules/trading/__tests__/orchestrator-consultation.test.js | Jest coverage for orchestrator consultation.test. | test-only |
| ui/modules/trading/__tests__/orchestrator-dry-run.js | Jest coverage for orchestrator dry run. | test-only |
| ui/modules/trading/__tests__/polymarket-client.test.js | Jest coverage for polymarket client.test. | test-only |
| ui/modules/trading/__tests__/polymarket-scanner.test.js | Jest coverage for polymarket scanner.test. | test-only |
| ui/modules/trading/__tests__/polymarket-schedule.test.js | Jest coverage for polymarket schedule.test. | test-only |
| ui/modules/trading/__tests__/polymarket-signals.test.js | Jest coverage for polymarket signals.test. | test-only |
| ui/modules/trading/__tests__/polymarket-sizer.test.js | Jest coverage for polymarket sizer.test. | test-only |
| ui/modules/trading/__tests__/portfolio-tracker.test.js | Jest coverage for portfolio tracker.test. | test-only |
| ui/modules/trading/__tests__/signal-producer-crypto.test.js | Jest coverage for signal producer crypto.test. | test-only |
| ui/modules/trading/__tests__/smart-money-scanner.test.js | Jest coverage for smart money scanner.test. | test-only |
| ui/modules/trading/__tests__/telegram-summary.test.js | Jest coverage for telegram summary.test. | test-only |
| ui/modules/trading/__tests__/token-risk-audit.test.js | Jest coverage for token risk audit.test. | test-only |
| ui/modules/trading/__tests__/wallet-tracker.test.js | Jest coverage for wallet tracker.test. | test-only |
| ui/modules/trading/__tests__/yield-router.test.js | Jest coverage for yield router.test. | test-only |
| ui/modules/trading/agent-attribution.js | Trading module for agent attribution. | active (3 direct deps) |
| ui/modules/trading/backtesting.js | Trading module for backtesting. | active (2 direct deps) |
| ui/modules/trading/broker-adapter.js | Trading module for broker adapter. | active (3 direct deps) |
| ui/modules/trading/circuit-breaker.js | Trading module for circuit breaker. | active (2 direct deps) |
| ui/modules/trading/consensus-sizer.js | Trading module for consensus sizer. | active (3 direct deps) |
| ui/modules/trading/consensus.js | Consensus Engine — Adversarial multi-model trading consensus. | active (2 direct deps) |
| ui/modules/trading/consultation-store.js | Trading module for consultation store. | active (3 direct deps) |
| ui/modules/trading/crisis-mode.js | Trading module for crisis mode. | active (6 direct deps) |
| ui/modules/trading/crypto-mech-board.js | Trading module for crypto mech board. | active (3 direct deps) |
| ui/modules/trading/data-ingestion.js | Trading module for data ingestion. | active (10 direct deps) |
| ui/modules/trading/dynamic-watchlist.js | Trading module for dynamic watchlist. | active (4 direct deps) |
| ui/modules/trading/event-veto.js | Trading module for event veto. | active (3 direct deps) |
| ui/modules/trading/executor.js | Trading module for executor. | active (10 direct deps) |
| ui/modules/trading/hyperliquid-client.js | Trading module for hyperliquid client. | active (3 direct deps) |
| ui/modules/trading/ibkr-client.js | Trading module for ibkr client. | active (4 direct deps) |
| ui/modules/trading/journal.js | Trade Journal — SQLite-backed trade log and performance tracking. | active (4 direct deps) |
| ui/modules/trading/launch-radar.js | Trading module for launch radar. | active (2 direct deps) |
| ui/modules/trading/macro-risk-gate.js | Macro Risk Gate - Assesses macro-economic and geopolitical conditions | active (7 direct deps) |
| ui/modules/trading/orchestrator.js | Trading module for orchestrator. | active (5 direct deps) |
| ui/modules/trading/polymarket-client.js | Trading module for polymarket client. | active (6 direct deps) |
| ui/modules/trading/polymarket-scanner.js | Trading module for polymarket scanner. | active (5 direct deps) |
| ui/modules/trading/polymarket-signals.js | Trading module for polymarket signals. | active (4 direct deps) |
| ui/modules/trading/polymarket-sizer.js | Trading module for polymarket sizer. | active (4 direct deps) |
| ui/modules/trading/portfolio-tracker.js | Trading module for portfolio tracker. | active (3 direct deps) |
| ui/modules/trading/position-management.js | Trading module for position management. | active (1 direct deps) |
| ui/modules/trading/risk-engine.js | Risk Engine — Hard limits that are NEVER overridden. | active (6 direct deps) |
| ui/modules/trading/scheduler.js | Trading module for scheduler. | active (4 direct deps) |
| ui/modules/trading/signal-producer.js | Trading module for signal producer. | active (3 direct deps) |
| ui/modules/trading/smart-money-scanner.js | Trading module for smart money scanner. | active (2 direct deps) |
| ui/modules/trading/telegram-summary.js | Telegram Trading Summary — Formats and sends daily trading reports. | active (3 direct deps) |
| ui/modules/trading/time-orientation.js | Trading module for time orientation. | string-referenced (1 mentions) |
| ui/modules/trading/token-risk-audit.js | Trading module for token risk audit. | active (2 direct deps) |
| ui/modules/trading/wallet-tracker.js | Trading module for wallet tracker. | active (1 direct deps) |
| ui/modules/trading/watchlist.js | Trading module for watchlist. | active (8 direct deps) |
| ui/modules/trading/yield-router.js | Trading module for yield router. | active (5 direct deps) |
| ui/modules/transcript-index.js | Module for transcript index. | active (4 direct deps) |
| ui/modules/transition-ledger.js | Transition Ledger | active (5 direct deps) |
| ui/modules/triggers.js | Trigger handling and agent notification functions | active (8 direct deps) |
| ui/modules/triggers/metrics.js | Triggers - Reliability Metrics | active (2 direct deps) |
| ui/modules/triggers/routing.js | Triggers - Routing and Handoff Logic | active (2 direct deps) |
| ui/modules/triggers/sequencing.js | Triggers - Message Sequencing | active (1 direct deps) |
| ui/modules/ui-view.js | UI View module | active (2 direct deps) |
| ui/modules/utils.js | SquidRun Utils - General utility functions | active (2 direct deps) |
| ui/modules/utils/transcript-store.js | Shared transcript reader for runtime modules. | active (1 direct deps) |
| ui/modules/watcher-worker.js | File watcher worker process. | string-referenced (14 mentions) |
| ui/modules/watcher.js | File watcher and state machine | active (4 direct deps) |
| ui/modules/websocket-runtime.js | WebSocket Server for Agent Communication | active (6 direct deps) |
| ui/modules/websocket-server.js | WebSocket server facade. | active (7 direct deps) |

## Scripts

| Path | Description | Usage |
|---|---|---|
| ui/scripts/claude-extract.js | CLI/runtime script for claude extract. | active/manual (10 refs) |
| ui/scripts/deprecated/coverage-report.js | Quick coverage summary analysis | deprecated |
| ui/scripts/deprecated/swap-usdc-eth.js | Deprecated helper script for swap usdc eth. | deprecated |
| ui/scripts/deprecated/test-image-gen.js | Deprecated helper script for test image gen. | deprecated |
| ui/scripts/doc-lint.js | CLI/runtime script for doc lint. | active/manual (8 refs) |
| ui/scripts/evidence-ledger-seed-memory.js | CLI/runtime script for evidence ledger seed memory. | active/manual (5 refs) |
| ui/scripts/hm-backtest.js | CLI/runtime script for hm backtest. | active/manual (4 refs) |
| ui/scripts/hm-bg.js | CLI/runtime script for hm bg. | active/manual (10 refs) |
| ui/scripts/hm-capabilities.js | CLI/runtime script for hm capabilities. | active/manual (6 refs) |
| ui/scripts/hm-ci-check.js | CLI/runtime script for hm ci check. | active/manual (11 refs) |
| ui/scripts/hm-claim.js | CLI/runtime script for hm claim. | active/manual (11 refs) |
| ui/scripts/hm-comms.js | CLI/runtime script for hm comms. | active/manual (36 refs) |
| ui/scripts/hm-compat-count.js | CLI/runtime script for hm compat count. | active/manual (8 refs) |
| ui/scripts/hm-defi-close.js | CLI/runtime script for hm defi close. | active/manual (16 refs) |
| ui/scripts/hm-defi-execute.js | CLI/runtime script for hm defi execute. | active/manual (14 refs) |
| ui/scripts/hm-defi-status.js | CLI/runtime script for hm defi status. | active/manual (11 refs) |
| ui/scripts/hm-doctor.js | CLI/runtime script for hm doctor. | active/manual (16 refs) |
| ui/scripts/hm-experiment.js | CLI/runtime script for hm experiment. | active/manual (7 refs) |
| ui/scripts/hm-github.js | CLI/runtime script for hm github. | active/manual (7 refs) |
| ui/scripts/hm-health-snapshot.js | CLI/runtime script for hm health snapshot. | active/manual (5 refs) |
| ui/scripts/hm-hook-afteragent.js | CLI/runtime script for hm hook afteragent. | active/manual (5 refs) |
| ui/scripts/hm-hook-injection.js | CLI/runtime script for hm hook injection. | active/manual (5 refs) |
| ui/scripts/hm-hook-precompress.js | CLI/runtime script for hm hook precompress. | active/manual (5 refs) |
| ui/scripts/hm-image-gen.js | CLI/runtime script for hm image gen. | active/manual (6 refs) |
| ui/scripts/hm-initiative.js | CLI/runtime script for hm initiative. | active/manual (7 refs) |
| ui/scripts/hm-investigate.js | CLI/runtime script for hm investigate. | active/manual (15 refs) |
| ui/scripts/hm-memory-antibody.js | CLI/runtime script for hm memory antibody. | active/manual (4 refs) |
| ui/scripts/hm-memory-api.js | CLI/runtime script for hm memory api. | active/manual (35 refs) |
| ui/scripts/hm-memory-consistency.js | CLI/runtime script for hm memory consistency. | active/manual (6 refs) |
| ui/scripts/hm-memory-extract.js | CLI/runtime script for hm memory extract. | active/manual (9 refs) |
| ui/scripts/hm-memory-index.js | CLI/runtime script for hm memory index. | active/manual (10 refs) |
| ui/scripts/hm-memory-ingest.js | CLI/runtime script for hm memory ingest. | active/manual (12 refs) |
| ui/scripts/hm-memory-promote.js | CLI/runtime script for hm memory promote. | active/manual (21 refs) |
| ui/scripts/hm-memory-registry.js | CLI/runtime script for hm memory registry. | active/manual (9 refs) |
| ui/scripts/hm-memory-search.js | CLI/runtime script for hm memory search. | active/manual (11 refs) |
| ui/scripts/hm-memory.js | CLI/runtime script for hm memory. | active/manual (10 refs) |
| ui/scripts/hm-pane.js | CLI/runtime script for hm pane. | active/manual (6 refs) |
| ui/scripts/hm-path-audit.js | CLI/runtime script for hm path audit. | active/manual (7 refs) |
| ui/scripts/hm-preflight.js | CLI/runtime script for hm preflight. | active/manual (16 refs) |
| ui/scripts/hm-promotion.js | CLI/runtime script for hm promotion. | active/manual (6 refs) |
| ui/scripts/hm-reddit.js | CLI/runtime script for hm reddit. | active/manual (10 refs) |
| ui/scripts/hm-screenshot.js | CLI/runtime script for hm screenshot. | active/manual (6 refs) |
| ui/scripts/hm-search.js | CLI/runtime script for hm search. | active/manual (10 refs) |
| ui/scripts/hm-send.js | CLI/runtime script for hm send. | active/manual (180 refs) |
| ui/scripts/hm-session-summary.js | CLI/runtime script for hm session summary. | active/manual (3 refs) |
| ui/scripts/hm-smoke-runner.js | CLI/runtime script for hm smoke runner. | active/manual (27 refs) |
| ui/scripts/hm-sms.js | CLI/runtime script for hm sms. | active/manual (7 refs) |
| ui/scripts/hm-startup-transcript-context.js | CLI/runtime script for hm startup transcript context. | active/manual (3 refs) |
| ui/scripts/hm-subtitle-pipeline.js | CLI/runtime script for hm subtitle pipeline. | active/manual (6 refs) |
| ui/scripts/hm-supervisor.js | CLI/runtime script for hm supervisor. | active/manual (12 refs) |
| ui/scripts/hm-surface-audit.js | CLI/runtime script for hm surface audit. | active/manual (7 refs) |
| ui/scripts/hm-task-queue.js | CLI/runtime script for hm task queue. | active/manual (2 refs) |
| ui/scripts/hm-telegram-routing.js | CLI/runtime script for hm telegram routing. | active/manual (3 refs) |
| ui/scripts/hm-telegram.js | CLI/runtime script for hm telegram. | active/manual (21 refs) |
| ui/scripts/hm-transcript-index.js | CLI/runtime script for hm transcript index. | active/manual (1 refs) |
| ui/scripts/hm-transition.js | CLI/runtime script for hm transition. | active/manual (6 refs) |
| ui/scripts/hm-trigger-daemon.js | CLI/runtime script for hm trigger daemon. | active/manual (3 refs) |
| ui/scripts/hm-trigger.js | CLI/runtime script for hm trigger. | active/manual (3 refs) |
| ui/scripts/hm-twitter.js | CLI/runtime script for hm twitter. | active/manual (10 refs) |
| ui/scripts/hm-visual-capture.js | CLI/runtime script for hm visual capture. | active/manual (7 refs) |
| ui/scripts/hm-visual-utils.js | CLI/runtime script for hm visual utils. | active/manual (3 refs) |
| ui/scripts/ollama-extract.js | CLI/runtime script for ollama extract. | active/manual (15 refs) |
