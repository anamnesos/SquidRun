/**
 * Git Integration Tab Module
 * Task #6: Git Integration
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');

let gitStatus = null;

function renderGitFileList(listEl, files, className, emptyLabel) {
  if (!listEl) return;
  if (!files || files.length === 0) {
    listEl.innerHTML = `<div class="git-empty">${emptyLabel || 'No files'}</div>`;
    return;
  }
  listEl.innerHTML = files.map(file => `<div class="git-file-item ${className || ''}" title="${file}">${file}</div>`).join('');
}

function renderGitStatus() {
  const messageEl = document.getElementById('gitStatusMessage');
  const summaryEl = document.getElementById('gitSummary');
  if (!gitStatus) {
    if (messageEl) messageEl.textContent = 'Git status unavailable';
    if (summaryEl) summaryEl.style.display = 'none';
    return;
  }
  if (messageEl) messageEl.textContent = '';
  if (summaryEl) summaryEl.style.display = '';

  document.getElementById('gitBranchValue').textContent = gitStatus.branch || 'Detached';
  document.getElementById('gitUpstreamValue').textContent = gitStatus.upstream || 'None';
  document.getElementById('gitAheadBehindValue').textContent = `${gitStatus.ahead || 0} / ${gitStatus.behind || 0}`;

  renderGitFileList(document.getElementById('gitStagedList'), gitStatus.staged, '', 'No staged files');
  renderGitFileList(document.getElementById('gitUnstagedList'), gitStatus.unstaged, 'unstaged', 'No unstaged files');
}

async function loadGitStatus() {
  try {
    const projectPath = await ipcRenderer.invoke('get-project');
    const result = await ipcRenderer.invoke('git-status', projectPath);
    if (result?.success) {
      gitStatus = result.status;
      renderGitStatus();
    }
  } catch (err) { log.error('Git', 'Status failed', err); }
}

let domCleanupFns = [];

function setupGitTab() {
  destroyGitTab();

  const refreshBtn = document.getElementById('gitRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadGitStatus);
    domCleanupFns.push(() => refreshBtn.removeEventListener('click', loadGitStatus));
  }
  loadGitStatus();
}

function destroyGitTab() {
  for (const fn of domCleanupFns) {
    try { fn(); } catch (_) {}
  }
  domCleanupFns = [];
}

module.exports = {
  setupGitTab,
  destroyGitTab,
  loadGitStatus
};
