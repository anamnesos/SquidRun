/**
 * SquidRun Model Selector - Per-pane model switching (Claude/Codex/Gemini)
 * Extracted from renderer.js for modularization
 */

const { invokeBridge } = require('./renderer-bridge');
const log = require('./logger');
const terminal = require('./terminal');
const settings = require('./settings');
const { showStatusNotice } = require('./notifications');
const { registerScopedIpcListener } = require('./renderer-ipc-registry');

/**
 * Detect model family from a command string
 * @param {string} cmd - The pane command string
 * @returns {string} 'claude' | 'codex' | 'gemini'
 */
function detectModelFamily(cmd) {
  const lower = (cmd || 'claude').toLowerCase();
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('gemini')) return 'gemini';
  return 'claude';
}

/**
 * Set the data-cli attribute on a pane element for CSS variable binding.
 * @param {string} paneId - Pane ID
 * @param {string} model - Model family ('claude', 'codex', 'gemini')
 */
function setPaneCliAttribute(paneId, model) {
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (pane) pane.dataset.cli = model;
}

/**
 * Initialize model selectors to match current pane commands
 */
async function initModelSelectors() {
  try {
    const paneCommands = await invokeBridge('get-pane-commands');

    document.querySelectorAll('.model-selector').forEach(select => {
      const paneId = select.dataset.paneId;
      const runtimeOverride = typeof terminal.getPaneRuntimeOverride === 'function'
        ? terminal.getPaneRuntimeOverride(paneId)
        : null;
      const cmd = (runtimeOverride?.command || paneCommands[paneId] || 'claude').toLowerCase();

      // Detect model from command
      const model = detectModelFamily(cmd);
      select.value = model;

      // Store previous value for rollback
      select.dataset.previousValue = select.value;

      // Set data-cli attribute on pane element for CSS color binding
      setPaneCliAttribute(paneId, model);
    });

    log.info('ModelSelector', 'Initialized from pane commands (data-cli set)');
  } catch (err) {
    log.error('ModelSelector', 'Failed to initialize:', err);
  }
}

/**
 * Setup change listeners on model selector dropdowns
 */
// Only the pane's OWNER window respawns on completion; mirror windows (the
// squid room) sync UI only. The arbiter would deny a non-owner respawn
// anyway - this guard keeps the denial noise out of the logs.
function isPaneOwnerWindow() {
  const windowKey = document.body?.dataset?.windowKey || 'main';
  return windowKey === 'main';
}

// Until the running main fans pane-model-changed out to every window, a
// mirror window's dropdown would stay disabled forever after a switch it
// initiated (wave 3, S426). Confirm against settings via an IPC channel the
// running main already has, then re-enable with the truthful value. Harmless
// after the fan-out lands: completion usually wins the race and re-enables
// first, and the confirm just agrees.
function scheduleSwitchCompletionFallback(select, paneId) {
  setTimeout(async () => {
    if (!select.isConnected || select.disabled === false) return;
    try {
      const paneCommands = await invokeBridge('get-pane-commands');
      const confirmed = detectModelFamily(paneCommands?.[paneId]);
      select.value = confirmed;
      select.dataset.previousValue = confirmed;
      setPaneCliAttribute(paneId, confirmed);
      log.info('ModelSelector', `Pane ${paneId} switch confirmed via settings poll: ${confirmed}`);
    } catch (err) {
      log.warn('ModelSelector', `Switch confirmation poll failed for pane ${paneId}: ${err?.message || err}`);
    } finally {
      select.disabled = false;
    }
  }, 4000);
}

let modelSelectorDelegationBound = false;

// DELEGATED listener (wave 3, S426): the squid room creates its pet-pane
// selectors at shell-config time and can re-render them on window-context
// updates - per-node binding at DOMContentLoaded left re-created dropdowns
// silently dead (the original v2-dropdown debacle class). One document-level
// listener covers every .model-selector that ever exists.
function setupModelSelectorListeners() {
  if (modelSelectorDelegationBound) return;
  modelSelectorDelegationBound = true;
  document.addEventListener('change', async (event) => {
    const select = event.target;
    if (!select || !select.classList || !select.classList.contains('model-selector')) return;
    const paneId = select.dataset.paneId;
    const model = select.value;
    const previousValue = select.dataset.previousValue || 'claude';

    select.disabled = true;
    showStatusNotice(`Switching pane ${paneId} to ${model} - session will restart...`);

    try {
      const result = await invokeBridge('switch-pane-model', { paneId, model });

      if (!result.success) {
        throw new Error(result.error);
      }

      select.dataset.previousValue = model;
      log.info('ModelSelector', `Pane ${paneId} switched to ${model}`);
      scheduleSwitchCompletionFallback(select, paneId);
    } catch (err) {
      log.error('ModelSelector', `Switch failed for pane ${paneId}:`, err);
      showStatusNotice(`Switch failed: ${err.message}`, 'error');
      select.value = previousValue; // Rollback UI
      select.disabled = false;
    }
  });
}

/**
 * Setup IPC listener for model change completion
 */
function setupModelChangeListener() {
  registerScopedIpcListener('model-selector', 'pane-model-changed', async (event, { paneId, model, ownerWindowKey }) => {
    const select = document.querySelector(`.model-selector[data-pane-id="${paneId}"]`);

    // Update data-cli attribute immediately on model switch
    setPaneCliAttribute(paneId, model);

    // Mirror windows sync UI only - the switch may have been initiated in
    // another window, so the value must follow the completion, not the
    // dropdown's last local state.
    if (select) {
      select.value = model;
      select.dataset.previousValue = model;
    }

    const myWindowKey = document.body?.dataset?.windowKey || 'main';
    const isOwner = ownerWindowKey ? ownerWindowKey === myWindowKey : isPaneOwnerWindow();

    if (!isOwner) {
      if (select) select.disabled = false;
      log.info('ModelSelector', `Pane ${paneId} model change synced (mirror window, no respawn)`);
      return;
    }

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
  setPaneCliAttribute,
};

