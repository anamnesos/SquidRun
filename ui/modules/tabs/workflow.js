/**
 * Workflow Builder Tab Module
 * Extracted from tabs.js for maintainability
 * Task #19 - Workflow Builder
 */


// Workflow builder state
const workflowState = {
  nodes: [],
  edges: [],
  selectedNodeId: null,
  connectMode: false,
  connectingFrom: null,
  drag: null,
  canvas: null,
  nodesEl: null,
  edgesEl: null,
  emptyEl: null,
  inspectorEl: null,
  statusEl: null,
  statsEl: null,
  connectBtn: null,
  lastSaved: null,
  // Enhanced state for Task #19
  nodeTypes: null,
  templates: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStart: { x: 0, y: 0 },
  workflowName: 'Untitled Workflow',
  workflowDescription: '',
  undoStack: [],
  redoStack: [],
  clipboard: null,
  validationResult: null,
  executionPlan: null
};

const WORKFLOW_STORAGE_KEY = 'hivemind-workflow-v2';
const WORKFLOW_NODE_TYPES = {
  trigger: 'Trigger',
  agent: 'Agent',
  tool: 'Tool',
  decision: 'Decision',
  input: 'Input',
  output: 'Output',
  loop: 'Loop',
  parallel: 'Parallel',
  merge: 'Merge',
  transform: 'Transform',
  subworkflow: 'Subworkflow',
  delay: 'Delay'
};

// Node categories for toolbar grouping
const WORKFLOW_NODE_CATEGORIES = {
  control: ['trigger', 'decision', 'loop', 'parallel', 'merge', 'delay'],
  processing: ['agent', 'tool', 'transform'],
  io: ['input', 'output'],
  advanced: ['subworkflow']
};

// Node colors by type
const NODE_COLORS = {
  file: '#8be9fd',
  agent: '#50fa7b',
  decision: '#bd93f9',
  error: '#ff5555',
  task: '#ffb86c',
  concept: '#f1fa8c',
  session: '#ff79c6',
  message: '#6272a4'
};

/**
 * Setup the Knowledge Graph tab
 */
function setupGraphTab() {
  const searchInput = document.getElementById('graphSearchInput');
  const searchBtn = document.getElementById('graphSearchBtn');
  const refreshBtn = document.getElementById('graphRefreshBtn');
  const saveBtn = document.getElementById('graphSaveBtn');
  const resetViewBtn = document.getElementById('graphResetViewBtn');
  const canvas = document.getElementById('graphCanvas');
  const filterBtns = document.querySelectorAll('.graph-filter-btn');
  const legendItems = document.querySelectorAll('.graph-legend-item');

  if (!canvas) return;

  graphState.canvas = canvas;
  graphState.ctx = canvas.getContext('2d');

  // Search functionality
  if (searchBtn) {
    searchBtn.addEventListener('click', () => searchGraph());
  }
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchGraph();
    });
  }

  // Filter buttons
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      graphState.filter = btn.dataset.type;
      renderGraph();
    });
  });

  // Legend toggle
  legendItems.forEach(item => {
    item.addEventListener('click', () => {
      item.classList.toggle('dimmed');
      renderGraph();
    });
  });

  // Refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshGraphData());
  }

  // Save button
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveGraph());
  }

  // Reset view button
  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => {
      graphState.scale = 1;
      graphState.offsetX = 0;
      graphState.offsetY = 0;
      renderGraph();
    });
  }

  // Canvas interactions
  setupCanvasInteractions(canvas);

  // Initial data load
  refreshGraphData();
}

/**
 * Setup canvas mouse interactions for pan/zoom/select
 */
function setupCanvasInteractions(canvas) {
  if (!canvas) return;

  // Mouse down - start drag or select node
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - graphState.offsetX) / graphState.scale;
    const y = (e.clientY - rect.top - graphState.offsetY) / graphState.scale;

    // Check if clicked on a node
    const clickedNode = findNodeAtPosition(x, y);
    if (clickedNode) {
      selectNode(clickedNode);
    } else {
      // Start panning
      graphState.isDragging = true;
      graphState.dragStart = { x: e.clientX, y: e.clientY };
    }
  });

  // Mouse move - pan
  canvas.addEventListener('mousemove', (e) => {
    if (graphState.isDragging) {
      const dx = e.clientX - graphState.dragStart.x;
      const dy = e.clientY - graphState.dragStart.y;
      graphState.offsetX += dx;
      graphState.offsetY += dy;
      graphState.dragStart = { x: e.clientX, y: e.clientY };
      renderGraph();
    }
  });

  // Mouse up - stop drag
  canvas.addEventListener('mouseup', () => {
    graphState.isDragging = false;
  });

  canvas.addEventListener('mouseleave', () => {
    graphState.isDragging = false;
  });

  // Mouse wheel - zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(graphState.scale * zoomFactor, 0.1), 5);

    // Adjust offset to zoom toward mouse position
    graphState.offsetX = mouseX - (mouseX - graphState.offsetX) * (newScale / graphState.scale);
    graphState.offsetY = mouseY - (mouseY - graphState.offsetY) * (newScale / graphState.scale);
    graphState.scale = newScale;

    renderGraph();
  });
}

/**
 * Find node at canvas position
 */
function findNodeAtPosition(x, y) {
  for (const node of graphState.nodes) {
    const pos = graphState.nodePositions.get(node.id);
    if (pos) {
      const dx = x - pos.x;
      const dy = y - pos.y;
      const radius = getNodeRadius(node);
      if (dx * dx + dy * dy < radius * radius) {
        return node;
      }
    }
  }
  return null;
}

/**
 * Get node radius based on type
 */
function getNodeRadius(node) {
  if (node.type === 'agent') return 20;
  if (node.type === 'file') return 12;
  return 15;
}

/**
 * Search the knowledge graph
 */
async function searchGraph() {
  const input = document.getElementById('graphSearchInput');
  if (!input || !input.value.trim()) {
    refreshGraphData();
    return;
  }

  graphState.searchQuery = input.value.trim();

  try {
    const result = await window.ipcRenderer.invoke('graph-query', {
      query: graphState.searchQuery,
      maxDepth: 3,
      maxResults: 100
    });

    if (result.success) {
      graphState.nodes = result.results.nodes || [];
      graphState.edges = result.results.edges || [];
      calculateNodePositions();
      renderGraph();
      updateGraphStats();
      hideEmptyState();
    } else {
      console.error('[GraphTab] Search failed:', result.error);
    }
  } catch (err) {
    console.error('[GraphTab] Search error:', err);
  }
}

/**
 * Refresh graph data from backend
 */
async function refreshGraphData() {
  try {
    const result = await window.ipcRenderer.invoke('graph-visualize', {});

    if (result.success) {
      graphState.nodes = result.data.nodes || [];
      graphState.edges = result.data.edges || [];
      graphState.lastUpdate = new Date();

      calculateNodePositions();
      renderGraph();
      updateGraphStats();
      updateLastUpdateTime();

      if (graphState.nodes.length > 0) {
        hideEmptyState();
      } else {
        showEmptyState();
      }
    } else {
      console.error('[GraphTab] Refresh failed:', result.error);
    }
  } catch (err) {
    console.error('[GraphTab] Refresh error:', err);
  }
}

/**
 * Save graph to disk
 */
async function saveGraph() {
  try {
    const result = await window.ipcRenderer.invoke('graph-save');
    if (result.success) {
      console.log('[GraphTab] Graph saved');
    }
  } catch (err) {
    console.error('[GraphTab] Save error:', err);
  }
}

/**
 * Calculate node positions using force-directed layout
 */
function calculateNodePositions() {
  const canvas = graphState.canvas;
  if (!canvas || graphState.nodes.length === 0) return;

  const width = canvas.width;
  const height = canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;

  // Group nodes by type for initial positioning
  const groups = {};
  graphState.nodes.forEach((node, i) => {
    if (!groups[node.type]) groups[node.type] = [];
    groups[node.type].push({ node, index: i });
  });

  // Position nodes in circles by type
  const typeAngles = {
    agent: 0,
    file: Math.PI / 3,
    decision: 2 * Math.PI / 3,
    error: Math.PI,
    task: 4 * Math.PI / 3,
    concept: 5 * Math.PI / 3
  };

  const baseRadius = Math.min(width, height) / 4;

  graphState.nodes.forEach((node, i) => {
    // Get existing position or calculate new one
    let pos = graphState.nodePositions.get(node.id);
    if (!pos) {
      const typeAngle = typeAngles[node.type] || (i * 2 * Math.PI / graphState.nodes.length);
      const groupNodes = groups[node.type] || [{ node, index: 0 }];
      const indexInGroup = groupNodes.findIndex(g => g.node.id === node.id);
      const groupSpread = Math.PI / 4;
      const angle = typeAngle + (indexInGroup - groupNodes.length / 2) * (groupSpread / groupNodes.length);

      // Vary radius based on connectivity
      const connectivity = graphState.edges.filter(e => e.source === node.id || e.target === node.id).length;
      const radius = baseRadius * (0.5 + Math.min(connectivity / 10, 0.5));

      pos = {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      };
      graphState.nodePositions.set(node.id, pos);
    }
  });

  // Simple force-directed adjustment (a few iterations)
  for (let iter = 0; iter < 50; iter++) {
    graphState.nodes.forEach(node => {
      const pos = graphState.nodePositions.get(node.id);
      if (!pos) return;

      let fx = 0, fy = 0;

      // Repulsion from other nodes
      graphState.nodes.forEach(other => {
        if (other.id === node.id) return;
        const otherPos = graphState.nodePositions.get(other.id);
        if (!otherPos) return;

        const dx = pos.x - otherPos.x;
        const dy = pos.y - otherPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = 1000 / (dist * dist);
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      });

      // Attraction along edges
      graphState.edges.forEach(edge => {
        let otherId = null;
        if (edge.source === node.id) otherId = edge.target;
        else if (edge.target === node.id) otherId = edge.source;
        if (!otherId) return;

        const otherPos = graphState.nodePositions.get(otherId);
        if (!otherPos) return;

        const dx = otherPos.x - pos.x;
        const dy = otherPos.y - pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * 0.01;
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      });

      // Center gravity
      fx += (centerX - pos.x) * 0.001;
      fy += (centerY - pos.y) * 0.001;

      // Apply forces
      pos.x += fx * 0.5;
      pos.y += fy * 0.5;

      // Keep in bounds
      pos.x = Math.max(30, Math.min(width - 30, pos.x));
      pos.y = Math.max(30, Math.min(height - 30, pos.y));
    });
  }
}

/**
 * Render the graph on canvas
 */
function renderGraph() {
  const canvas = graphState.canvas;
  const ctx = graphState.ctx;
  if (!canvas || !ctx) return;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Apply transformations
  ctx.save();
  ctx.translate(graphState.offsetX, graphState.offsetY);
  ctx.scale(graphState.scale, graphState.scale);

  // Get dimmed types from legend
  const dimmedTypes = new Set();
  document.querySelectorAll('.graph-legend-item.dimmed').forEach(item => {
    dimmedTypes.add(item.dataset.type);
  });

  // Filter nodes
  const visibleNodes = graphState.nodes.filter(node => {
    if (dimmedTypes.has(node.type)) return false;
    if (graphState.filter !== 'all' && node.type !== graphState.filter) return false;
    return true;
  });
  const visibleNodeIds = new Set(visibleNodes.map(n => n.id));

  // Draw edges
  ctx.lineWidth = 1;
  graphState.edges.forEach(edge => {
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) return;

    const sourcePos = graphState.nodePositions.get(edge.source);
    const targetPos = graphState.nodePositions.get(edge.target);
    if (!sourcePos || !targetPos) return;

    ctx.beginPath();
    ctx.moveTo(sourcePos.x, sourcePos.y);
    ctx.lineTo(targetPos.x, targetPos.y);
    ctx.strokeStyle = 'rgba(108, 117, 125, 0.4)';
    ctx.stroke();
  });

  // Draw nodes
  visibleNodes.forEach(node => {
    const pos = graphState.nodePositions.get(node.id);
    if (!pos) return;

    const radius = getNodeRadius(node);
    const color = NODE_COLORS[node.type] || '#6272a4';
    const isSelected = graphState.selectedNode && graphState.selectedNode.id === node.id;

    // Node circle
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Selection ring
    if (isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Label
    ctx.fillStyle = '#f8f8f2';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const label = node.label.length > 15 ? node.label.slice(0, 12) + '...' : node.label;
    ctx.fillText(label, pos.x, pos.y + radius + 4);
  });

  ctx.restore();
}

/**
 * Select a node and show its details
 */
async function selectNode(node) {
  graphState.selectedNode = node;
  renderGraph();

  const titleEl = document.getElementById('graphDetailsTitle');
  const typeEl = document.getElementById('graphDetailsType');
  const contentEl = document.getElementById('graphDetailsContent');
  const relatedEl = document.getElementById('graphRelatedList');

  if (titleEl) titleEl.textContent = node.label;
  if (typeEl) {
    typeEl.textContent = node.type;
    typeEl.className = `graph-details-type ${node.type}`;
  }

  // Show node data
  if (contentEl) {
    let content = '';
    if (node.data) {
      if (node.data.path) content += `Path: ${node.data.path}\n`;
      if (node.data.description) content += `${node.data.description}\n`;
      if (node.data.message) content += `${node.data.message}\n`;
      if (node.data.context) content += `Context: ${JSON.stringify(node.data.context)}\n`;
      if (node.data.timestamp) content += `Time: ${new Date(node.data.timestamp).toLocaleString()}`;
    }
    contentEl.innerHTML = content ? `<pre style="margin:0;white-space:pre-wrap">${content}</pre>` : '<div class="graph-details-empty">No additional details</div>';
  }

  // Get related nodes
  if (relatedEl) {
    try {
      const result = await window.ipcRenderer.invoke('graph-related', { nodeId: node.id, depth: 1 });
      if (result.success && result.results.nodes.length > 1) {
        const related = result.results.nodes.filter(n => n.id !== node.id);
        relatedEl.innerHTML = related.slice(0, 8).map(rel => {
          const edge = result.results.edges.find(e =>
            (e.source === node.id && e.target === rel.id) ||
            (e.target === node.id && e.source === rel.id)
          );
          return `
            <div class="graph-related-item" data-node-id="${rel.id}">
              <span class="graph-related-type" style="background:${NODE_COLORS[rel.type] || '#6272a4'}"></span>
              <span class="graph-related-label">${rel.label}</span>
              <span class="graph-related-edge">${edge ? edge.type : ''}</span>
            </div>
          `;
        }).join('');

        // Add click handlers to related items
        relatedEl.querySelectorAll('.graph-related-item').forEach(item => {
          item.addEventListener('click', () => {
            const nodeId = item.dataset.nodeId;
            const relNode = graphState.nodes.find(n => n.id === nodeId);
            if (relNode) selectNode(relNode);
          });
        });
      } else {
        relatedEl.innerHTML = '<div class="graph-details-empty">No related nodes</div>';
      }
    } catch (err) {
      console.error('[GraphTab] Related nodes error:', err);
      relatedEl.innerHTML = '';
    }
  }
}

/**
 * Update graph statistics display
 */
function updateGraphStats() {
  const nodeCountEl = document.getElementById('graphNodeCount');
  const edgeCountEl = document.getElementById('graphEdgeCount');
  const fileCountEl = document.getElementById('graphFileCount');
  const decisionCountEl = document.getElementById('graphDecisionCount');

  if (nodeCountEl) nodeCountEl.textContent = graphState.nodes.length;
  if (edgeCountEl) edgeCountEl.textContent = graphState.edges.length;

  const fileCt = graphState.nodes.filter(n => n.type === 'file').length;
  const decisionCt = graphState.nodes.filter(n => n.type === 'decision').length;

  if (fileCountEl) fileCountEl.textContent = fileCt;
  if (decisionCountEl) decisionCountEl.textContent = decisionCt;
}

/**
 * Update last update time display
 */
function updateLastUpdateTime() {
  const el = document.getElementById('graphLastUpdate');
  if (el && graphState.lastUpdate) {
    el.textContent = `Updated: ${graphState.lastUpdate.toLocaleTimeString()}`;
  }
}

/**
 * Show empty state
 */
function showEmptyState() {
  const emptyEl = document.getElementById('graphEmpty');
  if (emptyEl) emptyEl.style.display = 'block';
}

/**
 * Hide empty state
 */
function hideEmptyState() {
  const emptyEl = document.getElementById('graphEmpty');
  if (emptyEl) emptyEl.style.display = 'none';
}

/**
 * Get current graph state
 */
function getGraphState() {
  return {
    nodes: graphState.nodes,
    edges: graphState.edges,
    selectedNode: graphState.selectedNode,
    filter: graphState.filter,
    lastUpdate: graphState.lastUpdate
  };
}

// ============================================================================
// WORKFLOW BUILDER TAB (Task #19)
// ============================================================================

function setupWorkflowTab() {
  const tab = document.getElementById('tab-workflow');
  if (!tab) return;

  workflowState.canvas = tab.querySelector('#workflowCanvas');
  workflowState.nodesEl = tab.querySelector('#workflowNodes');
  workflowState.edgesEl = tab.querySelector('#workflowEdges');
  workflowState.emptyEl = tab.querySelector('#workflowEmpty');
  workflowState.inspectorEl = tab.querySelector('#workflowInspectorBody');
  workflowState.statusEl = tab.querySelector('#workflowStatus');
  workflowState.statsEl = tab.querySelector('#workflowStats');
  workflowState.connectBtn = tab.querySelector('#workflowConnectBtn');

  // Setup node type buttons (existing and new)
  tab.querySelectorAll('[data-node-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.nodeType;
      addWorkflowNode(type);
    });
  });

  const autoLayoutBtn = tab.querySelector('#workflowAutoLayoutBtn');
  if (autoLayoutBtn) autoLayoutBtn.addEventListener('click', autoLayoutWorkflow);

  const clearBtn = tab.querySelector('#workflowClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearWorkflow);

  const saveBtn = tab.querySelector('#workflowSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', () => saveWorkflowToFile());

  const loadBtn = tab.querySelector('#workflowLoadBtn');
  if (loadBtn) loadBtn.addEventListener('click', () => showWorkflowLoadDialog());

  const exportBtn = tab.querySelector('#workflowExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportWorkflowToFile);

  // New buttons for Task #19 enhancements
  const validateBtn = tab.querySelector('#workflowValidateBtn');
  if (validateBtn) validateBtn.addEventListener('click', validateWorkflowUI);

  const executeBtn = tab.querySelector('#workflowExecuteBtn');
  if (executeBtn) executeBtn.addEventListener('click', generateWorkflowPlan);

  const importBtn = tab.querySelector('#workflowImportBtn');
  if (importBtn) importBtn.addEventListener('click', importWorkflowFromFile);

  const templateBtn = tab.querySelector('#workflowTemplateBtn');
  if (templateBtn) templateBtn.addEventListener('click', showWorkflowTemplates);

  const undoBtn = tab.querySelector('#workflowUndoBtn');
  if (undoBtn) undoBtn.addEventListener('click', undoWorkflow);

  const redoBtn = tab.querySelector('#workflowRedoBtn');
  if (redoBtn) redoBtn.addEventListener('click', redoWorkflow);

  const zoomInBtn = tab.querySelector('#workflowZoomInBtn');
  if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomWorkflow(1.2));

  const zoomOutBtn = tab.querySelector('#workflowZoomOutBtn');
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomWorkflow(0.8));

  const zoomResetBtn = tab.querySelector('#workflowZoomResetBtn');
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', resetWorkflowZoom);

  const deleteNodeBtn = tab.querySelector('#workflowDeleteNodeBtn');
  if (deleteNodeBtn) deleteNodeBtn.addEventListener('click', deleteSelectedWorkflowNode);

  const duplicateNodeBtn = tab.querySelector('#workflowDuplicateNodeBtn');
  if (duplicateNodeBtn) duplicateNodeBtn.addEventListener('click', duplicateSelectedWorkflowNode);

  if (workflowState.connectBtn) {
    workflowState.connectBtn.addEventListener('click', () => {
      setConnectMode(!workflowState.connectMode);
    });
  }

  // Canvas click for deselection
  if (workflowState.canvas) {
    workflowState.canvas.addEventListener('click', (e) => {
      if (e.target === workflowState.canvas || e.target === workflowState.nodesEl) {
        selectWorkflowNode(null);
      }
    });

    // Pan/zoom with mouse wheel
    workflowState.canvas.addEventListener('wheel', handleWorkflowWheel, { passive: false });

    // Pan with middle mouse button
    workflowState.canvas.addEventListener('mousedown', handleWorkflowPanStart);
    document.addEventListener('mousemove', handleWorkflowPanMove);
    document.addEventListener('mouseup', handleWorkflowPanEnd);
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', handleWorkflowKeyboard);

  window.addEventListener('resize', () => {
    updateWorkflowEdges();
  });

  // Load node types from IPC
  loadWorkflowNodeTypes();
  loadWorkflowTemplates();

  // Load saved workflow
  loadWorkflow(true);
  renderWorkflow();
}

/**
 * Load node type definitions from IPC
 */
async function loadWorkflowNodeTypes() {
  try {
    const result = await window.ipcRenderer.invoke('workflow-get-node-types');
    if (result.success) {
      workflowState.nodeTypes = result.nodeTypes;
    }
  } catch (err) {
    console.error('[Workflow] Failed to load node types:', err);
  }
}

/**
 * Load workflow templates from IPC
 */
async function loadWorkflowTemplates() {
  try {
    const result = await window.ipcRenderer.invoke('workflow-get-templates');
    if (result.success) {
      workflowState.templates = result.templates;
    }
  } catch (err) {
    console.error('[Workflow] Failed to load templates:', err);
  }
}

/**
 * Handle mouse wheel for zoom
 */
function handleWorkflowWheel(e) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  zoomWorkflow(delta, e.clientX, e.clientY);
}

/**
 * Handle pan start
 */
function handleWorkflowPanStart(e) {
  if (e.button !== 1) return; // Middle mouse button only
  e.preventDefault();
  workflowState.isPanning = true;
  workflowState.panStart = { x: e.clientX, y: e.clientY };
  if (workflowState.canvas) {
    workflowState.canvas.style.cursor = 'grabbing';
  }
}

/**
 * Handle pan move
 */
function handleWorkflowPanMove(e) {
  if (!workflowState.isPanning) return;
  const dx = e.clientX - workflowState.panStart.x;
  const dy = e.clientY - workflowState.panStart.y;
  workflowState.panX += dx;
  workflowState.panY += dy;
  workflowState.panStart = { x: e.clientX, y: e.clientY };
  applyWorkflowTransform();
}

/**
 * Handle pan end
 */
function handleWorkflowPanEnd() {
  if (workflowState.isPanning) {
    workflowState.isPanning = false;
    if (workflowState.canvas) {
      workflowState.canvas.style.cursor = '';
    }
  }
}

/**
 * Zoom workflow canvas
 */
function zoomWorkflow(factor, centerX, centerY) {
  const oldZoom = workflowState.zoom;
  workflowState.zoom = Math.max(0.25, Math.min(4, workflowState.zoom * factor));

  // Adjust pan to zoom toward center point
  if (centerX !== undefined && centerY !== undefined && workflowState.canvas) {
    const rect = workflowState.canvas.getBoundingClientRect();
    const x = centerX - rect.left;
    const y = centerY - rect.top;
    workflowState.panX -= (x - workflowState.panX) * (workflowState.zoom / oldZoom - 1);
    workflowState.panY -= (y - workflowState.panY) * (workflowState.zoom / oldZoom - 1);
  }

  applyWorkflowTransform();
  setWorkflowStatus(`Zoom: ${Math.round(workflowState.zoom * 100)}%`);
}

/**
 * Reset zoom and pan
 */
function resetWorkflowZoom() {
  workflowState.zoom = 1;
  workflowState.panX = 0;
  workflowState.panY = 0;
  applyWorkflowTransform();
  setWorkflowStatus('View reset');
}

/**
 * Apply transform to workflow canvas
 */
function applyWorkflowTransform() {
  if (workflowState.nodesEl) {
    workflowState.nodesEl.style.transform = `translate(${workflowState.panX}px, ${workflowState.panY}px) scale(${workflowState.zoom})`;
    workflowState.nodesEl.style.transformOrigin = '0 0';
  }
  updateWorkflowEdges();
}

/**
 * Handle keyboard shortcuts
 */
function handleWorkflowKeyboard(e) {
  // Only handle when workflow tab is active
  const workflowTab = document.getElementById('tab-workflow');
  if (!workflowTab || !workflowTab.classList.contains('active')) return;

  // Delete selected node
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (workflowState.selectedNodeId && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      deleteSelectedWorkflowNode();
    }
  }

  // Ctrl+Z: Undo
  if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undoWorkflow();
  }

  // Ctrl+Shift+Z or Ctrl+Y: Redo
  if ((e.ctrlKey && e.shiftKey && e.key === 'z') || (e.ctrlKey && e.key === 'y')) {
    e.preventDefault();
    redoWorkflow();
  }

  // Ctrl+C: Copy
  if (e.ctrlKey && e.key === 'c' && workflowState.selectedNodeId) {
    e.preventDefault();
    copySelectedWorkflowNode();
  }

  // Ctrl+V: Paste
  if (e.ctrlKey && e.key === 'v' && workflowState.clipboard) {
    e.preventDefault();
    pasteWorkflowNode();
  }

  // Ctrl+D: Duplicate
  if (e.ctrlKey && e.key === 'd' && workflowState.selectedNodeId) {
    e.preventDefault();
    duplicateSelectedWorkflowNode();
  }

  // Escape: Deselect or exit connect mode
  if (e.key === 'Escape') {
    if (workflowState.connectMode) {
      setConnectMode(false);
    } else {
      selectWorkflowNode(null);
    }
  }
}

/**
 * Save current state for undo
 */
function pushWorkflowUndoState() {
  const state = {
    nodes: JSON.parse(JSON.stringify(workflowState.nodes)),
    edges: JSON.parse(JSON.stringify(workflowState.edges))
  };
  workflowState.undoStack.push(state);
  if (workflowState.undoStack.length > 50) {
    workflowState.undoStack.shift();
  }
  workflowState.redoStack = [];
}

/**
 * Undo last action
 */
function undoWorkflow() {
  if (workflowState.undoStack.length === 0) {
    setWorkflowStatus('Nothing to undo');
    return;
  }

  const state = {
    nodes: JSON.parse(JSON.stringify(workflowState.nodes)),
    edges: JSON.parse(JSON.stringify(workflowState.edges))
  };
  workflowState.redoStack.push(state);

  const prev = workflowState.undoStack.pop();
  workflowState.nodes = prev.nodes;
  workflowState.edges = prev.edges;
  workflowState.selectedNodeId = null;
  renderWorkflow();
  setWorkflowStatus('Undo');
}

/**
 * Redo last undone action
 */
function redoWorkflow() {
  if (workflowState.redoStack.length === 0) {
    setWorkflowStatus('Nothing to redo');
    return;
  }

  const state = {
    nodes: JSON.parse(JSON.stringify(workflowState.nodes)),
    edges: JSON.parse(JSON.stringify(workflowState.edges))
  };
  workflowState.undoStack.push(state);

  const next = workflowState.redoStack.pop();
  workflowState.nodes = next.nodes;
  workflowState.edges = next.edges;
  workflowState.selectedNodeId = null;
  renderWorkflow();
  setWorkflowStatus('Redo');
}

/**
 * Copy selected node
 */
function copySelectedWorkflowNode() {
  const node = getWorkflowNode(workflowState.selectedNodeId);
  if (!node) return;
  workflowState.clipboard = JSON.parse(JSON.stringify(node));
  setWorkflowStatus('Copied node');
}

/**
 * Paste copied node
 */
function pasteWorkflowNode() {
  if (!workflowState.clipboard) return;
  pushWorkflowUndoState();

  const node = {
    ...workflowState.clipboard,
    id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    x: workflowState.clipboard.x + 30,
    y: workflowState.clipboard.y + 30,
    label: workflowState.clipboard.label + ' (copy)'
  };

  workflowState.nodes.push(node);
  workflowState.clipboard = node;
  selectWorkflowNode(node.id);
  renderWorkflow();
  setWorkflowStatus('Pasted node');
}

/**
 * Delete selected node
 */
function deleteSelectedWorkflowNode() {
  const nodeId = workflowState.selectedNodeId;
  if (!nodeId) {
    setWorkflowStatus('No node selected');
    return;
  }

  pushWorkflowUndoState();

  // Remove node
  workflowState.nodes = workflowState.nodes.filter(n => n.id !== nodeId);

  // Remove edges connected to this node
  workflowState.edges = workflowState.edges.filter(e => e.from !== nodeId && e.to !== nodeId);

  workflowState.selectedNodeId = null;
  renderWorkflow();
  setWorkflowStatus('Deleted node');
}

/**
 * Duplicate selected node
 */
function duplicateSelectedWorkflowNode() {
  const node = getWorkflowNode(workflowState.selectedNodeId);
  if (!node) {
    setWorkflowStatus('No node selected');
    return;
  }

  pushWorkflowUndoState();

  const newNode = {
    ...JSON.parse(JSON.stringify(node)),
    id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    x: node.x + 30,
    y: node.y + 30,
    label: node.label + ' (copy)'
  };

  workflowState.nodes.push(newNode);
  selectWorkflowNode(newNode.id);
  renderWorkflow();
  setWorkflowStatus('Duplicated node');
}

/**
 * Validate workflow via IPC
 */
async function validateWorkflowUI() {
  try {
    const workflow = {
      nodes: workflowState.nodes,
      edges: workflowState.edges
    };

    const result = await window.ipcRenderer.invoke('workflow-validate', { workflow, options: { strict: true } });
    workflowState.validationResult = result;

    if (result.valid) {
      setWorkflowStatus(`Valid: ${result.stats.nodes} nodes, ${result.stats.edges} edges`);
    } else {
      const errorMsgs = result.errors.map(e => e.message).join('; ');
      setWorkflowStatus(`Invalid: ${errorMsgs}`);
    }

    // Update visual feedback
    renderWorkflow();
  } catch (err) {
    console.error('[Workflow] Validation error:', err);
    setWorkflowStatus('Validation failed');
  }
}

/**
 * Generate execution plan
 */
async function generateWorkflowPlan() {
  try {
    const workflow = {
      nodes: workflowState.nodes,
      edges: workflowState.edges
    };

    const result = await window.ipcRenderer.invoke('workflow-generate-plan', { workflow });

    if (result.success) {
      workflowState.executionPlan = result.plan;
      setWorkflowStatus(`Plan generated: ${result.plan.length} steps`);
      showExecutionPlan(result.plan);
    } else {
      setWorkflowStatus(`Plan failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Plan generation error:', err);
    setWorkflowStatus('Plan generation failed');
  }
}

/**
 * Show execution plan in inspector
 */
function showExecutionPlan(plan) {
  const inspector = workflowState.inspectorEl;
  if (!inspector) return;

  inspector.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'workflow-inspector-title';
  title.textContent = 'Execution Plan';
  inspector.appendChild(title);

  plan.forEach((step, i) => {
    const stepEl = document.createElement('div');
    stepEl.className = 'workflow-plan-step';
    stepEl.innerHTML = `
      <span class="step-num">${i + 1}</span>
      <span class="step-type">${step.type}</span>
      <span class="step-label">${step.label}</span>
    `;
    stepEl.addEventListener('click', () => {
      selectWorkflowNode(step.nodeId);
    });
    inspector.appendChild(stepEl);
  });
}

/**
 * Save workflow to file via IPC
 */
async function saveWorkflowToFile() {
  const name = workflowState.workflowName || prompt('Enter workflow name:', 'Untitled');
  if (!name) return;

  try {
    const workflow = {
      name,
      description: workflowState.workflowDescription,
      nodes: workflowState.nodes,
      edges: workflowState.edges
    };

    const result = await window.ipcRenderer.invoke('workflow-save', { name, workflow, overwrite: true });

    if (result.success) {
      workflowState.workflowName = name;
      workflowState.lastSaved = new Date();
      setWorkflowStatus(`Saved: ${name}`);
    } else {
      setWorkflowStatus(`Save failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Save error:', err);
    setWorkflowStatus('Save failed');
  }

  // Also save to localStorage for quick recovery
  saveWorkflow(true);
}

/**
 * Show workflow load dialog
 */
async function showWorkflowLoadDialog() {
  try {
    const result = await window.ipcRenderer.invoke('workflow-list');
    if (!result.success || !result.workflows.length) {
      setWorkflowStatus('No saved workflows');
      return;
    }

    const names = result.workflows.map(w => w.name);
    const name = prompt(`Load workflow:\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nEnter name:`, names[0]);
    if (!name) return;

    const loadResult = await window.ipcRenderer.invoke('workflow-load', { name });
    if (loadResult.success) {
      pushWorkflowUndoState();
      workflowState.nodes = loadResult.workflow.nodes || [];
      workflowState.edges = loadResult.workflow.edges || [];
      workflowState.workflowName = loadResult.workflow.name;
      workflowState.workflowDescription = loadResult.workflow.description || '';
      workflowState.selectedNodeId = null;
      renderWorkflow();
      setWorkflowStatus(`Loaded: ${name}`);
    } else {
      setWorkflowStatus(`Load failed: ${loadResult.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Load error:', err);
    setWorkflowStatus('Load failed');
  }
}

/**
 * Export workflow to file
 */
async function exportWorkflowToFile() {
  try {
    const workflow = {
      name: workflowState.workflowName,
      description: workflowState.workflowDescription,
      nodes: workflowState.nodes,
      edges: workflowState.edges
    };

    const result = await window.ipcRenderer.invoke('workflow-export-file', {
      workflow,
      defaultName: workflowState.workflowName
    });

    if (result.success) {
      setWorkflowStatus('Workflow exported');
    } else if (!result.canceled) {
      setWorkflowStatus(`Export failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Export error:', err);
    // Fallback to browser download
    exportWorkflow();
  }
}

/**
 * Import workflow from file
 */
async function importWorkflowFromFile() {
  try {
    const result = await window.ipcRenderer.invoke('workflow-import-file');

    if (result.success) {
      pushWorkflowUndoState();
      workflowState.nodes = result.workflow.nodes || [];
      workflowState.edges = result.workflow.edges || [];
      workflowState.workflowName = result.workflow.name || 'Imported';
      workflowState.workflowDescription = result.workflow.description || '';
      workflowState.selectedNodeId = null;
      renderWorkflow();
      setWorkflowStatus(`Imported: ${workflowState.workflowName}`);
    } else if (!result.canceled) {
      setWorkflowStatus(`Import failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Import error:', err);
    setWorkflowStatus('Import failed');
  }
}

/**
 * Show workflow templates dialog
 */
async function showWorkflowTemplates() {
  const templates = workflowState.templates;
  if (!templates || templates.length === 0) {
    setWorkflowStatus('No templates available');
    return;
  }

  const templateNames = templates.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
  const choice = prompt(`Select template:\n${templateNames}\n\nEnter number:`, '1');
  if (!choice) return;

  const index = parseInt(choice, 10) - 1;
  if (index < 0 || index >= templates.length) {
    setWorkflowStatus('Invalid template selection');
    return;
  }

  const template = templates[index];

  try {
    const result = await window.ipcRenderer.invoke('workflow-apply-template', { templateId: template.id });
    if (result.success) {
      pushWorkflowUndoState();
      workflowState.nodes = result.workflow.nodes;
      workflowState.edges = result.workflow.edges;
      workflowState.workflowName = result.workflow.name;
      workflowState.workflowDescription = result.workflow.description;
      workflowState.selectedNodeId = null;
      renderWorkflow();
      setWorkflowStatus(`Applied template: ${template.name}`);
    } else {
      setWorkflowStatus(`Template failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Template error:', err);
    setWorkflowStatus('Template failed');
  }
}

function addWorkflowNode(type) {
  const normalizedType = WORKFLOW_NODE_TYPES[type] ? type : 'agent';
  const labelBase = WORKFLOW_NODE_TYPES[normalizedType];
  const nextIndex = workflowState.nodes.filter(n => n.type === normalizedType).length + 1;

  const canvasRect = workflowState.canvas?.getBoundingClientRect();
  const maxX = canvasRect ? Math.max(canvasRect.width - 180, 20) : 200;
  const maxY = canvasRect ? Math.max(canvasRect.height - 80, 20) : 120;
  const x = canvasRect ? Math.min(30 + Math.random() * maxX, maxX) : 40;
  const y = canvasRect ? Math.min(30 + Math.random() * maxY, maxY) : 40;

  const node = {
    id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    type: normalizedType,
    label: `${labelBase} ${nextIndex}`,
    x,
    y,
    notes: ''
  };

  workflowState.nodes.push(node);
  selectWorkflowNode(node.id);
  renderWorkflow();
  setWorkflowStatus(`Added ${labelBase}`);
}

function clearWorkflow() {
  if (workflowState.nodes.length === 0 && workflowState.edges.length === 0) {
    setWorkflowStatus('Nothing to clear');
    return;
  }

  if (!window.confirm('Clear the current workflow?')) return;

  workflowState.nodes = [];
  workflowState.edges = [];
  workflowState.selectedNodeId = null;
  workflowState.connectingFrom = null;
  workflowState.connectMode = false;
  renderWorkflow();
  setWorkflowStatus('Workflow cleared');
}

function renderWorkflow() {
  renderWorkflowNodes();
  requestAnimationFrame(() => updateWorkflowEdges());
  updateWorkflowStats();

  if (workflowState.emptyEl) {
    workflowState.emptyEl.style.display = workflowState.nodes.length === 0 ? 'flex' : 'none';
  }
}

function renderWorkflowNodes() {
  if (!workflowState.nodesEl) return;

  workflowState.nodesEl.innerHTML = '';

  workflowState.nodes.forEach(node => {
    const nodeEl = document.createElement('div');
    nodeEl.className = `workflow-node type-${node.type}`;
    nodeEl.dataset.nodeId = node.id;
    if (workflowState.selectedNodeId === node.id) {
      nodeEl.classList.add('selected');
    }
    if (workflowState.connectingFrom === node.id) {
      nodeEl.classList.add('connect-source');
    }

    const typeEl = document.createElement('div');
    typeEl.className = 'workflow-node-type';
    typeEl.textContent = WORKFLOW_NODE_TYPES[node.type] || node.type;

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'workflow-node-input';
    inputEl.value = node.label;
    inputEl.addEventListener('input', () => {
      node.label = inputEl.value;
      renderWorkflowInspector();
    });

    nodeEl.appendChild(typeEl);
    nodeEl.appendChild(inputEl);
    positionWorkflowNode(nodeEl, node);

    nodeEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target === inputEl) return;
      beginWorkflowDrag(node.id, e);
    });

    workflowState.nodesEl.appendChild(nodeEl);
  });

  renderWorkflowInspector();
}

function positionWorkflowNode(nodeEl, node) {
  nodeEl.style.left = `${node.x}px`;
  nodeEl.style.top = `${node.y}px`;
}

function beginWorkflowDrag(nodeId, event) {
  const node = getWorkflowNode(nodeId);
  if (!node) return;

  workflowState.drag = {
    id: nodeId,
    startX: event.clientX,
    startY: event.clientY,
    originX: node.x,
    originY: node.y,
    moved: false
  };

  document.addEventListener('mousemove', handleWorkflowDragMove);
  document.addEventListener('mouseup', handleWorkflowDragEnd);
}

function handleWorkflowDragMove(event) {
  if (!workflowState.drag) return;

  const drag = workflowState.drag;
  const node = getWorkflowNode(drag.id);
  const nodeEl = getWorkflowNodeElement(drag.id);
  const canvasRect = workflowState.canvas?.getBoundingClientRect();
  if (!node || !nodeEl || !canvasRect) return;

  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;

  if (Math.abs(dx) + Math.abs(dy) > 2) {
    drag.moved = true;
  }

  const nextX = drag.originX + dx;
  const nextY = drag.originY + dy;

  const maxX = canvasRect.width - nodeEl.offsetWidth - 10;
  const maxY = canvasRect.height - nodeEl.offsetHeight - 10;

  node.x = Math.max(10, Math.min(nextX, maxX));
  node.y = Math.max(10, Math.min(nextY, maxY));

  positionWorkflowNode(nodeEl, node);
  updateWorkflowEdges();
}

function handleWorkflowDragEnd() {
  if (!workflowState.drag) return;

  const { id, moved } = workflowState.drag;
  workflowState.drag = null;
  document.removeEventListener('mousemove', handleWorkflowDragMove);
  document.removeEventListener('mouseup', handleWorkflowDragEnd);

  if (!moved) {
    handleWorkflowNodeActivate(id);
  }
}

function handleWorkflowNodeActivate(nodeId) {
  if (workflowState.connectMode) {
    if (!workflowState.connectingFrom) {
      workflowState.connectingFrom = nodeId;
      setWorkflowStatus('Select a target node to connect');
    } else if (workflowState.connectingFrom !== nodeId) {
      addWorkflowEdge(workflowState.connectingFrom, nodeId);
      workflowState.connectingFrom = null;
      setWorkflowStatus('Connection added');
    } else {
      workflowState.connectingFrom = null;
    }
    updateWorkflowConnectUI();
    renderWorkflow();
    return;
  }

  selectWorkflowNode(nodeId);
}

function selectWorkflowNode(nodeId) {
  workflowState.selectedNodeId = nodeId;
  renderWorkflow();
}

function renderWorkflowInspector() {
  const inspector = workflowState.inspectorEl;
  if (!inspector) return;

  inspector.innerHTML = '';
  const node = getWorkflowNode(workflowState.selectedNodeId);

  if (!node) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'workflow-inspector-empty';
    emptyEl.textContent = 'Select a node to edit details';
    inspector.appendChild(emptyEl);

    // Show workflow info when nothing selected
    const workflowInfo = document.createElement('div');
    workflowInfo.className = 'workflow-inspector-info';
    workflowInfo.innerHTML = `
      <div class="inspector-section">
        <div class="inspector-section-title">Workflow</div>
        <div class="inspector-stat">Nodes: ${workflowState.nodes.length}</div>
        <div class="inspector-stat">Edges: ${workflowState.edges.length}</div>
        <div class="inspector-stat">Zoom: ${Math.round(workflowState.zoom * 100)}%</div>
      </div>
    `;
    inspector.appendChild(workflowInfo);
    return;
  }

  // Node title
  const titleSection = document.createElement('div');
  titleSection.className = 'workflow-inspector-title';
  titleSection.textContent = WORKFLOW_NODE_TYPES[node.type] || node.type;
  inspector.appendChild(titleSection);

  // Basic properties
  inspector.appendChild(buildInspectorRow('Name', node.label, (value) => {
    node.label = value;
    const nodeEl = getWorkflowNodeElement(node.id);
    const inputEl = nodeEl?.querySelector('.workflow-node-input');
    if (inputEl) inputEl.value = value;
  }));

  inspector.appendChild(buildInspectorRow('Type', WORKFLOW_NODE_TYPES[node.type] || node.type, null, true));

  // Node-specific config fields from IPC
  if (workflowState.nodeTypes && workflowState.nodeTypes[node.type]) {
    const typeConfig = workflowState.nodeTypes[node.type];
    if (typeConfig.config && typeConfig.config.length > 0) {
      const configSection = document.createElement('div');
      configSection.className = 'inspector-section';

      const configTitle = document.createElement('div');
      configTitle.className = 'inspector-section-title';
      configTitle.textContent = 'Configuration';
      configSection.appendChild(configTitle);

      // Initialize node config if missing
      if (!node.config) node.config = {};

      typeConfig.config.forEach(field => {
        // Check showIf condition
        if (field.showIf) {
          const conditionMet = Object.entries(field.showIf).every(([key, value]) => node.config[key] === value);
          if (!conditionMet) return;
        }

        const row = document.createElement('div');
        row.className = 'workflow-inspector-row';

        const label = document.createElement('div');
        label.className = 'workflow-inspector-label';
        label.textContent = field.label;
        row.appendChild(label);

        let input;
        switch (field.type) {
          case 'select':
            input = document.createElement('select');
            input.className = 'workflow-inspector-input';
            (field.options || []).forEach(opt => {
              const option = document.createElement('option');
              option.value = opt;
              option.textContent = opt;
              if (node.config[field.key] === opt) option.selected = true;
              input.appendChild(option);
            });
            input.addEventListener('change', () => {
              node.config[field.key] = input.value;
              renderWorkflowInspector(); // Re-render for showIf updates
            });
            break;

          case 'textarea':
            input = document.createElement('textarea');
            input.className = 'workflow-inspector-input';
            input.rows = 3;
            input.value = node.config[field.key] || '';
            input.addEventListener('input', () => {
              node.config[field.key] = input.value;
            });
            break;

          case 'number':
            input = document.createElement('input');
            input.type = 'number';
            input.className = 'workflow-inspector-input';
            input.value = node.config[field.key] || '';
            input.addEventListener('input', () => {
              node.config[field.key] = input.value ? parseInt(input.value, 10) : null;
            });
            break;

          case 'checkbox':
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!node.config[field.key];
            input.addEventListener('change', () => {
              node.config[field.key] = input.checked;
              renderWorkflowInspector(); // Re-render for showIf updates
            });
            break;

          default: // text
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'workflow-inspector-input';
            input.value = node.config[field.key] || '';
            input.addEventListener('input', () => {
              node.config[field.key] = input.value;
            });
        }

        row.appendChild(input);
        configSection.appendChild(row);
      });

      inspector.appendChild(configSection);
    }
  }

  // Notes
  inspector.appendChild(buildInspectorRow('Notes', node.notes || '', (value) => {
    node.notes = value;
  }, false, true));

  // Connection info
  const connections = document.createElement('div');
  connections.className = 'inspector-section';

  const connTitle = document.createElement('div');
  connTitle.className = 'inspector-section-title';
  connTitle.textContent = 'Connections';
  connections.appendChild(connTitle);

  const inEdges = workflowState.edges.filter(e => e.to === node.id);
  const outEdges = workflowState.edges.filter(e => e.from === node.id);

  const inInfo = document.createElement('div');
  inInfo.className = 'inspector-stat';
  inInfo.textContent = `Inputs: ${inEdges.length}`;
  connections.appendChild(inInfo);

  const outInfo = document.createElement('div');
  outInfo.className = 'inspector-stat';
  outInfo.textContent = `Outputs: ${outEdges.length}`;
  connections.appendChild(outInfo);

  inspector.appendChild(connections);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'inspector-actions';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-sm';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', deleteSelectedWorkflowNode);
  actions.appendChild(deleteBtn);

  const duplicateBtn = document.createElement('button');
  duplicateBtn.className = 'btn btn-sm';
  duplicateBtn.textContent = 'Duplicate';
  duplicateBtn.addEventListener('click', duplicateSelectedWorkflowNode);
  actions.appendChild(duplicateBtn);

  inspector.appendChild(actions);
}

function buildInspectorRow(label, value, onChange, readOnly = false, multiline = false) {
  const row = document.createElement('div');
  row.className = 'workflow-inspector-row';

  const labelEl = document.createElement('div');
  labelEl.className = 'workflow-inspector-label';
  labelEl.textContent = label;

  let inputEl;
  if (multiline) {
    inputEl = document.createElement('textarea');
    inputEl.rows = 3;
  } else {
    inputEl = document.createElement('input');
    inputEl.type = 'text';
  }

  inputEl.className = 'workflow-inspector-input';
  inputEl.value = value;
  if (readOnly) {
    inputEl.readOnly = true;
  } else if (onChange) {
    inputEl.addEventListener('input', () => onChange(inputEl.value));
  }

  row.appendChild(labelEl);
  row.appendChild(inputEl);
  return row;
}

function addWorkflowEdge(fromId, toId) {
  const exists = workflowState.edges.some(edge => edge.from === fromId && edge.to === toId);
  if (exists) return;

  workflowState.edges.push({
    id: `edge-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    from: fromId,
    to: toId
  });

  updateWorkflowEdges();
  updateWorkflowStats();
}

function updateWorkflowEdges() {
  const edgesEl = workflowState.edgesEl;
  const canvas = workflowState.canvas;
  if (!edgesEl || !canvas) return;

  const rect = canvas.getBoundingClientRect();
  edgesEl.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  edgesEl.setAttribute('width', `${rect.width}`);
  edgesEl.setAttribute('height', `${rect.height}`);
  edgesEl.innerHTML = '';

  // Add arrow marker definition
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'workflow-arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrowPath.setAttribute('fill', 'rgba(139, 233, 253, 0.9)');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);

  // Add active arrow marker
  const markerActive = marker.cloneNode(true);
  markerActive.setAttribute('id', 'workflow-arrow-active');
  markerActive.querySelector('path').setAttribute('fill', 'var(--color-primary)');
  defs.appendChild(markerActive);

  edgesEl.appendChild(defs);

  workflowState.edges.forEach(edge => {
    const fromEl = getWorkflowNodeElement(edge.from);
    const toEl = getWorkflowNodeElement(edge.to);
    if (!fromEl || !toEl) return;

    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();

    // Calculate edge points from node edges (not centers)
    const fromCenterX = fromRect.left - rect.left + fromRect.width / 2;
    const fromCenterY = fromRect.top - rect.top + fromRect.height / 2;
    const toCenterX = toRect.left - rect.left + toRect.width / 2;
    const toCenterY = toRect.top - rect.top + toRect.height / 2;

    // Determine connection points on node edges
    const dx = toCenterX - fromCenterX;
    const dy = toCenterY - fromCenterY;
    const angle = Math.atan2(dy, dx);

    // Start point on from node edge
    let x1, y1;
    if (Math.abs(dx) > Math.abs(dy)) {
      x1 = fromCenterX + (dx > 0 ? fromRect.width / 2 : -fromRect.width / 2);
      y1 = fromCenterY;
    } else {
      x1 = fromCenterX;
      y1 = fromCenterY + (dy > 0 ? fromRect.height / 2 : -fromRect.height / 2);
    }

    // End point on to node edge
    let x2, y2;
    if (Math.abs(dx) > Math.abs(dy)) {
      x2 = toCenterX + (dx > 0 ? -toRect.width / 2 - 8 : toRect.width / 2 + 8);
      y2 = toCenterY;
    } else {
      x2 = toCenterX;
      y2 = toCenterY + (dy > 0 ? -toRect.height / 2 - 8 : toRect.height / 2 + 8);
    }

    // Calculate control points for bezier curve
    const dist = Math.sqrt(dx * dx + dy * dy);
    const curvature = Math.min(dist / 3, 80);

    let cx1, cy1, cx2, cy2;
    if (Math.abs(dx) > Math.abs(dy)) {
      cx1 = x1 + (dx > 0 ? curvature : -curvature);
      cy1 = y1;
      cx2 = x2 + (dx > 0 ? -curvature : curvature);
      cy2 = y2;
    } else {
      cx1 = x1;
      cy1 = y1 + (dy > 0 ? curvature : -curvature);
      cx2 = x2;
      cy2 = y2 + (dy > 0 ? -curvature : curvature);
    }

    // Create bezier path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'rgba(139, 233, 253, 0.7)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('marker-end', 'url(#workflow-arrow)');
    path.dataset.edgeId = edge.id;

    // Highlight if connected to selected node
    if (edge.from === workflowState.selectedNodeId || edge.to === workflowState.selectedNodeId) {
      path.setAttribute('stroke', 'var(--color-primary)');
      path.setAttribute('stroke-width', '3');
      path.setAttribute('marker-end', 'url(#workflow-arrow-active)');
    }

    // Add edge label if exists
    if (edge.label) {
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', midX);
      text.setAttribute('y', midY - 5);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'var(--color-text-muted)');
      text.setAttribute('font-size', '10');
      text.textContent = edge.label;
      edgesEl.appendChild(text);
    }

    // Click handler to select edge
    path.style.cursor = 'pointer';
    path.addEventListener('click', (e) => {
      e.stopPropagation();
      selectWorkflowEdge(edge.id);
    });

    edgesEl.appendChild(path);
  });
}

/**
 * Select an edge
 */
function selectWorkflowEdge(edgeId) {
  workflowState.selectedNodeId = null;
  const edge = workflowState.edges.find(e => e.id === edgeId);
  if (!edge) return;

  // Show edge in inspector
  const inspector = workflowState.inspectorEl;
  if (inspector) {
    inspector.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'workflow-inspector-title';
    title.textContent = 'Edge Properties';
    inspector.appendChild(title);

    const fromNode = getWorkflowNode(edge.from);
    const toNode = getWorkflowNode(edge.to);

    inspector.appendChild(buildInspectorRow('From', fromNode?.label || edge.from, null, true));
    inspector.appendChild(buildInspectorRow('To', toNode?.label || edge.to, null, true));
    inspector.appendChild(buildInspectorRow('Label', edge.label || '', (value) => {
      edge.label = value;
      updateWorkflowEdges();
    }));

    // Delete edge button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-sm btn-danger';
    deleteBtn.textContent = 'Delete Edge';
    deleteBtn.style.marginTop = '10px';
    deleteBtn.addEventListener('click', () => {
      pushWorkflowUndoState();
      workflowState.edges = workflowState.edges.filter(e => e.id !== edgeId);
      renderWorkflow();
      setWorkflowStatus('Edge deleted');
    });
    inspector.appendChild(deleteBtn);
  }

  updateWorkflowEdges();
}

function updateWorkflowStats() {
  if (workflowState.statsEl) {
    workflowState.statsEl.textContent = `${workflowState.nodes.length} nodes / ${workflowState.edges.length} links`;
  }
}

function setWorkflowStatus(message) {
  if (workflowState.statusEl) {
    workflowState.statusEl.textContent = message;
  }
}

function setConnectMode(enabled) {
  workflowState.connectMode = enabled;
  if (!enabled) {
    workflowState.connectingFrom = null;
  }
  updateWorkflowConnectUI();
}

function updateWorkflowConnectUI() {
  if (workflowState.canvas) {
    workflowState.canvas.classList.toggle('connect-mode', workflowState.connectMode);
  }
  if (workflowState.connectBtn) {
    workflowState.connectBtn.classList.toggle('active', workflowState.connectMode);
  }
  renderWorkflow();
}

function autoLayoutWorkflow() {
  const canvas = workflowState.canvas;
  if (!canvas || workflowState.nodes.length === 0) return;

  const rect = canvas.getBoundingClientRect();
  const columns = Math.max(1, Math.floor(rect.width / 200));
  const spacingX = rect.width / columns;
  const spacingY = 90;

  workflowState.nodes.forEach((node, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    node.x = Math.max(10, col * spacingX + 20);
    node.y = Math.max(10, row * spacingY + 20);
  });

  renderWorkflow();
  setWorkflowStatus('Layout updated');
}

function saveWorkflow(silent) {
  const payload = {
    version: 1,
    nodes: workflowState.nodes,
    edges: workflowState.edges
  };

  try {
    localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(payload));
    workflowState.lastSaved = new Date();
    if (!silent) setWorkflowStatus('Workflow saved');
  } catch (err) {
    console.error('[Workflow] Save failed:', err);
    if (!silent) setWorkflowStatus('Save failed');
  }
}

function loadWorkflow(silent) {
  try {
    const raw = localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) {
      if (!silent) setWorkflowStatus('No saved workflow');
      return;
    }

    const data = JSON.parse(raw);
    workflowState.nodes = Array.isArray(data.nodes) ? data.nodes : [];
    workflowState.edges = Array.isArray(data.edges) ? data.edges : [];
    workflowState.selectedNodeId = null;
    workflowState.connectMode = false;
    workflowState.connectingFrom = null;
    renderWorkflow();
    if (!silent) setWorkflowStatus('Workflow loaded');
  } catch (err) {
    console.error('[Workflow] Load failed:', err);
    if (!silent) setWorkflowStatus('Load failed');
  }
}

function exportWorkflow() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    nodes: workflowState.nodes,
    edges: workflowState.edges
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'workflow.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setWorkflowStatus('Workflow exported');
}

function getWorkflowNode(nodeId) {
  if (!nodeId) return null;
  return workflowState.nodes.find(node => node.id === nodeId) || null;
}

function getWorkflowNodeElement(nodeId) {
  if (!workflowState.nodesEl) return null;
  return workflowState.nodesEl.querySelector(`[data-node-id="${nodeId}"]`);
}

module.exports = {
  setupWorkflowTab,
  loadWorkflowNodeTypes,
  loadWorkflowTemplates,
  validateWorkflowUI,
  generateWorkflowPlan,
  saveWorkflowToFile,
  showWorkflowLoadDialog,
  exportWorkflowToFile,
  importWorkflowFromFile,
  showWorkflowTemplates,
  undoWorkflow,
  redoWorkflow,
  deleteSelectedWorkflowNode,
  duplicateSelectedWorkflowNode,
  zoomWorkflow,
  resetWorkflowZoom,
};
