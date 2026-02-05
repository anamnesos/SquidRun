/**
 * Oracle Visual QA Module
 * Gemini-powered screenshot analysis
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { escapeHtml } = require('./utils');

let oracleHistory = [];
let currentScreenshot = null;
let lastOracleResult = null;

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
  const captureBtn = document.getElementById('oracleCaptureBtn');
  const analyzeBtn = document.getElementById('oracleAnalyzeBtn');
  const promptInput = document.getElementById('oraclePromptInput');
  const previewImg = document.getElementById('oraclePreviewImg');
  const resultsEl = document.getElementById('oracleResults');
  const resultActions = document.getElementById('oracleResultActions');
  const copyBtn = document.getElementById('oracleCopyBtn');

  if (captureBtn) {
    captureBtn.addEventListener('click', async () => {
      captureBtn.disabled = true;
      const originalText = captureBtn.innerHTML;
      captureBtn.innerHTML = 'Capturing...';
      try {
        const result = await ipcRenderer.invoke('capture-screenshot');
        if (result.success) {
          currentScreenshot = result.path;
          previewImg.src = `file://${result.path}`;
          previewImg.style.display = 'block';
          if (updateStatusFn) updateStatusFn('Screenshot captured');
        }
      } catch (err) {
        log.error('Oracle', 'Capture failed:', err);
      }
      captureBtn.disabled = false;
      captureBtn.innerHTML = originalText;
    });
  }

  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', async () => {
      if (!currentScreenshot) return;
      const prompt = promptInput?.value.trim() || 'Analyze this UI screenshot for issues';
      analyzeBtn.disabled = true;
      resultsEl.innerHTML = '<div class="oracle-loading">Asking Gemini...</div>';
      try {
        const result = await ipcRenderer.invoke('oracle:analyzeScreenshot', {
          imagePath: currentScreenshot,
          prompt: prompt
        });
        if (result.success) {
          lastOracleResult = result.analysis;
          resultsEl.innerHTML = `
            <div class="oracle-result">
              <div class="oracle-result-prompt">${escapeHtml(prompt)}</div>
              <div class="oracle-result-analysis">${escapeHtml(result.analysis)}</div>
            </div>
          `;
          if (resultActions) resultActions.style.display = 'flex';
          oracleHistory.unshift({ time: new Date().toLocaleTimeString(), prompt, analysis: result.analysis });
          renderOracleHistory();
          saveOracleHistory();
        }
      } catch (err) {
        log.error('Oracle', 'Analysis failed:', err);
      }
      analyzeBtn.disabled = false;
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (lastOracleResult) {
        navigator.clipboard.writeText(lastOracleResult);
      }
    });
  }

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
