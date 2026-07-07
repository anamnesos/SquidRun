/**
 * SquidRun Command Palette - Quick access to all actions (Ctrl+K)
 * Extracted from renderer.js for modularization
 */

const log = require('./logger');
const terminal = require('./terminal');

const SHELL_V2_STATION_CONTROLS = Object.freeze([
  { key: 'interrupt', label: 'Interrupt', selector: (paneId) => `.interrupt-btn[data-pane-id="${paneId}"]` },
  { key: 'restart', label: 'Restart', selector: (paneId) => `.kickoff-btn[data-pane-id="${paneId}"]` },
  { key: 'fresh-session', label: 'Fresh Session', selector: (paneId) => `.fresh-session-btn[data-pane-id="${paneId}"]` },
  { key: 'lock', label: 'Toggle Lock', selector: (paneId) => `#lock-icon-${paneId}` },
  { key: 'role-info', label: 'Role Info', selector: (paneId) => `.pane-role-info-btn[data-pane-id="${paneId}"]` },
  { key: 'health', label: 'Health', selector: (paneId) => `#health-${paneId}` },
]);
const SHELL_V2_STATIONS = Object.freeze([
  ['2', 'Builder'],
  ['3', 'Oracle'],
]);

function activateCommandTarget(selector) {
  if (typeof document === 'undefined' || !selector) return false;
  const target = document.querySelector(selector);
  if (!target) return false;
  if (typeof target.click === 'function') {
    target.click();
  } else if (typeof target.focus === 'function') {
    target.focus();
  }
  return true;
}

function getShellV2StationCommands() {
  const commands = [];
  for (const [paneId, station] of SHELL_V2_STATIONS) {
    for (const control of SHELL_V2_STATION_CONTROLS) {
      const targetSelector = control.selector(paneId);
      commands.push({
        id: `shell-v2-${station.toLowerCase()}-${control.key}`,
        label: `${control.label} ${station}`,
        icon: '>',
        category: 'Station',
        targetSelector,
        action: () => activateCommandTarget(targetSelector),
      });
    }
  }
  return commands;
}

function getCommandPaletteCommands(options = {}) {
  return [
    // Agent Control
    { id: 'spawn-all', label: 'Spawn All Agents', icon: '🚀', category: 'Agents', action: () => document.getElementById('spawnAllBtn')?.click() },
    { id: 'open-scoped-window', label: 'Open Scoped Window', icon: '🪟', category: 'Windows', action: () => options.openAppWindow?.('scoped') },
    { id: 'open-mira-lab', label: 'Open Mira Lab', icon: '🪟', category: 'Windows', action: () => options.openAppWindow?.('mira-lab') },
    { id: 'open-live-task-audit-sidecar', label: 'Open Task Audit', icon: '🧭', category: 'Windows', action: () => options.openAppWindow?.('live-task-audit-sidecar') },
    { id: 'open-squid-room', label: 'Open Squid Room', icon: '▣', category: 'Windows', action: () => options.openAppWindow?.('squid-room') },
    // Navigation
    { id: 'focus-1', label: 'Focus Mira (Pane 1)', icon: '1️⃣', category: 'Navigate', shortcut: 'Alt+1', action: () => terminal.focusPane('1') },
    { id: 'focus-2', label: 'Focus Builder (Pane 2)', icon: '2️⃣', category: 'Navigate', shortcut: 'Alt+2', action: () => terminal.focusPane('2') },
    { id: 'focus-3', label: 'Focus Oracle (Pane 3)', icon: '3️⃣', category: 'Navigate', shortcut: 'Alt+3', action: () => terminal.focusPane('3') },
    ...getShellV2StationCommands(),

    // Panels
    { id: 'toggle-settings', label: 'Toggle Settings Panel', icon: '⚙️', category: 'Panels', action: () => document.getElementById('settingsBtn')?.click() },
    { id: 'toggle-panel', label: 'Toggle Right Panel', icon: '📊', category: 'Panels', action: () => document.getElementById('panelBtn')?.click() },
    { id: 'toggle-friction', label: 'View Friction Logs', icon: '🔧', category: 'Panels', action: () => {
      const rightPanel = document.getElementById('rightPanel');
      if (rightPanel && !rightPanel.classList.contains('visible')) {
        document.getElementById('panelBtn')?.click();
      }
      document.querySelector('.panel-tab[data-tab="friction"]')?.click();
    }},

    // Project
    { id: 'select-project', label: 'Select Project Folder', icon: '📁', category: 'Project', action: () => document.getElementById('selectProjectBtn')?.click() },

    // System
    { id: 'shutdown', label: 'Quit SquidRun', icon: '🔌', category: 'System', action: () => document.getElementById('fullRestartBtn')?.click() },
  ];
}

/**
 * Initializes the command palette UI component
 * Provides fuzzy search across all available commands
 */
function initCommandPalette(options = {}) {
  const overlay = document.getElementById('commandPaletteOverlay');
  const palette = document.getElementById('commandPalette');
  const input = document.getElementById('commandPaletteInput');
  const list = document.getElementById('commandPaletteList');

  if (!overlay || !palette || !input || !list) return;

  let selectedIndex = 0;
  let filteredCommands = [];

  // Define all available commands
  const commands = getCommandPaletteCommands(options);

  function openPalette() {
    overlay.classList.add('open');
    input.value = '';
    selectedIndex = 0;
    renderCommands('');
    input.focus();
  }

  function closePalette() {
    overlay.classList.remove('open');
    input.value = '';
  }

  function renderCommands(filter) {
    const filterLower = filter.toLowerCase();
    filteredCommands = commands.filter(cmd =>
      cmd.label.toLowerCase().includes(filterLower) ||
      cmd.category.toLowerCase().includes(filterLower) ||
      cmd.id.includes(filterLower)
    );

    if (filteredCommands.length === 0) {
      list.innerHTML = '<div class="command-palette-empty">No matching commands</div>';
      return;
    }

    // Clamp selected index
    if (selectedIndex >= filteredCommands.length) {
      selectedIndex = filteredCommands.length - 1;
    }

    list.innerHTML = filteredCommands.map((cmd, i) => `
      <div class="command-palette-item ${i === selectedIndex ? 'selected' : ''}" data-index="${i}">
        <span class="icon">${cmd.icon}</span>
        <span class="label">${cmd.label}</span>
        <span class="category">${cmd.category}</span>
        ${cmd.shortcut ? `<span class="shortcut-hint">${cmd.shortcut}</span>` : ''}
      </div>
    `).join('');

    // Add click handlers
    list.querySelectorAll('.command-palette-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.index);
        executeCommand(filteredCommands[idx]);
      });
      item.addEventListener('mouseenter', () => {
        selectedIndex = parseInt(item.dataset.index);
        updateSelection();
      });
    });
  }

  function updateSelection() {
    list.querySelectorAll('.command-palette-item').forEach((item, i) => {
      item.classList.toggle('selected', i === selectedIndex);
    });
    // Scroll selected into view
    const selected = list.querySelector('.command-palette-item.selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  function executeCommand(cmd) {
    closePalette();
    if (cmd && cmd.action) {
      log.info('CommandPalette', `Executing: ${cmd.label}`);
      cmd.action();
    }
  }

  // Input filtering
  input.addEventListener('input', () => {
    selectedIndex = 0;
    renderCommands(input.value);
  });

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (selectedIndex < filteredCommands.length - 1) {
        selectedIndex++;
        updateSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedIndex > 0) {
        selectedIndex--;
        updateSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        executeCommand(filteredCommands[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closePalette();
    }
  });

  // Global Ctrl+K handler
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay.classList.contains('open')) {
        closePalette();
      } else {
        openPalette();
      }
    }
  });

  log.info('UI', 'Command palette initialized (Ctrl+K)');
}

module.exports = {
  initCommandPalette,
  getCommandPaletteCommands,
  getShellV2StationCommands,
};
