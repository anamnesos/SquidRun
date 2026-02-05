/**
 * Template Management Tab Module
 * TM2: TEMPLATE MANAGEMENT
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');

let templates = [];

function formatTemplateDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderTemplateList() {
  const listEl = document.getElementById('templateList');
  if (!listEl) return;

  if (templates.length === 0) {
    listEl.innerHTML = '<div class="template-empty">No saved templates</div>';
    return;
  }

  listEl.innerHTML = templates.map(tmpl => `
    <div class="template-item" data-id="${tmpl.id}">
      <div class="template-item-info">
        <div class="template-item-name">${tmpl.name}</div>
        <div class="template-item-date">${formatTemplateDate(tmpl.createdAt)}</div>
      </div>
      <div class="template-item-actions">
        <button class="template-item-btn load-btn" data-id="${tmpl.id}">Load</button>
        <button class="template-item-btn delete" data-id="${tmpl.id}">X</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.load-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const result = await ipcRenderer.invoke('load-template', btn.dataset.id);
        if (result && result.success) log.info('Templates', `Loaded ${result.name}`);
      } catch (err) { log.error('Templates', 'Load failed', err); }
    });
  });

  listEl.querySelectorAll('.delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await ipcRenderer.invoke('delete-template', btn.dataset.id);
        templates = templates.filter(t => t.id !== btn.dataset.id);
        renderTemplateList();
      } catch (err) { log.error('Templates', 'Delete failed', err); }
    });
  });
}

async function loadTemplates() {
  try {
    const result = await ipcRenderer.invoke('get-templates');
    if (result && result.success) {
      templates = result.templates || [];
      renderTemplateList();
    }
  } catch (err) { log.error('Templates', 'Error loading templates', err); }
}

function setupTemplatesTab() {
  const refreshBtn = document.getElementById('refreshTemplatesBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadTemplates);
  loadTemplates();
}

module.exports = {
  setupTemplatesTab,
  loadTemplates
};
