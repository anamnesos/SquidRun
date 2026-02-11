/**
 * Hivemind Model Selector - Per-pane model switching (Claude/Codex/Gemini)
 * Extracted from renderer.js for modularization
 */

const { ipcRenderer } = require('electron');
const log = require('./logger');
const terminal = require('./terminal');
const settings = require('./settings');
const { showStatusNotice } = require('./notifications');

/**
 * Initialize model selectors to match current pane commands
 * @param {boolean} sdkModeEnabled - Whether SDK mode is active (disables selectors)
 */
async function initModelSelectors(sdkModeEnabled = false) {
  try {
    const paneCommands = await ipcRenderer.invoke('get-pane-commands');

    document.querySelectorAll('.model-selector').forEach(select => {
      const paneId = select.dataset.paneId;
      const cmd = (paneCommands[paneId] || 'claude').toLowerCase();

      // Detect model from command
      if (cmd.includes('codex')) {
        select.value = 'codex';
      } else if (cmd.includes('gemini')) {
        select.value = 'gemini';
      } else {
        select.value = 'claude';
      }

      // Store previous value for rollback
      select.dataset.previousValue = select.value;

      // Disable in SDK mode
      if (sdkModeEnabled) {
        select.disabled = true;
        select.title = 'Model switching not available in SDK mode';
      }
    });

    log.info('ModelSelector', 'Initialized from pane commands');
  } catch (err) {
    log.error('ModelSelector', 'Failed to initialize:', err);
  }
}

/**
 * Setup change listeners on model selector dropdowns
 */
function setupModelSelectorListeners() {
  document.querySelectorAll('.model-selector').forEach(select => {
    select.addEventListener('change', async (e) => {
      const paneId = e.target.dataset.paneId;
      const model = e.target.value;
      const previousValue = e.target.dataset.previousValue || 'claude';

      e.target.disabled = true;
      showStatusNotice(`Switching pane ${paneId} to ${model} - session will restart...`);

      try {
        const result = await ipcRenderer.invoke('switch-pane-model', { paneId, model });

        if (!result.success) {
          throw new Error(result.error);
        }

        e.target.dataset.previousValue = model;
        log.info('ModelSelector', `Pane ${paneId} switched to ${model}`);
      } catch (err) {
        log.error('ModelSelector', `Switch failed for pane ${paneId}:`, err);
        showStatusNotice(`Switch failed: ${err.message}`, 'error');
        e.target.value = previousValue; // Rollback UI
        e.target.disabled = false;
      }
    });
  });
}

/**
 * Setup IPC listener for model change completion
 */
function setupModelChangeListener() {
  ipcRenderer.on('pane-model-changed', async (event, { paneId, model }) => {
    const select = document.querySelector(`.model-selector[data-pane-id="${paneId}"]`);

    try {
      await settings.refreshSettingsFromMain();
      // Respawn with new model - restartPane handles kill/create/spawn sequence
      await terminal.restartPane(paneId, model);
      showStatusNotice(`Pane ${paneId} now running ${model}`);
      log.info('ModelSelector', `Pane ${paneId} respawned with ${model}`);
    } catch (err) {
      log.error('ModelSelector', `Spawn failed after model switch for pane ${paneId}:`, err);
      showStatusNotice('Spawn failed after model switch', 'error');
    } finally {
      if (select) {
        select.disabled = false;
      }
    }
  });
}

module.exports = {
  initModelSelectors,
  setupModelSelectorListeners,
  setupModelChangeListener,
};
