/**
 * Oracle Image Generation Module
 * AI-powered image generation (Recraft V3 / OpenAI gpt-image-1)
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { escapeHtml } = require('./utils');

let oracleHistory = [];
let lastImagePath = null;

function renderOracleHistory() {
  const historyList = document.getElementById('oracleHistoryList');
  if (!historyList) return;
  if (oracleHistory.length === 0) {
    historyList.innerHTML = '<div class="oracle-history-empty">No history yet</div>';
    return;
  }
  historyList.innerHTML = oracleHistory.slice(0, 10).map(h => `
    <div class="oracle-history-item">
      <span class="oracle-history-time">${h.time}</span>
      <span class="oracle-history-provider">${escapeHtml(h.provider || '')}</span>
      <span class="oracle-history-prompt">${escapeHtml(h.prompt)}</span>
    </div>
  `).join('');
}

async function saveOracleHistory() {
  try {
    await ipcRenderer.invoke('save-oracle-history', oracleHistory.slice(0, 50));
  } catch (err) {
    log.error('Oracle', 'Failed to save history:', err);
  }
}

function setupOracleTab(updateStatusFn) {
  const generateBtn = document.getElementById('oracleGenerateBtn');
  const promptInput = document.getElementById('oraclePromptInput');
  const styleSelect = document.getElementById('oracleStyleSelect');
  const sizeSelect = document.getElementById('oracleSizeSelect');
  const previewImg = document.getElementById('oraclePreviewImg');
  const providerBadge = document.getElementById('oracleProviderBadge');
  const resultsEl = document.getElementById('oracleResults');
  const resultActions = document.getElementById('oracleResultActions');
  const downloadBtn = document.getElementById('oracleDownloadBtn');
  const copyBtn = document.getElementById('oracleCopyBtn');

  if (generateBtn) {
    generateBtn.addEventListener('click', async () => {
      const prompt = promptInput?.value.trim();
      if (!prompt) {
        if (resultsEl) resultsEl.innerHTML = '<div class="oracle-error">Please enter a prompt</div>';
        return;
      }

      generateBtn.disabled = true;
      const originalText = generateBtn.innerHTML;
      generateBtn.textContent = 'Generating...';
      if (resultsEl) resultsEl.innerHTML = '<div class="oracle-loading">Generating image...</div>';
      if (previewImg) previewImg.style.display = 'none';
      if (providerBadge) providerBadge.style.display = 'none';
      if (resultActions) resultActions.style.display = 'none';

      try {
        const result = await ipcRenderer.invoke('oracle:generateImage', {
          prompt,
          style: styleSelect?.value || 'realistic_image',
          size: sizeSelect?.value || '1024x1024',
        });

        if (result.success) {
          lastImagePath = result.imagePath;
          if (previewImg) {
            previewImg.src = `file://${result.imagePath}`;
            previewImg.style.display = 'block';
          }
          if (providerBadge) {
            providerBadge.textContent = result.provider;
            providerBadge.style.display = 'inline-block';
          }
          if (resultsEl) resultsEl.innerHTML = '';
          if (resultActions) resultActions.style.display = 'flex';
          if (updateStatusFn) updateStatusFn(`Image generated via ${result.provider}`);

          oracleHistory.unshift({
            time: new Date().toLocaleTimeString(),
            prompt,
            provider: result.provider,
            imagePath: result.imagePath,
          });
          renderOracleHistory();
          saveOracleHistory();
        } else {
          if (resultsEl) resultsEl.innerHTML = `<div class="oracle-error">${escapeHtml(result.error)}</div>`;
        }
      } catch (err) {
        log.error('Oracle', 'Generation failed:', err);
        if (resultsEl) resultsEl.innerHTML = `<div class="oracle-error">Generation failed: ${escapeHtml(err.message)}</div>`;
      }

      generateBtn.disabled = false;
      generateBtn.innerHTML = originalText;
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      if (!lastImagePath) return;
      const a = document.createElement('a');
      a.href = `file://${lastImagePath}`;
      a.download = lastImagePath.split(/[\\/]/).pop();
      a.click();
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!lastImagePath || !previewImg?.src) return;
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = previewImg.naturalWidth;
        canvas.height = previewImg.naturalHeight;
        ctx.drawImage(previewImg, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (blob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          if (updateStatusFn) updateStatusFn('Image copied to clipboard');
        }
      } catch (err) {
        log.error('Oracle', 'Copy to clipboard failed:', err);
      }
    });
  }

  // Listen for agent-triggered image generation results pushed from main process
  ipcRenderer.on('oracle:image-generated', (event, data) => {
    if (!data || !data.imagePath) return;

    lastImagePath = data.imagePath;
    if (previewImg) {
      previewImg.src = `file://${data.imagePath}?t=${Date.now()}`;
      previewImg.style.display = 'block';
    }
    if (providerBadge) {
      providerBadge.textContent = data.provider || '';
      providerBadge.style.display = 'inline-block';
    }
    if (resultsEl) resultsEl.innerHTML = '';
    if (resultActions) resultActions.style.display = 'flex';
    if (updateStatusFn) updateStatusFn(`Image generated via ${data.provider} (agent)`);

    oracleHistory.unshift({
      time: data.time || new Date().toLocaleTimeString(),
      prompt: data.prompt || '(agent-generated)',
      provider: data.provider || '',
      imagePath: data.imagePath,
    });
    renderOracleHistory();
    saveOracleHistory();
  });

  ipcRenderer.invoke('load-oracle-history').then(history => {
    if (Array.isArray(history)) {
      oracleHistory = history;
      renderOracleHistory();
    }
  }).catch(() => {});
}

module.exports = {
  setupOracleTab
};
