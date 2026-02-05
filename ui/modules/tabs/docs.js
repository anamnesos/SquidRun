/**
 * Documentation Tab Module
 * Task #23 - Auto-Documentation
 */

const { ipcRenderer } = require('electron');
const { escapeHtml } = require('./utils');

const docsState = {
  mode: 'file',
  format: 'markdown',
  targetPath: '',
  isLoading: false,
  lastGenerated: null,
  coverage: null,
  undocumented: [],
  preview: '',
  config: null,
};

function updateDocsTargetPlaceholder() {
  const targetInput = document.getElementById('docsTargetInput');
  if (!targetInput) return;

  const placeholders = {
    file: 'Enter file path...',
    directory: 'Enter directory path...',
    project: 'Leave empty for entire project',
  };

  targetInput.placeholder = placeholders[docsState.mode] || 'Enter path...';
}

async function loadDocsConfig() {
  try {
    const result = await ipcRenderer.invoke('docs-get-config');
    if (result?.success) {
      docsState.config = result.config;
    }
  } catch (err) {
    console.error('[DocsTab] Load config error:', err);
  }
}

async function generateDocumentation(updateStatusFn) {
  const loading = document.getElementById('docsLoading');
  const previewContent = document.getElementById('docsPreviewContent');

  docsState.isLoading = true;
  if (loading) loading.classList.remove('hidden');

  try {
    let result;
    const payload = { format: docsState.format };

    if (docsState.mode === 'file') {
      if (!docsState.targetPath) throw new Error('Please select a file');
      payload.filePath = docsState.targetPath;
      result = await ipcRenderer.invoke('docs-generate-file', payload);
    } else if (docsState.mode === 'directory') {
      payload.dirPath = docsState.targetPath || undefined;
      result = await ipcRenderer.invoke('docs-generate-directory', payload);
    } else {
      result = await ipcRenderer.invoke('docs-generate-project', payload);
    }

    if (!result.success) throw new Error(result.error || 'Generation failed');

    docsState.preview = result.documentation || '';
    if (previewContent) {
      previewContent.textContent = docsState.preview || 'No documentation generated';
    }
    if (updateStatusFn) updateStatusFn('Documentation generated');
  } catch (err) {
    if (updateStatusFn) updateStatusFn(err.message);
  } finally {
    docsState.isLoading = false;
    if (loading) loading.classList.add('hidden');
  }
}

function setupDocsTab(updateStatusFn) {
  const modeBtns = document.querySelectorAll('.docs-mode-btn');
  const generateBtn = document.getElementById('docsGenerateBtn');

  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      docsState.mode = btn.dataset.mode;
      updateDocsTargetPlaceholder();
    });
  });

  if (generateBtn) {
    generateBtn.addEventListener('click', () => generateDocumentation(updateStatusFn));
  }

  loadDocsConfig();
}

module.exports = {
  setupDocsTab,
  generateDocumentation
};
