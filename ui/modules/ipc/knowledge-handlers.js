/**
 * Knowledge Base IPC Handlers
 * Channels: knowledge-ingest, knowledge-search, knowledge-stats
 */

const path = require('path');
const KnowledgeBase = require('../knowledge-base');
const { createLocalEmbedder } = require('../local-embedder');

function registerKnowledgeHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain || !WORKSPACE_PATH) return;

  if (!ctx.knowledgeEmbedder) {
    ctx.knowledgeEmbedder = createLocalEmbedder();
  }
  if (!ctx.knowledgeBase) {
    const baseDir = path.join(WORKSPACE_PATH, 'knowledge');
    ctx.knowledgeBase = new KnowledgeBase(baseDir, { embedder: ctx.knowledgeEmbedder });
  }

  const kb = ctx.knowledgeBase;

  ipcMain.handle('knowledge-ingest', async (event, payload = {}) => {
    const { paths = [] } = payload;
    try {
      const summary = await kb.ingestPaths(paths);
      return { success: true, summary };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('knowledge-search', async (event, payload = {}) => {
    const { query = '', topK = 5 } = payload;
    try {
      const results = await kb.search(query, topK);
      return { success: true, results };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('knowledge-stats', () => {
    try {
      const stats = kb.getStats();
      return { success: true, stats };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}


function unregisterKnowledgeHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('knowledge-ingest');
    ipcMain.removeHandler('knowledge-search');
    ipcMain.removeHandler('knowledge-stats');
}

registerKnowledgeHandlers.unregister = unregisterKnowledgeHandlers;
module.exports = { registerKnowledgeHandlers };
