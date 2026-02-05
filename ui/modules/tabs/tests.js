/**
 * Test Results and CI Status Tab Module
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { escapeHtml } = require('./utils');

let testResults = [];
let testSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
let testStatus = 'idle'; // idle, running, passed, failed

let ciStatus = 'idle'; // idle, running, passing, failing

function formatTestDuration(ms) {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function renderTestSummary() {
  const passedEl = document.getElementById('testPassedCount');
  const failedEl = document.getElementById('testFailedCount');
  const skippedEl = document.getElementById('testSkippedCount');

  if (passedEl) passedEl.textContent = testSummary.passed || 0;
  if (failedEl) failedEl.textContent = testSummary.failed || 0;
  if (skippedEl) skippedEl.textContent = testSummary.skipped || 0;

  // Update progress bar
  const total = testSummary.total || 0;
  if (total > 0) {
    const passedPct = (testSummary.passed / total) * 100;
    const failedPct = (testSummary.failed / total) * 100;
    const skippedPct = (testSummary.skipped / total) * 100;

    const passedBar = document.getElementById('testProgressPassed');
    const failedBar = document.getElementById('testProgressFailed');
    const skippedBar = document.getElementById('testProgressSkipped');

    if (passedBar) passedBar.style.width = `${passedPct}%`;
    if (failedBar) failedBar.style.width = `${failedPct}%`;
    if (skippedBar) skippedBar.style.width = `${skippedPct}%`;
  }

  // Update status badge
  const statusBadge = document.getElementById('testStatusBadge');
  if (statusBadge) {
    statusBadge.className = `test-status-badge ${testStatus}`;
    switch (testStatus) {
      case 'running':
        statusBadge.textContent = 'Running tests...';
        break;
      case 'passed':
        statusBadge.textContent = `All ${testSummary.passed} tests passed`;
        break;
      case 'failed':
        statusBadge.textContent = `${testSummary.failed} test(s) failed`;
        break;
      default:
        statusBadge.textContent = 'No tests run';
    }
  }
}

function renderTestResults() {
  const listEl = document.getElementById('testResultsList');
  if (!listEl) return;

  if (testResults.length === 0) {
    listEl.innerHTML = '<div class="test-empty">No test results yet. Run tests to see results here.</div>';
    return;
  }

  // Sort: failed first, then passed, then skipped
  const sorted = [...testResults].sort((a, b) => {
    const order = { failed: 0, passed: 1, skipped: 2 };
    return (order[a.status] || 3) - (order[b.status] || 3);
  });

  listEl.innerHTML = sorted.map((test, idx) => `
    <div class="test-result-item ${test.status}" data-idx="${idx}">
      <div class="test-result-header">
        <span class="test-result-name" title="${test.name}">${test.name}</span>
        <span class="test-result-status ${test.status}">${test.status.toUpperCase()}</span>
      </div>
      ${test.duration ? `<div class="test-result-duration">${formatTestDuration(test.duration)}</div>` : ''}
      ${test.error ? `<div class="test-result-error">${escapeHtml(test.error)}</div>` : ''}
    </div>
  `).join('');

  // Click to expand/collapse error details
  listEl.querySelectorAll('.test-result-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.querySelector('.test-result-error')) {
        item.classList.toggle('expanded');
      }
    });
  });
}

function updateTestStatus(status) {
  testStatus = status;
  renderTestSummary();
}

function addTestResult(result) {
  testResults.push(result);

  // Update summary
  if (result.status === 'passed') testSummary.passed++;
  else if (result.status === 'failed') testSummary.failed++;
  else if (result.status === 'skipped') testSummary.skipped++;
  testSummary.total++;

  renderTestSummary();
  renderTestResults();
}

function setTestResults(results, summary) {
  testResults = results || [];
  testSummary = summary || { passed: 0, failed: 0, skipped: 0, total: testResults.length };
  testStatus = testSummary.failed > 0 ? 'failed' : (testSummary.passed > 0 ? 'passed' : 'idle');

  renderTestSummary();
  renderTestResults();
}

function clearTestResults() {
  testResults = [];
  testSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
  testStatus = 'idle';
  renderTestSummary();
  renderTestResults();
}

async function runTests(updateStatusFn) {
  if (updateStatusFn) updateStatusFn('Running tests...');
  updateCIStatus('running'); 
  testStatus = 'running';
  testResults = [];
  testSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
  renderTestSummary();
  renderTestResults();

  try {
    const result = await ipcRenderer.invoke('run-tests');
    if (result && result.success) {
      const results = Array.isArray(result.results) ? result.results : [];
      const summary = result.summary || { passed: 0, failed: 0, skipped: 0, total: results.length };
      setTestResults(results, summary);
      const allPassed = summary.failed === 0;
      updateCIStatus(allPassed ? 'passing' : 'failing', 
        allPassed ? null : `${summary.failed} tests failed`);
      if (updateStatusFn) updateStatusFn(`Tests complete: ${summary.passed} passed, ${summary.failed} failed`);
    } else {
      testStatus = 'idle';
      updateCIStatus('failing', result?.error || 'Test run failed');
      renderTestSummary();
      if (updateStatusFn) updateStatusFn(`Test run failed: ${result?.error || 'Unknown error'}`);
    }
  } catch (err) {
    testStatus = 'idle';
    updateCIStatus('failing', err.message);
    renderTestSummary();
    if (updateStatusFn) updateStatusFn(`Test error: ${err.message}`);
  }
}

async function loadTestResults() {
  try {
    const result = await ipcRenderer.invoke('get-test-results');
    if (result && result.success) {
      const results = Array.isArray(result.results) ? result.results : [];
      const summary = result.summary || { passed: 0, failed: 0, skipped: 0, total: results.length };
      setTestResults(results, summary);
    }
  } catch (err) {
    log.error('Tests', 'Error loading test results', err);
  }
}

function updateCIStatus(status, details = null) {
  ciStatus = status;

  const indicator = document.getElementById('ciStatusIndicator');
  const icon = document.getElementById('ciStatusIcon');
  const text = document.getElementById('ciStatusText');

  if (!indicator) return;

  indicator.className = 'ci-status-indicator';

  switch (status) {
    case 'passing':
      indicator.classList.add('passing');
      indicator.style.display = 'flex';
      if (icon) {
        icon.textContent = '✓';
        icon.classList.remove('spinning');
      }
      if (text) text.textContent = 'CI Passing';
      break;

    case 'failing':
      indicator.classList.add('failing');
      indicator.style.display = 'flex';
      if (icon) {
        icon.textContent = '✗';
        icon.classList.remove('spinning');
      }
      if (text) text.textContent = details || 'CI Failing';
      break;

    case 'running':
      indicator.classList.add('running');
      indicator.style.display = 'flex';
      if (icon) {
        icon.textContent = '↻';
        icon.classList.add('spinning');
      }
      if (text) text.textContent = 'CI Running...';
      break;

    case 'idle':
    default:
      indicator.classList.add('idle');
      indicator.style.display = 'none';
      if (icon) {
        icon.textContent = '-';
        icon.classList.remove('spinning');
      }
      if (text) text.textContent = 'CI Idle';
      break;
  }
}

function setupTestsTab(updateStatusFn) {
  const runBtn = document.getElementById('runTestsBtn');
  if (runBtn) runBtn.addEventListener('click', () => runTests(updateStatusFn));

  const refreshBtn = document.getElementById('refreshTestsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadTestResults);

  const clearBtn = document.getElementById('clearTestsBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearTestResults);

  ipcRenderer.on('test-started', () => {
    testStatus = 'running';
    testResults = [];
    testSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
    renderTestSummary();
    renderTestResults();
  });

  ipcRenderer.on('test-result', (event, result) => {
    addTestResult(result);
  });

  ipcRenderer.on('test-complete', (event, data) => {
    if (!data) return;
    const results = Array.isArray(data.results) ? data.results : [];
    const summary = data.summary || { passed: 0, failed: 0, skipped: 0, total: results.length };
    setTestResults(results, summary);
    if (updateStatusFn) updateStatusFn(`Tests complete: ${summary.passed} passed, ${summary.failed} failed`);
  });

  loadTestResults();
}

function setupCIStatusIndicator() {
  ipcRenderer.on('ci-status-changed', (event, data) => {
    updateCIStatus(data.status, data.details);
  });

  ipcRenderer.on('ci-validation-started', () => {
    updateCIStatus('running');
  });

  ipcRenderer.on('ci-validation-passed', () => {
    updateCIStatus('passing');
    setTimeout(() => {
      if (ciStatus === 'passing') {
        updateCIStatus('idle');
      }
    }, 10000);
  });

  ipcRenderer.on('ci-validation-failed', (event, data) => {
    updateCIStatus('failing', data?.message || 'Validation failed');
  });

  ipcRenderer.on('ci-check-complete', (event, data) => {
    if (data && data.passed !== undefined) {
      if (data.passed) {
        updateCIStatus('passing');
        setTimeout(() => {
          if (ciStatus === 'passing') {
            updateCIStatus('idle');
          }
        }, 10000);
      } else {
        const failedChecks = data.checks?.filter(c => !c.passed).map(c => c.name).join(', ');
        updateCIStatus('failing', failedChecks ? `Failed: ${failedChecks}` : 'CI checks failed');
      }
    }
  });

  ipcRenderer.invoke('get-ci-status').then(result => {
    if (result && result.status) {
      updateCIStatus(result.status, result.details);
    }
  }).catch(() => {});
}

module.exports = {
  setupTestsTab,
  setupCIStatusIndicator,
  updateCIStatus,
  runTests
};
