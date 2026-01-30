/**
 * Knowledge Graph - Cross-Session Relationship Tracking
 * Task #36: Connect files, agents, decisions, errors into queryable graph
 *
 * Node types: file, agent, decision, error, concept, task, session
 * Edge types: touches, involves, causes, resolves, relates_to, mentions, modifies
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

// Graph storage paths
let GRAPH_DIR = null;
let NODES_FILE = null;
let EDGES_FILE = null;
let INDEX_FILE = null;

// In-memory graph
const nodes = new Map();  // nodeId -> { type, label, data, created, updated }
const edges = new Map();  // edgeId -> { source, target, type, weight, data, created }
const nodeIndex = new Map();  // type -> Set of nodeIds
const labelIndex = new Map();  // normalized label -> nodeId
const adjacency = new Map();  // nodeId -> Map(targetId -> [edgeIds])

// Node type definitions
const NODE_TYPES = {
  FILE: 'file',
  AGENT: 'agent',
  DECISION: 'decision',
  ERROR: 'error',
  CONCEPT: 'concept',
  TASK: 'task',
  SESSION: 'session',
  MESSAGE: 'message'
};

// Edge type definitions
const EDGE_TYPES = {
  TOUCHES: 'touches',           // agent touches file
  MODIFIES: 'modifies',         // agent modifies file
  INVOLVES: 'involves',         // decision/error involves agent
  CAUSES: 'causes',             // error causes decision
  RESOLVES: 'resolves',         // decision resolves error
  RELATES_TO: 'relates_to',     // general relationship
  MENTIONS: 'mentions',         // message mentions concept
  ASSIGNED_TO: 'assigned_to',   // task assigned to agent
  DEPENDS_ON: 'depends_on',     // task depends on task
  PART_OF: 'part_of',           // concept part of broader concept
  OCCURRED_IN: 'occurred_in'    // event occurred in session
};

/**
 * Initialize the knowledge graph storage
 */
function initialize(workspaceDir) {
  GRAPH_DIR = path.join(workspaceDir, 'memory', '_graph');
  NODES_FILE = path.join(GRAPH_DIR, 'nodes.json');
  EDGES_FILE = path.join(GRAPH_DIR, 'edges.json');
  INDEX_FILE = path.join(GRAPH_DIR, 'index.json');

  // Ensure directory exists
  if (!fs.existsSync(GRAPH_DIR)) {
    fs.mkdirSync(GRAPH_DIR, { recursive: true });
    log.info('KnowledgeGraph', `Created graph directory: ${GRAPH_DIR}`);
  }

  // Load existing graph data
  loadGraph();

  // Initialize agent nodes (always present)
  const agentNames = {
    '1': 'Architect',
    '2': 'Infra',
    '3': 'Frontend',
    '4': 'Backend',
    '5': 'Analyst',
    '6': 'Reviewer'
  };

  for (const [paneId, name] of Object.entries(agentNames)) {
    const nodeId = `agent:${paneId}`;
    if (!nodes.has(nodeId)) {
      addNode(NODE_TYPES.AGENT, name, { paneId, role: name });
    }
  }

  log.info('KnowledgeGraph', `Initialized with ${nodes.size} nodes, ${edges.size} edges`);
}

/**
 * Load graph from persistent storage
 */
function loadGraph() {
  try {
    // Load nodes
    if (fs.existsSync(NODES_FILE)) {
      const nodesData = JSON.parse(fs.readFileSync(NODES_FILE, 'utf-8'));
      for (const [id, node] of Object.entries(nodesData)) {
        nodes.set(id, node);

        // Rebuild type index
        if (!nodeIndex.has(node.type)) {
          nodeIndex.set(node.type, new Set());
        }
        nodeIndex.get(node.type).add(id);

        // Rebuild label index
        const normalizedLabel = normalizeLabel(node.label);
        labelIndex.set(normalizedLabel, id);
      }
    }

    // Load edges
    if (fs.existsSync(EDGES_FILE)) {
      const edgesData = JSON.parse(fs.readFileSync(EDGES_FILE, 'utf-8'));
      for (const [id, edge] of Object.entries(edgesData)) {
        edges.set(id, edge);

        // Rebuild adjacency index
        addToAdjacency(edge.source, edge.target, id);
      }
    }

    log.info('KnowledgeGraph', `Loaded ${nodes.size} nodes, ${edges.size} edges from disk`);
  } catch (err) {
    log.error('KnowledgeGraph', `Failed to load graph: ${err.message}`);
  }
}

/**
 * Save graph to persistent storage
 */
function saveGraph() {
  try {
    // Save nodes
    const nodesObj = Object.fromEntries(nodes);
    fs.writeFileSync(NODES_FILE, JSON.stringify(nodesObj, null, 2));

    // Save edges
    const edgesObj = Object.fromEntries(edges);
    fs.writeFileSync(EDGES_FILE, JSON.stringify(edgesObj, null, 2));

    log.info('KnowledgeGraph', `Saved ${nodes.size} nodes, ${edges.size} edges`);
  } catch (err) {
    log.error('KnowledgeGraph', `Failed to save graph: ${err.message}`);
  }
}

/**
 * Normalize label for indexing
 */
function normalizeLabel(label) {
  return String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
}

/**
 * Generate unique node ID
 */
function generateNodeId(type, label) {
  const normalized = normalizeLabel(label);
  return `${type}:${normalized}`;
}

/**
 * Generate unique edge ID
 */
function generateEdgeId(source, target, type) {
  return `${source}->${target}:${type}`;
}

/**
 * Add to adjacency index
 */
function addToAdjacency(source, target, edgeId) {
  if (!adjacency.has(source)) {
    adjacency.set(source, new Map());
  }
  const sourceAdj = adjacency.get(source);
  if (!sourceAdj.has(target)) {
    sourceAdj.set(target, []);
  }
  sourceAdj.get(target).push(edgeId);

  // Also add reverse for undirected traversal
  if (!adjacency.has(target)) {
    adjacency.set(target, new Map());
  }
  const targetAdj = adjacency.get(target);
  if (!targetAdj.has(source)) {
    targetAdj.set(source, []);
  }
  targetAdj.get(source).push(edgeId);
}

/**
 * Add a node to the graph
 */
function addNode(type, label, data = {}) {
  const nodeId = generateNodeId(type, label);

  if (nodes.has(nodeId)) {
    // Update existing node
    const existing = nodes.get(nodeId);
    existing.data = { ...existing.data, ...data };
    existing.updated = Date.now();
    nodes.set(nodeId, existing);
    return nodeId;
  }

  const node = {
    type,
    label,
    data,
    created: Date.now(),
    updated: Date.now()
  };

  nodes.set(nodeId, node);

  // Update type index
  if (!nodeIndex.has(type)) {
    nodeIndex.set(type, new Set());
  }
  nodeIndex.get(type).add(nodeId);

  // Update label index
  labelIndex.set(normalizeLabel(label), nodeId);

  return nodeId;
}

/**
 * Add an edge to the graph
 */
function addEdge(sourceId, targetId, type, data = {}, weight = 1) {
  if (!nodes.has(sourceId) || !nodes.has(targetId)) {
    log.warn('KnowledgeGraph', `Cannot add edge: missing node(s) ${sourceId} -> ${targetId}`);
    return null;
  }

  const edgeId = generateEdgeId(sourceId, targetId, type);

  if (edges.has(edgeId)) {
    // Update existing edge - increase weight
    const existing = edges.get(edgeId);
    existing.weight = (existing.weight || 1) + weight;
    existing.data = { ...existing.data, ...data };
    edges.set(edgeId, existing);
    return edgeId;
  }

  const edge = {
    source: sourceId,
    target: targetId,
    type,
    weight,
    data,
    created: Date.now()
  };

  edges.set(edgeId, edge);
  addToAdjacency(sourceId, targetId, edgeId);

  return edgeId;
}

/**
 * Get a node by ID
 */
function getNode(nodeId) {
  return nodes.get(nodeId) || null;
}

/**
 * Find node by label (fuzzy match)
 */
function findNodeByLabel(label, type = null) {
  const normalized = normalizeLabel(label);

  // Exact match first
  const exactId = labelIndex.get(normalized);
  if (exactId) {
    const node = nodes.get(exactId);
    if (!type || node.type === type) {
      return { id: exactId, ...node };
    }
  }

  // Partial match
  const results = [];
  for (const [id, node] of nodes) {
    if (type && node.type !== type) continue;

    const nodeNormalized = normalizeLabel(node.label);
    if (nodeNormalized.includes(normalized) || normalized.includes(nodeNormalized)) {
      results.push({ id, ...node, score: calculateMatchScore(normalized, nodeNormalized) });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results[0] || null;
}

/**
 * Calculate string match score
 */
function calculateMatchScore(query, target) {
  if (query === target) return 1.0;
  if (target.includes(query)) return 0.8;
  if (query.includes(target)) return 0.6;

  // Jaccard similarity on words
  const queryWords = new Set(query.split('_'));
  const targetWords = new Set(target.split('_'));
  const intersection = new Set([...queryWords].filter(w => targetWords.has(w)));
  const union = new Set([...queryWords, ...targetWords]);

  return intersection.size / union.size;
}

/**
 * Get all nodes of a type
 */
function getNodesByType(type) {
  const nodeIds = nodeIndex.get(type) || new Set();
  return [...nodeIds].map(id => ({ id, ...nodes.get(id) }));
}

/**
 * Get neighbors of a node
 */
function getNeighbors(nodeId, edgeType = null, direction = 'both') {
  const neighbors = [];
  const adj = adjacency.get(nodeId);

  if (!adj) return neighbors;

  for (const [targetId, edgeIds] of adj) {
    for (const edgeId of edgeIds) {
      const edge = edges.get(edgeId);
      if (!edge) continue;

      if (edgeType && edge.type !== edgeType) continue;

      if (direction === 'outgoing' && edge.source !== nodeId) continue;
      if (direction === 'incoming' && edge.target !== nodeId) continue;

      neighbors.push({
        nodeId: targetId,
        node: nodes.get(targetId),
        edge: { id: edgeId, ...edge }
      });
    }
  }

  return neighbors;
}

/**
 * Query the graph with natural language
 * "Show everything related to trigger delivery"
 */
function query(queryStr, options = {}) {
  const { maxDepth = 2, maxResults = 50, includeTypes = null } = options;

  // Extract key concepts from query
  const concepts = extractConcepts(queryStr);

  // Find starting nodes
  const startNodes = [];
  for (const concept of concepts) {
    const found = findNodeByLabel(concept);
    if (found) {
      startNodes.push(found);
    }

    // Also search in node data
    for (const [id, node] of nodes) {
      const dataStr = JSON.stringify(node.data).toLowerCase();
      if (dataStr.includes(concept.toLowerCase())) {
        if (!startNodes.find(n => n.id === id)) {
          startNodes.push({ id, ...node, score: 0.5 });
        }
      }
    }
  }

  if (startNodes.length === 0) {
    return { nodes: [], edges: [], query: queryStr, concepts };
  }

  // BFS traversal from start nodes
  const visited = new Set();
  const resultNodes = new Map();
  const resultEdges = new Map();
  const queue = startNodes.map(n => ({ node: n, depth: 0 }));

  while (queue.length > 0 && resultNodes.size < maxResults) {
    const { node, depth } = queue.shift();

    if (visited.has(node.id)) continue;
    visited.add(node.id);

    // Filter by type if specified
    if (includeTypes && !includeTypes.includes(node.type)) continue;

    resultNodes.set(node.id, node);

    if (depth >= maxDepth) continue;

    // Get neighbors
    const neighbors = getNeighbors(node.id);
    for (const { nodeId, node: neighborNode, edge } of neighbors) {
      if (!visited.has(nodeId)) {
        queue.push({ node: { id: nodeId, ...neighborNode }, depth: depth + 1 });
      }
      resultEdges.set(edge.id, edge);
    }
  }

  return {
    nodes: [...resultNodes.values()],
    edges: [...resultEdges.values()],
    query: queryStr,
    concepts,
    startNodes: startNodes.map(n => n.id)
  };
}

/**
 * Extract concepts from natural language query
 */
function extractConcepts(queryStr) {
  // Remove common words
  const stopWords = new Set([
    'show', 'everything', 'related', 'to', 'the', 'a', 'an', 'all', 'about',
    'what', 'where', 'when', 'how', 'why', 'is', 'are', 'was', 'were',
    'find', 'get', 'list', 'display', 'with', 'for', 'and', 'or', 'in'
  ]);

  const words = queryStr.toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Also try multi-word concepts
  const concepts = [...words];

  // Check for 2-word phrases
  for (let i = 0; i < words.length - 1; i++) {
    concepts.push(`${words[i]}_${words[i + 1]}`);
  }

  return concepts;
}

/**
 * Record a file access event
 */
function recordFileAccess(agentPaneId, filePath, action = 'read') {
  const agentId = `agent:${agentPaneId}`;
  const fileId = addNode(NODE_TYPES.FILE, filePath, { path: filePath, lastAccess: Date.now() });

  const edgeType = action === 'write' || action === 'modify' ? EDGE_TYPES.MODIFIES : EDGE_TYPES.TOUCHES;
  addEdge(agentId, fileId, edgeType, { action, timestamp: Date.now() });

  return { agentId, fileId };
}

/**
 * Record a decision
 */
function recordDecision(agentPaneId, description, context = {}) {
  const agentId = `agent:${agentPaneId}`;
  const decisionId = addNode(NODE_TYPES.DECISION, description, {
    description,
    context,
    timestamp: Date.now()
  });

  addEdge(decisionId, agentId, EDGE_TYPES.INVOLVES);

  // Link to related files if any
  if (context.files) {
    for (const file of context.files) {
      const fileId = addNode(NODE_TYPES.FILE, file, { path: file });
      addEdge(decisionId, fileId, EDGE_TYPES.RELATES_TO);
    }
  }

  return decisionId;
}

/**
 * Record an error
 */
function recordError(agentPaneId, errorMsg, context = {}) {
  const agentId = `agent:${agentPaneId}`;
  const errorId = addNode(NODE_TYPES.ERROR, errorMsg.substring(0, 100), {
    message: errorMsg,
    context,
    timestamp: Date.now()
  });

  addEdge(errorId, agentId, EDGE_TYPES.INVOLVES);

  // Link to related files if any
  if (context.file) {
    const fileId = addNode(NODE_TYPES.FILE, context.file, { path: context.file });
    addEdge(errorId, fileId, EDGE_TYPES.RELATES_TO);
  }

  return errorId;
}

/**
 * Record a concept mention
 */
function recordConcept(concept, sourceId, context = {}) {
  const conceptId = addNode(NODE_TYPES.CONCEPT, concept, { ...context, mentions: (nodes.get(`concept:${normalizeLabel(concept)}`)?.data?.mentions || 0) + 1 });

  if (sourceId && nodes.has(sourceId)) {
    addEdge(sourceId, conceptId, EDGE_TYPES.MENTIONS);
  }

  return conceptId;
}

/**
 * Record a task
 */
function recordTask(taskId, description, assignedTo = null) {
  const nodeId = addNode(NODE_TYPES.TASK, `Task ${taskId}`, {
    taskId,
    description,
    timestamp: Date.now()
  });

  if (assignedTo) {
    const agentId = `agent:${assignedTo}`;
    if (nodes.has(agentId)) {
      addEdge(nodeId, agentId, EDGE_TYPES.ASSIGNED_TO);
    }
  }

  return nodeId;
}

/**
 * Link error to resolution decision
 */
function linkErrorResolution(errorId, decisionId) {
  if (nodes.has(errorId) && nodes.has(decisionId)) {
    addEdge(decisionId, errorId, EDGE_TYPES.RESOLVES);
  }
}

/**
 * Get agent node ID from role name or pane ID
 * @param {string} roleOrPaneId - Role name (e.g., 'Architect') or pane ID (e.g., '1')
 * @returns {string} Agent node ID
 */
function getAgentNodeId(roleOrPaneId) {
  // Map role names to pane IDs
  const roleToPane = {
    'architect': '1',
    'orchestrator': '2',
    'implementer a': '3', 'implementer_a': '3', 'worker a': '3', 'worker_a': '3',
    'implementer b': '4', 'implementer_b': '4', 'worker b': '4', 'worker_b': '4',
    'investigator': '5',
    'reviewer': '6'
  };

  const normalized = String(roleOrPaneId).toLowerCase().trim();
  const paneId = roleToPane[normalized] || roleOrPaneId;
  return `agent:${paneId}`;
}

/**
 * Get related nodes with traversal depth
 * @param {string} nodeId - Starting node ID
 * @param {number} depth - How many hops to traverse
 * @returns {Object} - Related nodes and edges
 */
function getRelated(nodeId, depth = 2) {
  const visited = new Set();
  const resultNodes = new Map();
  const resultEdges = new Map();
  const queue = [{ id: nodeId, currentDepth: 0 }];

  // Add starting node
  const startNode = nodes.get(nodeId);
  if (startNode) {
    resultNodes.set(nodeId, { id: nodeId, ...startNode });
  }

  while (queue.length > 0) {
    const { id, currentDepth } = queue.shift();

    if (visited.has(id)) continue;
    visited.add(id);

    if (currentDepth >= depth) continue;

    const neighbors = getNeighbors(id);
    for (const { nodeId: neighborId, node: neighborNode, edge } of neighbors) {
      if (!resultNodes.has(neighborId)) {
        resultNodes.set(neighborId, { id: neighborId, ...neighborNode });
      }
      resultEdges.set(edge.id, edge);

      if (!visited.has(neighborId)) {
        queue.push({ id: neighborId, currentDepth: currentDepth + 1 });
      }
    }
  }

  return {
    nodes: [...resultNodes.values()],
    edges: [...resultEdges.values()],
    center: nodeId
  };
}

/**
 * Get graph statistics
 */
function getStats() {
  const stats = {
    totalNodes: nodes.size,
    totalEdges: edges.size,
    nodesByType: {},
    edgesByType: {},
    topConnected: []
  };

  // Count nodes by type
  for (const [type, ids] of nodeIndex) {
    stats.nodesByType[type] = ids.size;
  }

  // Count edges by type
  const edgeTypeCounts = {};
  for (const [, edge] of edges) {
    edgeTypeCounts[edge.type] = (edgeTypeCounts[edge.type] || 0) + 1;
  }
  stats.edgesByType = edgeTypeCounts;

  // Find top connected nodes
  const connectivity = [];
  for (const [nodeId, adj] of adjacency) {
    connectivity.push({ nodeId, connections: adj.size });
  }
  connectivity.sort((a, b) => b.connections - a.connections);
  stats.topConnected = connectivity.slice(0, 10).map(c => ({
    ...c,
    node: nodes.get(c.nodeId)
  }));

  return stats;
}

/**
 * Export graph for visualization
 */
function exportForVisualization() {
  const visNodes = [];
  const visEdges = [];

  for (const [id, node] of nodes) {
    visNodes.push({
      id,
      label: node.label,
      type: node.type,
      data: node.data
    });
  }

  for (const [id, edge] of edges) {
    visEdges.push({
      id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      weight: edge.weight
    });
  }

  return { nodes: visNodes, edges: visEdges };
}

/**
 * Clear the graph
 */
function clearGraph() {
  nodes.clear();
  edges.clear();
  nodeIndex.clear();
  labelIndex.clear();
  adjacency.clear();

  if (GRAPH_DIR && fs.existsSync(GRAPH_DIR)) {
    try {
      if (fs.existsSync(NODES_FILE)) fs.unlinkSync(NODES_FILE);
      if (fs.existsSync(EDGES_FILE)) fs.unlinkSync(EDGES_FILE);
      if (fs.existsSync(INDEX_FILE)) fs.unlinkSync(INDEX_FILE);
    } catch (err) {
      log.error('KnowledgeGraph', `Failed to clear files: ${err.message}`);
    }
  }

  log.info('KnowledgeGraph', 'Graph cleared');
}

/**
 * Shutdown - save and cleanup
 */
function shutdown() {
  saveGraph();
  log.info('KnowledgeGraph', 'Shutdown complete');
}

module.exports = {
  NODE_TYPES,
  EDGE_TYPES,
  initialize,
  save: saveGraph,
  saveGraph,
  loadGraph,
  addNode,
  addEdge,
  getNode,
  findNodeByLabel,
  getNodesByType,
  getNeighbors,
  getAgentNodeId,
  getRelated,
  query,
  recordFileAccess,
  recordDecision,
  recordError,
  recordConcept,
  recordTask,
  linkErrorResolution,
  getStats,
  exportForVisualization,
  clearGraph,
  shutdown
};
