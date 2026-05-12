'use strict';

const {
  MIRA_SOURCE_ACTION_SUBSTRATE_SCHEMA,
  SOURCE_ACTION_SUBSTRATE_REGISTRY,
  SUBSTRATE_STRATEGIES,
  buildMiraSourceActionSubstratePlan,
  chooseMiraSourceActionSubstrate,
} = require('../modules/mira-source-action-substrate');

describe('Mira source/action substrate plan', () => {
  test('maps broad local-world sources to native, MCP-compatible, code-mode, workflow, memory, and evolution strategies', () => {
    const plan = buildMiraSourceActionSubstratePlan({ generatedAt: '2026-05-12T18:35:00.000Z' });

    expect(plan.schema).toBe(MIRA_SOURCE_ACTION_SUBSTRATE_SCHEMA);
    expect(plan.decision).toBe('substrate_plan');
    expect(plan.source_count).toBe(SOURCE_ACTION_SUBSTRATE_REGISTRY.length);
    expect(plan.strategy_counts[SUBSTRATE_STRATEGIES.native_adapter]).toBeGreaterThan(0);
    expect(plan.strategy_counts[SUBSTRATE_STRATEGIES.mcp_connector]).toBeGreaterThan(0);
    expect(plan.strategy_counts[SUBSTRATE_STRATEGIES.code_mode]).toBeGreaterThan(0);
    expect(plan.strategy_counts[SUBSTRATE_STRATEGIES.workflow_dag]).toBeGreaterThan(0);
    expect(plan.strategy_counts[SUBSTRATE_STRATEGIES.active_memory]).toBeGreaterThan(0);
    expect(plan.strategy_counts[SUBSTRATE_STRATEGIES.evolution_loop]).toBeGreaterThan(0);
    expect(plan.consequence_controls).toEqual(expect.objectContaining({
      internal_only: true,
      read_only_first: true,
      external_send_performed: false,
      autonomous_apply_performed: false,
      destructive_action_performed: false,
    }));
  });

  test('puts active code-mode and memory/comms seams before deferred ecosystem connectors', () => {
    const plan = buildMiraSourceActionSubstratePlan({ generatedAt: '2026-05-12T18:35:00.000Z' });

    expect(plan.recommended_sequence[0]).toEqual(expect.objectContaining({
      source: 'code_mode_exploration',
      strategy: SUBSTRATE_STRATEGIES.code_mode,
    }));
    expect(plan.recommended_sequence.map((entry) => entry.source)).toEqual(expect.arrayContaining([
      'memory',
      'runtime_comms',
    ]));
    expect(plan.sources.find((entry) => entry.source === 'memory')).toEqual(expect.objectContaining({
      status: 'active',
      strategy: SUBSTRATE_STRATEGIES.active_memory,
    }));
    expect(plan.sources.find((entry) => entry.source === 'environment_apps')).toEqual(expect.objectContaining({
      status: 'active',
      strategy: SUBSTRATE_STRATEGIES.native_adapter,
    }));
    const browser = plan.sources.find((entry) => entry.source === 'browser_history');
    expect(browser).toEqual(expect.objectContaining({
      strategy: SUBSTRATE_STRATEGIES.native_adapter,
      status: 'active',
    }));
    expect(browser.first_probe).toMatch(/History DB/i);
    const email = plan.sources.find((entry) => entry.source === 'email');
    expect(email).toEqual(expect.objectContaining({
      strategy: SUBSTRATE_STRATEGIES.native_adapter,
      status: 'active',
    }));
    expect(email.first_probe).toMatch(/label counts/i);
  });

  test('chooses a concrete strategy and first probe for a routed source', () => {
    const codeMode = chooseMiraSourceActionSubstrate('code_mode_exploration');
    expect(codeMode).toEqual(expect.objectContaining({
      ok: true,
      decision: 'source_strategy',
      strategy: SUBSTRATE_STRATEGIES.code_mode,
      status: 'active',
    }));
    expect(codeMode.first_probe).toMatch(/JSONL/i);
    expect(codeMode.existing_seams).toContain('hm-mira-self-direction.js code-mode');
  });

  test('can hide deferred connectors for immediate native-first implementation planning', () => {
    const plan = buildMiraSourceActionSubstratePlan({ includeDeferred: false });
    expect(plan.sources.some((entry) => entry.status === 'connector_needed')).toBe(false);
    expect(plan.sources.map((entry) => entry.source)).toEqual(expect.arrayContaining([
      'code_mode_exploration',
      'memory',
      'automation_scheduler',
      'mira_runtime',
    ]));
  });
});
