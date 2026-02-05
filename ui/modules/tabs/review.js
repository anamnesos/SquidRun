/**
 * Code Review Tab Module
 * Task #18: AI-Powered Code Review
 */

const { ipcRenderer } = require('electron');
const { escapeHtml } = require('./utils');

const reviewState = {
  mode: 'all',
  issues: [],
  filteredIssues: [],
  selectedIssue: null,
  severityFilter: 'all',
  isLoading: false,
  aiAvailable: false,
};

async function runCodeReview() {
  const loading = document.getElementById('reviewLoading');
  reviewState.isLoading = true;
  if (loading) loading.classList.remove('hidden');

  try {
    const result = await ipcRenderer.invoke('review-diff', { mode: reviewState.mode });
    if (result.success) {
      reviewState.issues = result.issues || [];
      filterReviewIssues();
    }
  } catch (err) {
    console.error('Review', 'Error:', err);
  } finally {
    reviewState.isLoading = false;
    if (loading) loading.classList.add('hidden');
  }
}

function filterReviewIssues() {
  reviewState.filteredIssues = reviewState.severityFilter === 'all' 
    ? reviewState.issues 
    : reviewState.issues.filter(i => i.severity === reviewState.severityFilter);
  renderReviewIssues();
}

function renderReviewIssues() {
  const list = document.getElementById('reviewIssuesList');
  if (!list) return;
  list.innerHTML = reviewState.filteredIssues.map((issue, idx) => `
    <div class="review-issue ${issue.severity}" data-index="${idx}">
      <div class="review-issue-header">
        <span class="review-issue-severity ${issue.severity}">${issue.severity}</span>
        <span class="review-issue-file">${issue.file || 'unknown'}</span>
      </div>
      <div class="review-issue-message">${escapeHtml(issue.message)}</div>
    </div>
  `).join('');
}

function setupReviewTab() {
  const runBtn = document.getElementById('reviewRunBtn');
  if (runBtn) runBtn.addEventListener('click', runCodeReview);
  
  document.querySelectorAll('.review-sev-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      reviewState.severityFilter = btn.dataset.severity;
      filterReviewIssues();
    });
  });

  ipcRenderer.invoke('review-ai-status').then(result => {
    reviewState.aiAvailable = result.available;
  }).catch(() => {});
}

module.exports = {
  setupReviewTab,
  runCodeReview
};
