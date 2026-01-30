/**
 * Knowledge Graph IPC Handlers
 * Task #36 - Cross-Session Knowledge Graph
 *
 * Channels:
 * - graph-query: Natural language query
 * - graph-visualize: Get visualization data
 * - graph-stats: Get graph statistics
 * - graph-related: Get related nodes
 * - graph-record-concept: Record a concept
 * - graph-save: Force save to disk
 */

const path = require('path');

function registerKnowledgeGraphHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain || !WORKSPACE_PATH) return;

  // Lazy load memory module to get graph
  let memoryModule = null;
  function getMemory() {
    if (!memoryModule) {
      memoryModule = require('../memory');
      memoryModule.initialize();
    }
    return memoryModule;
  }

  /**
   * Query the knowledge graph with natural language
   * "Show everything related to trigger delivery"
   */
  ipcMain.handle('graph-query', async (event, payload = {}) => {
    const { query = '', maxDepth = 2, maxResults = 50, includeTypes = null } = payload;
    try {
      const memory = getMemory();
      const results = memory.queryGraph(query, { maxDepth, maxResults, includeTypes });
      return { success: true, results };
    } catch (err) {
      console.error('[KnowledgeGraph] Query error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get visualization data for the graph
   */
  ipcMain.handle('graph-visualize', async (event, payload = {}) => {
    const { filter = {} } = payload;
    try {
      const memory = getMemory();
      const data = memory.getGraphVisualization(filter);
      return { success: true, data };
    } catch (err) {
      console.error('[KnowledgeGraph] Visualize error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get graph statistics
   */
  ipcMain.handle('graph-stats', async () => {
    try {
      const memory = getMemory();
      const stats = memory.getGraphStats();
      return { success: true, stats };
    } catch (err) {
      console.error('[KnowledgeGraph] Stats error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get related nodes from a starting node
   */
  ipcMain.handle('graph-related', async (event, payload = {}) => {
    const { nodeId, depth = 2 } = payload;
    if (!nodeId) {
      return { success: false, error: 'nodeId required' };
    }
    try {
      const memory = getMemory();
      const results = memory.getRelatedNodes(nodeId, depth);
      return { success: true, results };
    } catch (err) {
      console.error('[KnowledgeGraph] Related error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Record a concept in the graph
   */
  ipcMain.handle('graph-record-concept', async (event, payload = {}) => {
    const { name, description = '', relatedTo = [] } = payload;
    if (!name) {
      return { success: false, error: 'name required' };
    }
    try {
      const memory = getMemory();
      const nodeId = memory.recordConcept(name, description, relatedTo);
      return { success: true, nodeId };
    } catch (err) {
      console.error('[KnowledgeGraph] Record concept error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Force save graph to disk
   */
  ipcMain.handle('graph-save', async () => {
    try {
      const memory = getMemory();
      memory.saveGraph();
      return { success: true };
    } catch (err) {
      console.error('[KnowledgeGraph] Save error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get nodes by type
   */
  ipcMain.handle('graph-nodes-by-type', async (event, payload = {}) => {
    const { type } = payload;
    if (!type) {
      return { success: false, error: 'type required' };
    }
    try {
      const memory = getMemory();
      const nodes = memory.graph.getNodesByType(type);
      return { success: true, nodes };
    } catch (err) {
      console.error('[KnowledgeGraph] Nodes by type error:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerKnowledgeGraphHandlers };
