/**
 * Completion Detection IPC Handlers
 * Channels: check-completion, get-completion-patterns
 */

function registerCompletionDetectionHandlers(ctx) {
  const { ipcMain } = ctx;

  const COMPLETION_PATTERNS = [
    /task\s+(complete|done|finished)/i,
    /completed?\s+(task|work|assignment)/i,
    /ready\s+for\s+(review|next|handoff)/i,
    /handing\s+off\s+to/i,
    /trigger(ing|ed)?\s+(lead|worker|reviewer)/i,
    /✅\s*(done|complete|finished)/i,
    /DONE:/i,
    /COMPLETE:/i,
  ];

  ipcMain.handle('check-completion', (event, text) => {
    for (const pattern of COMPLETION_PATTERNS) {
      if (pattern.test(text)) {
        return { completed: true, pattern: pattern.toString() };
      }
    }
    return { completed: false };
  });

  ipcMain.handle('get-completion-patterns', () => {
    return COMPLETION_PATTERNS.map(p => p.toString());
  });
}

module.exports = { registerCompletionDetectionHandlers };
