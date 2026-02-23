/**
 * Workflow Builder IPC Handlers (Task #19)
 *
 * Handles workflow persistence, validation, and execution.
 * Enables saving workflows to file system, validating structure,
 * and executing multi-agent orchestration workflows.
 */

'use strict';

const { dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const MAX_WORKFLOW_FILE_BYTES = 1024 * 1024;

// Workflow storage directory
let workflowsDir = null;

// Shared workflow templates (used by workflow-get-templates and workflow-apply-template)
const WORKFLOW_TEMPLATES = [
  {
    id: 'simple-agent',
    name: 'Simple Agent',
    description: 'Basic workflow with trigger, agent, and output',
    nodes: [
      { id: 'n1', type: 'trigger', label: 'Start', x: 50, y: 100, config: { triggerType: 'manual' } },
      { id: 'n2', type: 'agent', label: 'Process', x: 250, y: 100, config: { agentType: 'claude' } },
      { id: 'n3', type: 'output', label: 'Result', x: 450, y: 100, config: { outputType: 'console' } }
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' }
    ]
  },
  {
    id: 'parallel-agents',
    name: 'Parallel Agents',
    description: 'Run multiple agents in parallel and merge results',
    nodes: [
      { id: 'n1', type: 'trigger', label: 'Start', x: 50, y: 150 },
      { id: 'n2', type: 'parallel', label: 'Split', x: 200, y: 150 },
      { id: 'n3', type: 'agent', label: 'Agent A', x: 350, y: 50 },
      { id: 'n4', type: 'agent', label: 'Agent B', x: 350, y: 150 },
      { id: 'n5', type: 'agent', label: 'Agent C', x: 350, y: 250 },
      { id: 'n6', type: 'merge', label: 'Combine', x: 500, y: 150 },
      { id: 'n7', type: 'output', label: 'Result', x: 650, y: 150 }
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n2', to: 'n4' },
      { id: 'e4', from: 'n2', to: 'n5' },
      { id: 'e5', from: 'n3', to: 'n6' },
      { id: 'e6', from: 'n4', to: 'n6' },
      { id: 'e7', from: 'n5', to: 'n6' },
      { id: 'e8', from: 'n6', to: 'n7' }
    ]
  },
  {
    id: 'conditional-routing',
    name: 'Conditional Routing',
    description: 'Route to different agents based on decision',
    nodes: [
      { id: 'n1', type: 'input', label: 'Input', x: 50, y: 150 },
      { id: 'n2', type: 'decision', label: 'Check Type', x: 200, y: 150, config: { condition: 'input.type === "code"' } },
      { id: 'n3', type: 'agent', label: 'Code Agent', x: 400, y: 50, config: { agentType: 'codex' } },
      { id: 'n4', type: 'agent', label: 'Text Agent', x: 400, y: 250, config: { agentType: 'claude' } },
      { id: 'n5', type: 'output', label: 'Result', x: 600, y: 150 }
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3', label: 'true' },
      { id: 'e3', from: 'n2', to: 'n4', label: 'false' },
      { id: 'e4', from: 'n3', to: 'n5' },
      { id: 'e5', from: 'n4', to: 'n5' }
    ]
  },
  {
    id: 'iteration-loop',
    name: 'Iteration Loop',
    description: 'Process items in a collection one by one',
    nodes: [
      { id: 'n1', type: 'input', label: 'Items', x: 50, y: 100 },
      { id: 'n2', type: 'loop', label: 'For Each', x: 200, y: 100, config: { iteratorVar: 'item' } },
      { id: 'n3', type: 'agent', label: 'Process Item', x: 350, y: 50 },
      { id: 'n4', type: 'output', label: 'Results', x: 350, y: 200 }
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3', label: 'each' },
      { id: 'e3', from: 'n3', to: 'n2' },
      { id: 'e4', from: 'n2', to: 'n4', label: 'done' }
    ]
  },
  {
    id: 'agent-chain',
    name: 'Agent Chain',
    description: 'Chain multiple agents with transformations',
    nodes: [
      { id: 'n1', type: 'trigger', label: 'Start', x: 50, y: 100 },
      { id: 'n2', type: 'agent', label: 'Architect', x: 200, y: 100, config: { prompt: 'Design the solution' } },
      { id: 'n3', type: 'transform', label: 'Format Plan', x: 350, y: 100 },
      { id: 'n4', type: 'agent', label: 'Implementer', x: 500, y: 100, config: { prompt: 'Implement the design' } },
      { id: 'n5', type: 'agent', label: 'Reviewer', x: 650, y: 100, config: { prompt: 'Review the implementation' } },
      { id: 'n6', type: 'output', label: 'Final', x: 800, y: 100 }
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n3', to: 'n4' },
      { id: 'e4', from: 'n4', to: 'n5' },
      { id: 'e5', from: 'n5', to: 'n6' }
    ]
  }
];

/**
 * Initialize workflows directory
 */
function initWorkflowsDir(baseDir) {
  workflowsDir = path.join(baseDir, 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    fs.mkdirSync(workflowsDir, { recursive: true });
  }
  return workflowsDir;
}

/**
 * Get workflow file path
 */
function getWorkflowPath(name) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(workflowsDir, `${safeName}.workflow.json`);
}

function readWorkflowJsonWithSizeGuard(filePath, label = 'Workflow file') {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`${label} is not a file`);
  }
  if (stats.size > MAX_WORKFLOW_FILE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_WORKFLOW_FILE_BYTES} bytes`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    data: JSON.parse(content),
    stats,
  };
}

/**
 * Workflow validation rules
 */
const VALIDATION_RULES = {
  // Check for disconnected nodes
  checkDisconnected: (nodes, edges) => {
    if (nodes.length <= 1) return { valid: true };

    const connected = new Set();
    edges.forEach(edge => {
      connected.add(edge.from);
      connected.add(edge.to);
    });

    const disconnected = nodes.filter(n => !connected.has(n.id));
    if (disconnected.length > 0) {
      return {
        valid: false,
        error: 'disconnected_nodes',
        message: `${disconnected.length} disconnected node(s): ${disconnected.map(n => n.label).join(', ')}`,
        nodes: disconnected.map(n => n.id)
      };
    }
    return { valid: true };
  },

  // Check for cycles (workflow should be DAG for most use cases)
  checkCycles: (nodes, edges) => {
    const graph = new Map();
    nodes.forEach(n => graph.set(n.id, []));
    edges.forEach(e => {
      if (graph.has(e.from)) {
        graph.get(e.from).push(e.to);
      }
    });

    const visited = new Set();
    const recStack = new Set();

    function hasCycle(nodeId) {
      if (recStack.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;

      visited.add(nodeId);
      recStack.add(nodeId);

      const neighbors = graph.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (hasCycle(neighbor)) return true;
      }

      recStack.delete(nodeId);
      return false;
    }

    for (const node of nodes) {
      if (hasCycle(node.id)) {
        return {
          valid: false,
          error: 'cycle_detected',
          message: 'Workflow contains a cycle. Agent workflows should be acyclic.'
        };
      }
    }

    return { valid: true };
  },

  // Check for missing entry point (trigger node)
  checkEntryPoint: (nodes) => {
    const triggers = nodes.filter(n => n.type === 'trigger' || n.type === 'input');
    if (nodes.length > 0 && triggers.length === 0) {
      return {
        valid: false,
        error: 'no_entry_point',
        message: 'Workflow has no entry point. Add a Trigger or Input node.',
        warning: true // This is a warning, not a hard error
      };
    }
    return { valid: true };
  },

  // Check for dangling edges
  checkDanglingEdges: (nodes, edges) => {
    const nodeIds = new Set(nodes.map(n => n.id));
    const dangling = edges.filter(e => !nodeIds.has(e.from) || !nodeIds.has(e.to));
    if (dangling.length > 0) {
      return {
        valid: false,
        error: 'dangling_edges',
        message: `${dangling.length} edge(s) reference missing nodes`,
        edges: dangling.map(e => e.id)
      };
    }
    return { valid: true };
  },

  // Check for empty workflow
  checkEmpty: (nodes) => {
    if (nodes.length === 0) {
      return {
        valid: false,
        error: 'empty_workflow',
        message: 'Workflow is empty. Add nodes to create a workflow.'
      };
    }
    return { valid: true };
  }
};

/**
 * Validate a workflow
 */
function validateWorkflow(workflow, options = {}) {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];
  const errors = [];
  const warnings = [];

  // Run validation rules
  const rules = [
    VALIDATION_RULES.checkEmpty,
    VALIDATION_RULES.checkDanglingEdges,
    VALIDATION_RULES.checkDisconnected,
    VALIDATION_RULES.checkEntryPoint
  ];

  // Only check cycles if strict mode
  if (options.strict) {
    rules.push(VALIDATION_RULES.checkCycles);
  }

  for (const rule of rules) {
    const result = rule(nodes, edges);
    if (!result.valid) {
      if (result.warning) {
        warnings.push(result);
      } else {
        errors.push(result);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      nodeTypes: countNodeTypes(nodes)
    }
  };
}

/**
 * Count nodes by type
 */
function countNodeTypes(nodes) {
  const counts = {};
  nodes.forEach(n => {
    counts[n.type] = (counts[n.type] || 0) + 1;
  });
  return counts;
}

/**
 * Topological sort for execution order
 */
function topologicalSort(nodes, edges) {
  const graph = new Map();
  const inDegree = new Map();

  nodes.forEach(n => {
    graph.set(n.id, []);
    inDegree.set(n.id, 0);
  });

  edges.forEach(e => {
    if (graph.has(e.from)) {
      graph.get(e.from).push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    }
  });

  const queue = [];
  const sorted = [];

  // Start with nodes that have no incoming edges
  nodes.forEach(n => {
    if (inDegree.get(n.id) === 0) {
      queue.push(n.id);
    }
  });

  while (queue.length > 0) {
    const nodeId = queue.shift();
    sorted.push(nodeId);

    const neighbors = graph.get(nodeId) || [];
    neighbors.forEach(neighbor => {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
      }
    });
  }

  // Check if all nodes were sorted (no cycle)
  if (sorted.length !== nodes.length) {
    return { success: false, error: 'Workflow contains cycles' };
  }

  return { success: true, order: sorted };
}

/**
 * Generate execution plan from workflow
 */
function generateExecutionPlan(workflow) {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];

  // Validate first
  const validation = validateWorkflow(workflow, { strict: true });
  if (!validation.valid) {
    return {
      success: false,
      error: 'Validation failed',
      validation
    };
  }

  // Get execution order
  const sortResult = topologicalSort(nodes, edges);
  if (!sortResult.success) {
    return {
      success: false,
      error: sortResult.error
    };
  }

  // Build execution plan
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const plan = sortResult.order.map(nodeId => {
    const node = nodeMap.get(nodeId);
    const inputs = edges.filter(e => e.to === nodeId).map(e => e.from);
    const outputs = edges.filter(e => e.from === nodeId).map(e => e.to);

    return {
      nodeId,
      type: node.type,
      label: node.label,
      config: node.config || {},
      inputs,
      outputs
    };
  });

  return {
    success: true,
    plan,
    stats: validation.stats
  };
}

/**
 * Register workflow IPC handlers
 */
function registerWorkflowHandlers(ctx = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerWorkflowHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const baseDir = ctx.workspaceDir || ctx.WORKSPACE_PATH || process.cwd();
  initWorkflowsDir(baseDir);

  // List saved workflows
  ipcMain.handle('workflow-list', async () => {
    try {
      if (!fs.existsSync(workflowsDir)) {
        return { success: true, workflows: [] };
      }

      const files = fs.readdirSync(workflowsDir)
        .filter(f => f.endsWith('.workflow.json'));

      const workflows = files.map(file => {
        const filePath = path.join(workflowsDir, file);
        try {
          const { data, stats } = readWorkflowJsonWithSizeGuard(filePath, `Workflow ${file}`);

          return {
            name: data.name || file.replace('.workflow.json', ''),
            file,
            path: filePath,
            nodeCount: (data.nodes || []).length,
            edgeCount: (data.edges || []).length,
            created: data.created,
            modified: stats.mtime.toISOString(),
            description: data.description || ''
          };
        } catch (err) {
          return {
            name: file.replace('.workflow.json', ''),
            file,
            path: filePath,
            error: err.message
          };
        }
      });

      return { success: true, workflows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Save workflow to file
  ipcMain.handle('workflow-save', async (event, { name, workflow, overwrite = false }) => {
    try {
      if (!name || !name.trim()) {
        return { success: false, error: 'Workflow name is required' };
      }

      const filePath = getWorkflowPath(name);

      if (!overwrite && fs.existsSync(filePath)) {
        return { success: false, error: 'Workflow already exists', exists: true };
      }

      const payload = {
        version: 2,
        name: name.trim(),
        description: workflow.description || '',
        created: workflow.created || new Date().toISOString(),
        modified: new Date().toISOString(),
        nodes: workflow.nodes || [],
        edges: workflow.edges || [],
        metadata: workflow.metadata || {}
      };

      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

      return {
        success: true,
        path: filePath,
        name: payload.name
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Load workflow from file
  ipcMain.handle('workflow-load', async (event, { name }) => {
    try {
      const filePath = getWorkflowPath(name);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Workflow not found' };
      }

      const { data: workflow } = readWorkflowJsonWithSizeGuard(filePath, `Workflow ${name}`);

      return {
        success: true,
        workflow,
        path: filePath
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Delete workflow
  ipcMain.handle('workflow-delete', async (event, { name }) => {
    try {
      const filePath = getWorkflowPath(name);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Workflow not found' };
      }

      fs.unlinkSync(filePath);

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Duplicate workflow
  ipcMain.handle('workflow-duplicate', async (event, { name, newName }) => {
    try {
      const srcPath = getWorkflowPath(name);
      const destPath = getWorkflowPath(newName);

      if (!fs.existsSync(srcPath)) {
        return { success: false, error: 'Source workflow not found' };
      }

      if (fs.existsSync(destPath)) {
        return { success: false, error: 'Destination workflow already exists' };
      }

      const { data: workflow } = readWorkflowJsonWithSizeGuard(srcPath, `Workflow ${name}`);

      workflow.name = newName;
      workflow.created = new Date().toISOString();
      workflow.modified = new Date().toISOString();

      fs.writeFileSync(destPath, JSON.stringify(workflow, null, 2));

      return { success: true, path: destPath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Validate workflow
  ipcMain.handle('workflow-validate', async (event, { workflow, options = {} }) => {
    try {
      const result = validateWorkflow(workflow, options);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Generate execution plan
  ipcMain.handle('workflow-generate-plan', async (event, { workflow }) => {
    try {
      const result = generateExecutionPlan(workflow);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Export workflow to file (user picks location)
  ipcMain.handle('workflow-export-file', async (event, { workflow, defaultName }) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: 'Export Workflow',
        defaultPath: `${defaultName || 'workflow'}.json`,
        filters: [
          { name: 'Workflow Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (canceled || !filePath) {
        return { success: false, canceled: true };
      }

      const payload = {
        version: 2,
        exportedAt: new Date().toISOString(),
        name: workflow.name || defaultName || 'Untitled',
        description: workflow.description || '',
        nodes: workflow.nodes || [],
        edges: workflow.edges || [],
        metadata: workflow.metadata || {}
      };

      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

      return { success: true, path: filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Import workflow from file (user picks file)
  ipcMain.handle('workflow-import-file', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const { filePaths, canceled } = await dialog.showOpenDialog(win, {
        title: 'Import Workflow',
        filters: [
          { name: 'Workflow Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (canceled || !filePaths || filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const filePath = filePaths[0];
      const { data: workflow } = readWorkflowJsonWithSizeGuard(filePath, 'Imported workflow file');

      // Validate structure
      if (!Array.isArray(workflow.nodes)) {
        return { success: false, error: 'Invalid workflow: missing nodes array' };
      }

      return {
        success: true,
        workflow,
        path: filePath
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get node type definitions
  ipcMain.handle('workflow-get-node-types', async () => {
    const nodeTypes = {
      trigger: {
        id: 'trigger',
        label: 'Trigger',
        description: 'Entry point that starts workflow execution',
        color: 'rgba(255, 184, 108, 0.5)',
        icon: 'play',
        category: 'control',
        ports: { inputs: 0, outputs: 1 },
        config: [
          { key: 'triggerType', label: 'Trigger Type', type: 'select', options: ['manual', 'scheduled', 'file_watch', 'webhook'] },
          { key: 'schedule', label: 'Schedule (cron)', type: 'text', showIf: { triggerType: 'scheduled' } }
        ]
      },
      agent: {
        id: 'agent',
        label: 'Agent',
        description: 'AI agent that processes input and produces output',
        color: 'rgba(80, 250, 123, 0.5)',
        icon: 'brain',
        category: 'processing',
        ports: { inputs: 1, outputs: 1 },
        config: [
          { key: 'agentType', label: 'Agent Type', type: 'select', options: ['claude', 'codex', 'gemini', 'custom'] },
          { key: 'prompt', label: 'System Prompt', type: 'textarea' },
          { key: 'model', label: 'Model', type: 'text' },
          { key: 'maxTokens', label: 'Max Tokens', type: 'number' }
        ]
      },
      tool: {
        id: 'tool',
        label: 'Tool',
        description: 'External tool or function call',
        color: 'rgba(139, 233, 253, 0.5)',
        icon: 'wrench',
        category: 'processing',
        ports: { inputs: 1, outputs: 1 },
        config: [
          { key: 'toolName', label: 'Tool Name', type: 'text' },
          { key: 'parameters', label: 'Parameters (JSON)', type: 'textarea' }
        ]
      },
      decision: {
        id: 'decision',
        label: 'Decision',
        description: 'Conditional branching based on input',
        color: 'rgba(189, 147, 249, 0.5)',
        icon: 'split',
        category: 'control',
        ports: { inputs: 1, outputs: 2 },
        config: [
          { key: 'condition', label: 'Condition', type: 'text' },
          { key: 'trueLabel', label: 'True Branch Label', type: 'text' },
          { key: 'falseLabel', label: 'False Branch Label', type: 'text' }
        ]
      },
      input: {
        id: 'input',
        label: 'Input',
        description: 'External data input to workflow',
        color: 'rgba(255, 121, 198, 0.5)',
        icon: 'download',
        category: 'io',
        ports: { inputs: 0, outputs: 1 },
        config: [
          { key: 'inputType', label: 'Input Type', type: 'select', options: ['text', 'file', 'api', 'variable'] },
          { key: 'source', label: 'Source', type: 'text' }
        ]
      },
      output: {
        id: 'output',
        label: 'Output',
        description: 'Workflow output destination',
        color: 'rgba(98, 114, 164, 0.5)',
        icon: 'upload',
        category: 'io',
        ports: { inputs: 1, outputs: 0 },
        config: [
          { key: 'outputType', label: 'Output Type', type: 'select', options: ['console', 'file', 'api', 'variable'] },
          { key: 'destination', label: 'Destination', type: 'text' }
        ]
      },
      loop: {
        id: 'loop',
        label: 'Loop',
        description: 'Iterate over a collection',
        color: 'rgba(241, 250, 140, 0.5)',
        icon: 'repeat',
        category: 'control',
        ports: { inputs: 1, outputs: 2 },
        config: [
          { key: 'iteratorVar', label: 'Iterator Variable', type: 'text' },
          { key: 'collection', label: 'Collection Expression', type: 'text' },
          { key: 'maxIterations', label: 'Max Iterations', type: 'number' }
        ]
      },
      parallel: {
        id: 'parallel',
        label: 'Parallel',
        description: 'Execute multiple branches simultaneously',
        color: 'rgba(255, 85, 85, 0.5)',
        icon: 'columns',
        category: 'control',
        ports: { inputs: 1, outputs: 3 },
        config: [
          { key: 'waitAll', label: 'Wait for All', type: 'checkbox' },
          { key: 'timeout', label: 'Timeout (ms)', type: 'number' }
        ]
      },
      merge: {
        id: 'merge',
        label: 'Merge',
        description: 'Combine multiple inputs into one',
        color: 'rgba(68, 71, 90, 0.5)',
        icon: 'compress',
        category: 'control',
        ports: { inputs: 3, outputs: 1 },
        config: [
          { key: 'strategy', label: 'Merge Strategy', type: 'select', options: ['concat', 'object', 'first', 'last'] }
        ]
      },
      transform: {
        id: 'transform',
        label: 'Transform',
        description: 'Transform data between nodes',
        color: 'rgba(139, 233, 253, 0.3)',
        icon: 'exchange',
        category: 'processing',
        ports: { inputs: 1, outputs: 1 },
        config: [
          { key: 'expression', label: 'Transform Expression', type: 'textarea' },
          { key: 'format', label: 'Output Format', type: 'select', options: ['json', 'text', 'array'] }
        ]
      },
      subworkflow: {
        id: 'subworkflow',
        label: 'Subworkflow',
        description: 'Execute another workflow',
        color: 'rgba(80, 250, 123, 0.3)',
        icon: 'sitemap',
        category: 'advanced',
        ports: { inputs: 1, outputs: 1 },
        config: [
          { key: 'workflowName', label: 'Workflow Name', type: 'text' },
          { key: 'inputMapping', label: 'Input Mapping (JSON)', type: 'textarea' },
          { key: 'outputMapping', label: 'Output Mapping (JSON)', type: 'textarea' }
        ]
      },
      delay: {
        id: 'delay',
        label: 'Delay',
        description: 'Wait for a specified time',
        color: 'rgba(98, 114, 164, 0.3)',
        icon: 'clock',
        category: 'control',
        ports: { inputs: 1, outputs: 1 },
        config: [
          { key: 'duration', label: 'Duration (ms)', type: 'number' },
          { key: 'dynamic', label: 'Dynamic Delay', type: 'checkbox' },
          { key: 'expression', label: 'Delay Expression', type: 'text', showIf: { dynamic: true } }
        ]
      }
    };

    return { success: true, nodeTypes };
  });

  // Get workflow templates
  ipcMain.handle('workflow-get-templates', async () => {
    return { success: true, templates: WORKFLOW_TEMPLATES };
  });

  // Apply template
  ipcMain.handle('workflow-apply-template', async (event, { templateId }) => {
    const template = WORKFLOW_TEMPLATES.find(t => t.id === templateId);
    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    // Generate new IDs to avoid conflicts
    const idMap = new Map();
    const nodes = template.nodes.map(n => {
      const newId = `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      idMap.set(n.id, newId);
      return { ...n, id: newId };
    });

    const edges = template.edges.map(e => ({
      ...e,
      id: `edge-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      from: idMap.get(e.from),
      to: idMap.get(e.to)
    }));

    return {
      success: true,
      workflow: {
        name: template.name,
        description: template.description,
        nodes,
        edges
      }
    };
  });

}


function unregisterWorkflowHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('workflow-list');
    ipcMain.removeHandler('workflow-save');
    ipcMain.removeHandler('workflow-load');
    ipcMain.removeHandler('workflow-delete');
    ipcMain.removeHandler('workflow-duplicate');
    ipcMain.removeHandler('workflow-validate');
    ipcMain.removeHandler('workflow-generate-plan');
    ipcMain.removeHandler('workflow-export-file');
    ipcMain.removeHandler('workflow-import-file');
    ipcMain.removeHandler('workflow-get-node-types');
    ipcMain.removeHandler('workflow-get-templates');
    ipcMain.removeHandler('workflow-apply-template');
}

registerWorkflowHandlers.unregister = unregisterWorkflowHandlers;
module.exports = {
  registerWorkflowHandlers,
  validateWorkflow,
  generateExecutionPlan,
  topologicalSort
};
