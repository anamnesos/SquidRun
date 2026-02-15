/**
 * Runtime knowledge graph service.
 *
 * Provides the subset of graph API used by IPC handlers without depending on
 * the legacy memory module entrypoint.
 */

const graph = require('./knowledge-graph-store');

let initializedWorkspace = null;

function initialize(workspacePath) {
  const resolved = String(workspacePath || '').trim();
  if (!resolved) {
    throw new Error('workspacePath required');
  }

  if (initializedWorkspace === resolved) return;
  graph.initialize(resolved);
  initializedWorkspace = resolved;
}

function queryGraph(queryStr, options = {}) {
  return graph.query(queryStr, options);
}

function getGraphVisualization() {
  return graph.exportForVisualization();
}

function getGraphStats() {
  return graph.getStats();
}

function getRelatedNodes(nodeId, depth = 2) {
  return graph.getRelated(nodeId, depth);
}

function recordConcept(name, description = '', relatedTo = []) {
  const conceptId = graph.recordConcept(name, null, { description });

  if (Array.isArray(relatedTo) && relatedTo.length > 0) {
    for (const relatedName of relatedTo) {
      const relatedId = graph.recordConcept(relatedName, null, {});
      graph.addEdge(conceptId, relatedId, graph.EDGE_TYPES.RELATES_TO);
    }
  }

  return conceptId;
}

function saveGraph() {
  return graph.save();
}

function getNodesByType(type) {
  return graph.getNodesByType(type);
}

module.exports = {
  initialize,
  queryGraph,
  getGraphVisualization,
  getGraphStats,
  getRelatedNodes,
  recordConcept,
  saveGraph,
  getNodesByType,
};
