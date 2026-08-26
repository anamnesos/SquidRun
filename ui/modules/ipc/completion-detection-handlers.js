/**
 * Completion Detection IPC Handlers
 * Channels: check-completion, get-completion-patterns
 */
const { stageImmediateTaskExtraction } = require('../cognitive-memory-immunity');

function triggerBehavioralExtraction(ctx, payload) {
  Promise.resolve()
    .then(() => stageImmediateTaskExtraction(payload, {
      store: ctx?.cognitiveMemoryStore,
      storeOptions: ctx?.cognitiveStoreOptions,
    }))
    .catch((err) => {
      const logger = ctx?.logger || console;
      logger?.warn?.('CompletionDetection', `Behavioral extraction failed: ${err.message}`);
    });
}

function registerCompletionDetectionHandlers(ctx) {
  const { ipcMain } = ctx;

  const COMPLETION_PATTERNS = [
    /task\s+(complete|done|finished)/i,
    /completed?\s+(task|work|assignment)/i,
    /ready\s+for\s+(review|next|handoff)/i,
    /handing\s+off\s+to/i,
    /trigger(ing|ed)?\s+(lead|architect|infra|backend|analyst|builder|oracle)/i,
    /✅\s*(done|complete|finished)/i,
    /DONE:/i,
    /COMPLETE:/i,
  ];

  ipcMain.handle('check-completion', (event, input) => {
    const payload = (input && typeof input === 'object' && !Array.isArray(input))
      ? input
      : { text: input };
    const text = String(payload.text || '');
    for (const pattern of COMPLETION_PATTERNS) {
      if (pattern.test(text)) {
        triggerBehavioralExtraction(ctx, {
          source: 'completion_detection',
          paneId: payload.paneId || null,
          taskId: payload.taskId || null,
          objective: payload.objective || text,
          status: payload.status || null,
          text,
          files: Array.isArray(payload.files) ? payload.files : [],
          metadata: payload.metadata || {},
          contextSnapshot: payload.contextSnapshot || {},
          session: payload.session || null,
        });
        return { completed: true, pattern: pattern.toString() };
      }
    }
    return { completed: false };
  });

  ipcMain.handle('get-completion-patterns', () => {
    return COMPLETION_PATTERNS.map(p => p.toString());
  });
}


function unregisterCompletionDetectionHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('check-completion');
    ipcMain.removeHandler('get-completion-patterns');
}

registerCompletionDetectionHandlers.unregister = unregisterCompletionDetectionHandlers;
module.exports = { registerCompletionDetectionHandlers };
