/**
 * Workflow Handlers Tests
 * Target: Coverage for workflow-handlers.js pure functions + IPC handlers
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// We need to test the exported pure functions AND the IPC handler registration
const {
  validateWorkflow,
  generateExecutionPlan,
  topologicalSort,
  registerWorkflowHandlers
} = require('../modules/ipc/workflow-handlers');

// ── Pure function tests ──────────────────────────────────────────────

describe('validateWorkflow', () => {
  test('returns valid for a well-formed workflow', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'Start' },
        { id: 'n2', type: 'agent', label: 'Process' },
        { id: 'n3', type: 'output', label: 'End' }
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3' }
      ]
    };
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.nodes).toBe(3);
    expect(result.stats.edges).toBe(2);
    expect(result.stats.nodeTypes).toEqual({ trigger: 1, agent: 1, output: 1 });
  });

  test('catches empty workflow', () => {
    const result = validateWorkflow({ nodes: [], edges: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.error === 'empty_workflow')).toBe(true);
  });

  test('catches disconnected nodes', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'Start' },
        { id: 'n2', type: 'agent', label: 'Connected' },
        { id: 'n3', type: 'output', label: 'Orphan' }
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }]
    };
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.error === 'disconnected_nodes')).toBe(true);
    expect(result.errors.find(e => e.error === 'disconnected_nodes').nodes).toContain('n3');
  });

  test('single node is valid (no disconnected check needed)', () => {
    const wf = {
      nodes: [{ id: 'n1', type: 'trigger', label: 'Solo' }],
      edges: []
    };
    const result = validateWorkflow(wf);
    // single node triggers "no entry point" as warning only if type isn't trigger
    expect(result.errors.filter(e => e.error === 'disconnected_nodes')).toHaveLength(0);
  });

  test('catches dangling edges', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'Start' },
        { id: 'n2', type: 'agent', label: 'End' }
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n1', to: 'missing_node' }
      ]
    };
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.error === 'dangling_edges')).toBe(true);
  });

  test('warns when no entry point (trigger/input) exists', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'agent', label: 'A' },
        { id: 'n2', type: 'output', label: 'B' }
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }]
    };
    const result = validateWorkflow(wf);
    // no_entry_point is a warning, not an error
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.error === 'no_entry_point')).toBe(true);
  });

  test('input node counts as entry point', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'input', label: 'In' },
        { id: 'n2', type: 'output', label: 'Out' }
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }]
    };
    const result = validateWorkflow(wf);
    expect(result.warnings.some(w => w.error === 'no_entry_point')).toBe(false);
  });

  test('detects cycles in strict mode', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'A' },
        { id: 'n2', type: 'agent', label: 'B' },
        { id: 'n3', type: 'agent', label: 'C' }
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3' },
        { id: 'e3', from: 'n3', to: 'n2' } // cycle: n2 → n3 → n2
      ]
    };
    const result = validateWorkflow(wf, { strict: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.error === 'cycle_detected')).toBe(true);
  });

  test('skips cycle check in non-strict mode', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'A' },
        { id: 'n2', type: 'agent', label: 'B' },
        { id: 'n3', type: 'agent', label: 'C' }
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3' },
        { id: 'e3', from: 'n3', to: 'n2' }
      ]
    };
    const result = validateWorkflow(wf);
    expect(result.errors.some(e => e.error === 'cycle_detected')).toBe(false);
  });

  test('handles missing nodes/edges gracefully', () => {
    const result = validateWorkflow({});
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.error === 'empty_workflow')).toBe(true);
  });
});

describe('topologicalSort', () => {
  test('sorts a linear chain', () => {
    const nodes = [
      { id: 'a' }, { id: 'b' }, { id: 'c' }
    ];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' }
    ];
    const result = topologicalSort(nodes, edges);
    expect(result.success).toBe(true);
    expect(result.order).toEqual(['a', 'b', 'c']);
  });

  test('sorts a diamond graph', () => {
    const nodes = [
      { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }
    ];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' }
    ];
    const result = topologicalSort(nodes, edges);
    expect(result.success).toBe(true);
    expect(result.order.indexOf('a')).toBe(0);
    expect(result.order.indexOf('d')).toBe(3);
  });

  test('detects cycles', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' }
    ];
    const result = topologicalSort(nodes, edges);
    expect(result.success).toBe(false);
    expect(result.error).toContain('cycle');
  });

  test('handles single node', () => {
    const result = topologicalSort([{ id: 'x' }], []);
    expect(result.success).toBe(true);
    expect(result.order).toEqual(['x']);
  });

  test('handles empty graph', () => {
    const result = topologicalSort([], []);
    expect(result.success).toBe(true);
    expect(result.order).toEqual([]);
  });

  test('handles edges referencing unknown nodes', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'ghost', to: 'b' } // ghost not in nodes
    ];
    const result = topologicalSort(nodes, edges);
    // Should still sort the known nodes
    expect(result.success).toBe(true);
    expect(result.order).toContain('a');
    expect(result.order).toContain('b');
  });
});

describe('generateExecutionPlan', () => {
  test('generates plan for valid linear workflow', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'Start', config: { triggerType: 'manual' } },
        { id: 'n2', type: 'agent', label: 'Process', config: { agentType: 'claude' } },
        { id: 'n3', type: 'output', label: 'Result' }
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3' }
      ]
    };
    const result = generateExecutionPlan(wf);
    expect(result.success).toBe(true);
    expect(result.plan).toHaveLength(3);
    expect(result.plan[0].nodeId).toBe('n1');
    expect(result.plan[0].inputs).toEqual([]);
    expect(result.plan[0].outputs).toEqual(['n2']);
    expect(result.plan[1].nodeId).toBe('n2');
    expect(result.plan[1].config).toEqual({ agentType: 'claude' });
    expect(result.plan[2].nodeId).toBe('n3');
    expect(result.stats.nodes).toBe(3);
  });

  test('fails for empty workflow', () => {
    const result = generateExecutionPlan({ nodes: [], edges: [] });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Validation failed');
    expect(result.validation.valid).toBe(false);
  });

  test('fails for cyclic workflow (strict mode)', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'A' },
        { id: 'n2', type: 'agent', label: 'B' },
        { id: 'n3', type: 'agent', label: 'C' }
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3' },
        { id: 'e3', from: 'n3', to: 'n2' }
      ]
    };
    const result = generateExecutionPlan(wf);
    expect(result.success).toBe(false);
  });

  test('node without config gets empty object', () => {
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'Start' },
        { id: 'n2', type: 'output', label: 'End' }
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }]
    };
    const result = generateExecutionPlan(wf);
    expect(result.success).toBe(true);
    expect(result.plan[0].config).toEqual({});
  });
});

// ── IPC handler tests ────────────────────────────────────────────────

describe('registerWorkflowHandlers', () => {
  let handlers;
  let mockIpcMain;
  let tmpDir;

  beforeEach(() => {
    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, fn) => { handlers[channel] = fn; }),
      removeHandler: jest.fn()
    };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function register() {
    registerWorkflowHandlers({ ipcMain: mockIpcMain, workspaceDir: tmpDir });
  }

  test('throws without ctx.ipcMain', () => {
    expect(() => registerWorkflowHandlers()).toThrow('requires ctx.ipcMain');
    expect(() => registerWorkflowHandlers({})).toThrow('requires ctx.ipcMain');
  });

  test('registers expected handler channels', () => {
    register();
    const channels = mockIpcMain.handle.mock.calls.map(c => c[0]);
    expect(channels).toContain('workflow-list');
    expect(channels).toContain('workflow-save');
    expect(channels).toContain('workflow-load');
    expect(channels).toContain('workflow-delete');
    expect(channels).toContain('workflow-duplicate');
    expect(channels).toContain('workflow-validate');
    expect(channels).toContain('workflow-generate-plan');
    expect(channels).toContain('workflow-get-node-types');
    expect(channels).toContain('workflow-get-templates');
    expect(channels).toContain('workflow-apply-template');
  });

  test('creates workflows directory', () => {
    register();
    const wfDir = path.join(tmpDir, 'workflows');
    expect(fs.existsSync(wfDir)).toBe(true);
  });

  // ── workflow-list ──

  test('workflow-list returns empty array initially', async () => {
    register();
    const result = await handlers['workflow-list']();
    expect(result.success).toBe(true);
    expect(result.workflows).toEqual([]);
  });

  test('workflow-list returns saved workflows', async () => {
    register();
    const wfDir = path.join(tmpDir, 'workflows');
    const payload = { name: 'test', nodes: [{ id: 'n1' }], edges: [] };
    fs.writeFileSync(path.join(wfDir, 'test.workflow.json'), JSON.stringify(payload));

    const result = await handlers['workflow-list']();
    expect(result.success).toBe(true);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].name).toBe('test');
    expect(result.workflows[0].nodeCount).toBe(1);
  });

  test('workflow-list handles corrupt files', async () => {
    register();
    const wfDir = path.join(tmpDir, 'workflows');
    fs.writeFileSync(path.join(wfDir, 'bad.workflow.json'), 'not json!');

    const result = await handlers['workflow-list']();
    expect(result.success).toBe(true);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].error).toBeDefined();
  });

  // ── workflow-save ──

  test('workflow-save creates a file', async () => {
    register();
    const wf = { nodes: [{ id: 'n1' }], edges: [] };
    const result = await handlers['workflow-save'](null, { name: 'my-wf', workflow: wf });
    expect(result.success).toBe(true);
    expect(result.name).toBe('my-wf');
    expect(fs.existsSync(result.path)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.nodes).toHaveLength(1);
  });

  test('workflow-save rejects empty name', async () => {
    register();
    const result = await handlers['workflow-save'](null, { name: '', workflow: {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  test('workflow-save blocks overwrite by default', async () => {
    register();
    const wf = { nodes: [], edges: [] };
    await handlers['workflow-save'](null, { name: 'dup', workflow: wf });
    const result = await handlers['workflow-save'](null, { name: 'dup', workflow: wf });
    expect(result.success).toBe(false);
    expect(result.exists).toBe(true);
  });

  test('workflow-save allows overwrite when flag set', async () => {
    register();
    const wf = { nodes: [], edges: [] };
    await handlers['workflow-save'](null, { name: 'dup', workflow: wf });
    const result = await handlers['workflow-save'](null, { name: 'dup', workflow: wf, overwrite: true });
    expect(result.success).toBe(true);
  });

  // ── workflow-load ──

  test('workflow-load reads saved file', async () => {
    register();
    const wf = { nodes: [{ id: 'n1' }], edges: [], description: 'hello' };
    await handlers['workflow-save'](null, { name: 'loadme', workflow: wf });
    const result = await handlers['workflow-load'](null, { name: 'loadme' });
    expect(result.success).toBe(true);
    expect(result.workflow.name).toBe('loadme');
    expect(result.workflow.description).toBe('hello');
  });

  test('workflow-load returns error for missing file', async () => {
    register();
    const result = await handlers['workflow-load'](null, { name: 'nonexistent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  // ── workflow-delete ──

  test('workflow-delete removes file', async () => {
    register();
    await handlers['workflow-save'](null, { name: 'delme', workflow: { nodes: [], edges: [] } });
    const result = await handlers['workflow-delete'](null, { name: 'delme' });
    expect(result.success).toBe(true);

    const list = await handlers['workflow-list']();
    expect(list.workflows).toHaveLength(0);
  });

  test('workflow-delete returns error for missing file', async () => {
    register();
    const result = await handlers['workflow-delete'](null, { name: 'ghost' });
    expect(result.success).toBe(false);
  });

  // ── workflow-duplicate ──

  test('workflow-duplicate copies workflow with new name', async () => {
    register();
    await handlers['workflow-save'](null, { name: 'orig', workflow: { nodes: [{ id: 'x' }], edges: [] } });
    const result = await handlers['workflow-duplicate'](null, { name: 'orig', newName: 'copy' });
    expect(result.success).toBe(true);

    const loaded = await handlers['workflow-load'](null, { name: 'copy' });
    expect(loaded.workflow.name).toBe('copy');
  });

  test('workflow-duplicate fails if source missing', async () => {
    register();
    const result = await handlers['workflow-duplicate'](null, { name: 'nope', newName: 'copy' });
    expect(result.success).toBe(false);
  });

  test('workflow-duplicate fails if dest exists', async () => {
    register();
    await handlers['workflow-save'](null, { name: 'a', workflow: { nodes: [], edges: [] } });
    await handlers['workflow-save'](null, { name: 'b', workflow: { nodes: [], edges: [] } });
    const result = await handlers['workflow-duplicate'](null, { name: 'a', newName: 'b' });
    expect(result.success).toBe(false);
  });

  // ── workflow-validate ──

  test('workflow-validate delegates to validateWorkflow', async () => {
    register();
    const wf = {
      nodes: [{ id: 'n1', type: 'trigger', label: 'S' }],
      edges: []
    };
    const result = await handlers['workflow-validate'](null, { workflow: wf });
    expect(result.success).toBe(true);
    expect(result.valid).toBe(true);
  });

  test('workflow-validate passes options through', async () => {
    register();
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'A' },
        { id: 'n2', type: 'agent', label: 'B' }
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n1' }
      ]
    };
    const result = await handlers['workflow-validate'](null, { workflow: wf, options: { strict: true } });
    expect(result.valid).toBe(false);
  });

  // ── workflow-generate-plan ──

  test('workflow-generate-plan returns execution plan', async () => {
    register();
    const wf = {
      nodes: [
        { id: 'n1', type: 'trigger', label: 'Start' },
        { id: 'n2', type: 'output', label: 'End' }
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }]
    };
    const result = await handlers['workflow-generate-plan'](null, { workflow: wf });
    expect(result.success).toBe(true);
    expect(result.plan).toHaveLength(2);
  });

  // ── workflow-get-node-types ──

  test('workflow-get-node-types returns all node type definitions', async () => {
    register();
    const result = await handlers['workflow-get-node-types']();
    expect(result.success).toBe(true);
    expect(result.nodeTypes.trigger).toBeDefined();
    expect(result.nodeTypes.agent).toBeDefined();
    expect(result.nodeTypes.decision).toBeDefined();
    expect(result.nodeTypes.output).toBeDefined();
    expect(result.nodeTypes.loop).toBeDefined();
    expect(result.nodeTypes.parallel).toBeDefined();
    expect(result.nodeTypes.merge).toBeDefined();
    expect(result.nodeTypes.transform).toBeDefined();
    expect(result.nodeTypes.subworkflow).toBeDefined();
    expect(result.nodeTypes.delay).toBeDefined();
  });

  // ── workflow-get-templates ──

  test('workflow-get-templates returns template list', async () => {
    register();
    const result = await handlers['workflow-get-templates']();
    expect(result.success).toBe(true);
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.templates[0].id).toBeDefined();
    expect(result.templates[0].nodes).toBeDefined();
  });

  // ── workflow-apply-template ──

  test('workflow-apply-template generates new IDs', async () => {
    register();
    const result = await handlers['workflow-apply-template'](null, { templateId: 'simple-agent' });
    expect(result.success).toBe(true);
    expect(result.workflow.nodes).toHaveLength(3);
    // IDs should be regenerated, not the original n1/n2/n3
    expect(result.workflow.nodes[0].id).not.toBe('n1');
    // Edges should reference the new IDs
    const nodeIds = new Set(result.workflow.nodes.map(n => n.id));
    result.workflow.edges.forEach(e => {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    });
  });

  test('workflow-apply-template fails for unknown template', async () => {
    register();
    const result = await handlers['workflow-apply-template'](null, { templateId: 'nonexistent' });
    expect(result.success).toBe(false);
  });

  // ── unregister ──

  test('unregister removes all handlers', () => {
    register();
    registerWorkflowHandlers.unregister({ ipcMain: mockIpcMain });
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('workflow-list');
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('workflow-save');
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('workflow-load');
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('workflow-delete');
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('workflow-duplicate');
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('workflow-validate');
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('workflow-generate-plan');
  });

  test('unregister handles missing ipcMain gracefully', () => {
    expect(() => registerWorkflowHandlers.unregister()).not.toThrow();
    expect(() => registerWorkflowHandlers.unregister({})).not.toThrow();
  });
});
