/**
 * Friction Logs Module
 */

const log = require('../logger');

let frictionFiles = [];

function updateFrictionBadge(count) {
  const tabBadge = document.getElementById('frictionTabBadge');
  if (tabBadge) {
    tabBadge.textContent = count;
    tabBadge.classList.toggle('hidden', count === 0);
  }
}

function formatFrictionTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function renderFrictionList() {
  const listEls = [
    document.getElementById('frictionList'),
    document.getElementById('frictionListTab')
  ].filter(Boolean);

  if (listEls.length === 0) return;

  if (frictionFiles.length === 0) {
    listEls.forEach(el => {
      el.innerHTML = '<div class="friction-empty">No friction logs found</div>';
    });
    updateFrictionBadge(0);
    return;
  }

  updateFrictionBadge(frictionFiles.length);

  const html = frictionFiles.map(f => `
    <div class="friction-item" data-filename="${f.name}">
      <span class="friction-item-name">${f.name}</span>
      <span class="friction-item-time">${formatFrictionTime(f.modified)}</span>
    </div>
  `).join('');

  listEls.forEach(el => {
    el.innerHTML = html;
    el.querySelectorAll('.friction-item').forEach(item => {
      item.addEventListener('click', () => viewFrictionFile(item.dataset.filename));
    });
  });
}

async function loadFrictionFiles() {
  try {
    const result = await window.hivemind.friction.list();
    if (result.success) {
      frictionFiles = result.files;
      renderFrictionList();
    }
  } catch (err) {
    log.error('Friction', 'Error loading friction files', err);
  }
}

async function viewFrictionFile(filename) {
  try {
    const result = await window.hivemind.friction.read(filename);
    if (result.success) {
      alert(`=== ${filename} ===

${result.content}`);
    }
  } catch (err) {
    log.error('Friction', 'Error reading friction file', err);
  }
}

async function clearFriction() {
  if (!confirm('Clear all friction logs?')) return;
  try {
    const result = await window.hivemind.friction.clear();
    if (result.success) {
      frictionFiles = [];
      renderFrictionList();
    }
  } catch (err) {
    log.error('Friction', 'Error clearing friction', err);
  }
}

function setupFrictionPanel() {
  const refreshBtn = document.getElementById('refreshFrictionTabBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadFrictionFiles);

  const clearBtn = document.getElementById('clearFrictionTabBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearFriction);

  document.querySelector('.panel-tab[data-tab="friction"]')?.addEventListener('click', () => {
    loadFrictionFiles();
  });

  loadFrictionFiles();
}

module.exports = {
  setupFrictionPanel,
  loadFrictionFiles
};
