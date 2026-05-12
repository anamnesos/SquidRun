'use strict';

const MIRA_SOURCE_ACTION_SUBSTRATE_SCHEMA = 'squidrun.mira.source_action_substrate_plan_v0';

const SUBSTRATE_STRATEGIES = Object.freeze({
  native_adapter: 'native_squidrun_adapter',
  mcp_connector: 'mcp_compatible_connector',
  code_mode: 'code_mode_search_execute',
  workflow_dag: 'workflow_dag',
  active_memory: 'active_memory_tool',
  evolution_loop: 'evolution_evaluation_loop',
});

const SOURCE_ACTION_SUBSTRATE_REGISTRY = Object.freeze([
  {
    source: 'code_mode_exploration',
    scope: 'files_jsonl_logs_and_large_source_surfaces',
    strategy: SUBSTRATE_STRATEGIES.code_mode,
    status: 'active',
    priority: 100,
    existing_seams: ['hm-mira-self-direction.js code-mode', 'runMiraReadOnlyCodeMode'],
    first_probe: "Read .squidrun/runtime JSONL with an allowlisted path and summarize the next route's evidence.",
    why_this_strategy: 'Code-mode is faster than fixed tool schemas for broad local files, JSONL queues, logs, and source APIs.',
  },
  {
    source: 'memory',
    scope: 'continuity_claims_and_relevant_context',
    strategy: SUBSTRATE_STRATEGIES.active_memory,
    status: 'active',
    priority: 94,
    existing_seams: ['mira-memory-curiosity.js', 'cognitive-memory-api.js', 'memory-search/retrieve', 'team-memory/*', 'memory-ingest/*', 'hm-memory-api.js retrieve'],
    first_probe: 'Use the active memory curiosity adapter to retrieve current-lane continuity before asking James to restate context.',
    why_this_strategy: 'Memory is an action source, not a passive note bucket; retrieval should ground curiosity and proposals.',
  },
  {
    source: 'runtime_comms',
    scope: 'architect_builder_oracle_and_local_journals',
    strategy: SUBSTRATE_STRATEGIES.native_adapter,
    status: 'active',
    priority: 90,
    existing_seams: ['hm-comms.js history --limit', 'telegram-poller.js', 'sms-poller.js', 'external-notifications.js'],
    first_probe: 'Read recent internal comms for repeated route pressure, blockers, and unclosed work.',
    why_this_strategy: 'SquidRun already owns pane comms; native reads avoid external message fanout.',
  },
  {
    source: 'automation_scheduler',
    scope: 'quiet_interval_and_repeated_curiosity_routines',
    strategy: SUBSTRATE_STRATEGIES.workflow_dag,
    status: 'adapter_ready_to_wire',
    priority: 84,
    existing_seams: ['ui/modules/scheduler.js', 'ui/modules/ipc/scheduler-handlers.js'],
    first_probe: 'Define one recurring read-only curiosity workflow over repo, runtime queue, memory, and comms.',
    why_this_strategy: 'Repeated curiosity should become a small workflow/DAG, not a hand-run script each time.',
  },
  {
    source: 'work_continuation',
    scope: 'background_routes_and_owned_work',
    strategy: SUBSTRATE_STRATEGIES.native_adapter,
    status: 'adapter_ready_to_wire',
    priority: 80,
    existing_seams: ['background-agent-manager.js', 'owned-work-continue-broker.js', 'smart-routing.js', 'transcript-index.js'],
    first_probe: 'Find stalled Mira-routed work and pair it with the latest route decision.',
    why_this_strategy: 'Work continuation is already local product machinery; Mira needs a read path before a write path.',
  },
  {
    source: 'browser_history',
    scope: 'local_browser_trails_and_research_context',
    strategy: SUBSTRATE_STRATEGIES.native_adapter,
    status: 'active',
    priority: 76,
    existing_seams: ['mira-browser-history-curiosity.js', 'Chromium History DB temp-copy', 'Chrome connector', 'mcp-bridge.js', 'browser-use/Chrome tools'],
    first_probe: 'Read compact recent domains, titles, visit counts, and safe paths from a temp-copied Chromium History DB.',
    why_this_strategy: 'A native read-only metadata adapter gives Mira useful browser curiosity now while connector-based live browsing remains an expansion path.',
  },
  {
    source: 'email',
    scope: 'local_email_context',
    strategy: SUBSTRATE_STRATEGIES.mcp_connector,
    status: 'connector_needed',
    priority: 72,
    existing_seams: ['Gmail connector', 'mcp-bridge.js'],
    first_probe: 'Read metadata and user-selected threads before any send/reply action exists.',
    why_this_strategy: 'The ecosystem connector is the fast path for authenticated email reads; sends stay a different consequence class.',
  },
  {
    source: 'web_research',
    scope: 'websites_and_external_research_surfaces',
    strategy: SUBSTRATE_STRATEGIES.code_mode,
    status: 'connector_needed',
    priority: 70,
    existing_seams: ['browser-use skill', 'Chrome connector', 'local research artifacts'],
    first_probe: 'Use code-mode on saved research artifacts first; use browser connectors only when live web context is necessary.',
    why_this_strategy: 'Huge source surfaces need search-execute wrappers plus connector escape hatches, not one massive tool list.',
  },
  {
    source: 'images_screenshots_assets',
    scope: 'screenshots_visual_assets_and_generated_media',
    strategy: SUBSTRATE_STRATEGIES.native_adapter,
    status: 'adapter_ready_to_wire',
    priority: 66,
    existing_seams: ['screenshot handlers/scripts', 'hm-screenshot.js', 'image-gen.js'],
    first_probe: 'Index recent screenshots/assets with source path and timestamp before adding interpretation.',
    why_this_strategy: 'The app already has screenshot and asset seams; curiosity needs a read inventory first.',
  },
  {
    source: 'environment_apps',
    scope: 'local_app_state_bridge_and_devices',
    strategy: SUBSTRATE_STRATEGIES.native_adapter,
    status: 'active',
    priority: 64,
    existing_seams: ['mira-environment-curiosity.js', 'bridge-client.js', 'mcp-bridge.js', 'websocket runtime/server', 'cross-device-target.js', 'hm-health-snapshot.js'],
    first_probe: 'Use the active environment curiosity adapter to read startup/app health, memory drift, and bridge state before environment actions.',
    why_this_strategy: 'Native environment reads keep profile/device state grounded before any device-control lane.',
  },
  {
    source: 'mira_runtime',
    scope: 'growth_loop_autonomy_experience_and_intent',
    strategy: SUBSTRATE_STRATEGIES.evolution_loop,
    status: 'adapter_ready_to_wire',
    priority: 62,
    existing_seams: ['growth-loop-v0.js', 'autonomy-substrate-v0.js', 'experience-v0.js', 'perception.js', 'intent-queue.js'],
    first_probe: 'Read current growth/intent state and compare it with routed proposals and scoreboard outcomes.',
    why_this_strategy: 'Mira evolution needs an evaluation loop over her own runtime traces, not just better prompts.',
  },
  {
    source: 'calendar_messages',
    scope: 'calendar_and_message_context',
    strategy: SUBSTRATE_STRATEGIES.mcp_connector,
    status: 'connector_needed',
    priority: 50,
    existing_seams: ['future calendar/message connector seam'],
    first_probe: 'Map available connector shape before reading any calendar/message content.',
    why_this_strategy: 'Calendar/message access is ecosystem-shaped until a native SquidRun seam exists.',
  },
]);

function cloneEntry(entry) {
  return {
    ...entry,
    existing_seams: [...entry.existing_seams],
  };
}

function buildMiraSourceActionSubstratePlan(options = {}) {
  const includeDeferred = options.includeDeferred !== false;
  const sources = SOURCE_ACTION_SUBSTRATE_REGISTRY
    .filter((entry) => includeDeferred || entry.status !== 'connector_needed')
    .map(cloneEntry)
    .sort((left, right) => right.priority - left.priority);
  const byStrategy = sources.reduce((acc, entry) => {
    acc[entry.strategy] = (acc[entry.strategy] || 0) + 1;
    return acc;
  }, {});
  const recommendedSequence = sources
    .filter((entry) => entry.status === 'active' || entry.status === 'adapter_ready_to_wire')
    .slice(0, 5)
    .map((entry) => ({
      source: entry.source,
      strategy: entry.strategy,
      first_probe: entry.first_probe,
    }));
  return {
    schema: MIRA_SOURCE_ACTION_SUBSTRATE_SCHEMA,
    ok: true,
    decision: 'substrate_plan',
    generated_at: options.generatedAt || new Date().toISOString(),
    source_count: sources.length,
    strategy_counts: byStrategy,
    sources,
    recommended_sequence: recommendedSequence,
    next_builder_step: recommendedSequence[0]?.first_probe || null,
    applied: false,
    consequence_controls: {
      internal_only: true,
      read_only_first: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      network_performed: false,
      destructive_action_performed: false,
      deploy_trade_customer_auth_action_performed: false,
    },
  };
}

function chooseMiraSourceActionSubstrate(source) {
  const key = String(source || '').trim();
  const entry = SOURCE_ACTION_SUBSTRATE_REGISTRY.find((candidate) => candidate.source === key) || null;
  if (!entry) {
    return {
      ok: false,
      decision: 'unknown_source',
      source: key || null,
      applied: false,
    };
  }
  return {
    ok: true,
    decision: 'source_strategy',
    ...cloneEntry(entry),
    applied: false,
  };
}

module.exports = {
  MIRA_SOURCE_ACTION_SUBSTRATE_SCHEMA,
  SOURCE_ACTION_SUBSTRATE_REGISTRY,
  SUBSTRATE_STRATEGIES,
  buildMiraSourceActionSubstratePlan,
  chooseMiraSourceActionSubstrate,
};
