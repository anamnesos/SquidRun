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
const {
  claudeModelForSelectorValue,
  normalizeClaudeModelId,
  selectorValueForCommand,
  selectorValueForClaudeModel,
} = require('./claude-model-options');

/**
 * Detect model family from a command string
 * @param {string} cmd - The pane command string
 * @returns {string} 'claude' | 'codex' | 'gemini'
 */
function detectModelFamily(cmd) {
  const lower = (cmd || 'claude').toLowerCase();
  if (lower.startsWith('claude:')) return 'claude';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('gemini')) return 'gemini';
  return 'claude';
}

function hasSelectorValue(select, value) {
  if (!select || !value) return false;
  return Array.from(select.options || []).some((option) => option.value === value);
}

function setSelectorValue(select, selectorValue, modelFamily) {
  if (!select) return modelFamily || 'claude';
  const nextValue = hasSelectorValue(select, selectorValue) ? selectorValue : (modelFamily || 'claude');
  select.value = nextValue;
  select.dataset.previousValue = nextValue;
  return nextValue;
}

function resolveSelectedModel(select) {
  const selectorValue = String(select?.value || 'claude').trim().toLowerCase();
  const model = detectModelFamily(selectorValue);
  const option = select?.selectedOptions?.[0] || null;
  const claudeModel = model === 'claude'
    ? normalizeClaudeModelId(option?.dataset?.claudeModel || claudeModelForSelectorValue(selectorValue))
    : '';
  return {
    model,
    selectorValue,
    ...(model === 'claude' ? { claudeModel } : {}),
  };
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

function commandForModelFallback(model) {
  if (model === 'gemini') return 'gemini';
  if (model === 'codex') return 'codex';
  return 'claude';
}

function syncArmRuntimeOverride(paneId, model, command = '') {
  if (typeof terminal.setPaneRuntimeOverride !== 'function') return;
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (!pane || pane.dataset?.squidRoomLivePane !== 'true') return;
  const nextCommand = String(
    command
    || pane.dataset.squidRoomCommand
    || terminal.getPaneRuntimeOverride?.(paneId)?.command
    || commandForModelFallback(model)
  ).trim();
  pane.dataset.cli = model;
  if (nextCommand) pane.dataset.squidRoomCommand = nextCommand;
  terminal.setPaneRuntimeOverride(paneId, {
    label: pane.dataset.squidRoomLabel || paneId,
    roleLabel: pane.dataset.squidRoomLabel || pane.dataset.squidRoomRole || paneId,
    roleId: pane.dataset.squidRoomRoleId || pane.dataset.squidRoomRouteTarget || paneId,
    routeTarget: pane.dataset.squidRoomRouteTarget || paneId,
    provider: model,
    command: nextCommand,
    commandSourcePaneId: pane.dataset.squidRoomCommandSourcePaneId,
    workingDir: pane.dataset.squidRoomWorkingDir,
    startupMessage: pane.dataset.squidRoomStartupMessage,
    spawnCommandOnCreate: true,
    recreateOnWorkingDirMismatch: true,
  });
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
      const command = paneCommands[paneId] || runtimeOverride?.command || 'claude';
      const cmd = command.toLowerCase();

      // Detect model from command
      const model = detectModelFamily(cmd);
      const selectorValue = selectorValueForCommand(command, model);
      setSelectorValue(select, selectorValue, model);

      // Set data-cli attribute on pane element for CSS color binding
      setPaneCliAttribute(paneId, model);
      syncArmRuntimeOverride(paneId, model, command);
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

function getRendererInstanceScope() {
  const bodyDataset = document.body?.dataset || {};
  return {
    windowKey: String(bodyDataset.windowKey || 'main').trim() || 'main',
    profileName: String(bodyDataset.profileName || 'main').trim() || 'main',
    sessionScopeId: String(bodyDataset.sessionScopeId || '').trim(),
  };
}

function resolveOwnerAssertion(payload = {}) {
  const ownerInstance = payload.ownerInstance && typeof payload.ownerInstance === 'object'
    ? payload.ownerInstance
    : {};
  const ownerWindowKey = String(ownerInstance.windowKey || payload.ownerWindowKey || '').trim();
  const ownerProfileName = String(ownerInstance.profileName || payload.ownerProfileName || '').trim();
  const ownerSessionScopeId = String(ownerInstance.sessionScopeId || payload.ownerSessionScopeId || '').trim();
  return {
    windowKey: ownerWindowKey,
    profileName: ownerProfileName,
    sessionScopeId: ownerSessionScopeId,
  };
}

function isOwnerAssertionMatch(payload = {}) {
  const expected = resolveOwnerAssertion(payload);
  const actual = getRendererInstanceScope();
  if (!expected.windowKey && !expected.profileName && !expected.sessionScopeId) {
    return isPaneOwnerWindow();
  }
  for (const field of ['windowKey', 'profileName', 'sessionScopeId']) {
    if (expected[field] && expected[field] !== actual[field]) {
      return false;
    }
  }
  return true;
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
      const command = paneCommands?.[paneId] || '';
      const confirmed = detectModelFamily(command);
      const selectorValue = selectorValueForCommand(command, confirmed);
      setSelectorValue(select, selectorValue, confirmed);
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

// DELEGATED listener (wave 3, S426): the squid room creates its arm-tile
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
    const selected = resolveSelectedModel(select);
    const { model, selectorValue, claudeModel } = selected;
    const previousValue = select.dataset.previousValue || 'claude';
    const selectedLabel = select.selectedOptions?.[0]?.textContent?.trim() || selectorValue;

    select.disabled = true;
    showStatusNotice(`Switching pane ${paneId} to ${selectedLabel} - session will restart...`);

    try {
      const result = await invokeBridge('switch-pane-model', {
        paneId,
        model,
        ...(model === 'claude' ? { claudeModel } : {}),
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      select.dataset.previousValue = selectorValue;
      log.info('ModelSelector', `Pane ${paneId} switched to ${selectorValue}`);
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
  registerScopedIpcListener('model-selector', 'pane-model-changed', async (event, payload = {}) => {
    const { paneId, model, command, claudeModel } = payload;
    const select = document.querySelector(`.model-selector[data-pane-id="${paneId}"]`);

    // Update data-cli attribute immediately on model switch
    setPaneCliAttribute(paneId, model);
    syncArmRuntimeOverride(paneId, model, command);

    // Mirror windows sync UI only - the switch may have been initiated in
    // another window, so the value must follow the completion, not the
    // dropdown's last local state.
    if (select) {
      const selectorValue = payload.selectorValue
        || (model === 'claude' && claudeModel ? selectorValueForClaudeModel(claudeModel) : selectorValueForCommand(command, model));
      setSelectorValue(select, selectorValue, model);
    }

    const myInstance = getRendererInstanceScope();
    const ownerAssertion = resolveOwnerAssertion(payload);
    const isOwner = isOwnerAssertionMatch(payload);
    log.info(
      'ModelSelector',
      `Pane ${paneId} owner assertion - expected=${JSON.stringify(ownerAssertion)} actual=${JSON.stringify(myInstance)} isOwner=${isOwner}`
    );

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
  _internals: {
    getRendererInstanceScope,
    resolveOwnerAssertion,
    isOwnerAssertionMatch,
    resolveSelectedModel,
  },
};
