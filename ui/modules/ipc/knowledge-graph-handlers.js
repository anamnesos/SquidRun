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

function registerKnowledgeGraphHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain || !WORKSPACE_PATH) return;

  // Lazy load graph service
  let graphService = null;
  function getGraphService() {
    if (!graphService) {
      graphService = require('../knowledge/knowledge-graph-service');
      graphService.initialize(WORKSPACE_PATH);
    }
    return graphService;
  }

  /**
   * Query the knowledge graph with natural language
   * "Show everything related to trigger delivery"
   */
  ipcMain.handle('graph-query', async (event, payload = {}) => {
    const { query = '', maxDepth = 2, maxResults = 50, includeTypes = null } = payload;
    try {
      const service = getGraphService();
      const results = service.queryGraph(query, { maxDepth, maxResults, includeTypes });
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
      const service = getGraphService();
      const data = service.getGraphVisualization(filter);
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
      const service = getGraphService();
      const stats = service.getGraphStats();
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
      const service = getGraphService();
      const results = service.getRelatedNodes(nodeId, depth);
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
      const service = getGraphService();
      const nodeId = service.recordConcept(name, description, relatedTo);
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
      const service = getGraphService();
      service.saveGraph();
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
      const service = getGraphService();
      const nodes = service.getNodesByType(type);
      return { success: true, nodes };
    } catch (err) {
      console.error('[KnowledgeGraph] Nodes by type error:', err);
      return { success: false, error: err.message };
    }
  });
}


function unregisterKnowledgeGraphHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('graph-query');
    ipcMain.removeHandler('graph-visualize');
    ipcMain.removeHandler('graph-stats');
    ipcMain.removeHandler('graph-related');
    ipcMain.removeHandler('graph-record-concept');
    ipcMain.removeHandler('graph-save');
    ipcMain.removeHandler('graph-nodes-by-type');
}

registerKnowledgeGraphHandlers.unregister = unregisterKnowledgeGraphHandlers;
module.exports = { registerKnowledgeGraphHandlers };
