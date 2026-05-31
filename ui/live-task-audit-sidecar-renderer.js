(function () {
  'use strict';

  const SNAPSHOT_CHANNEL = 'live-task-audit-sidecar:snapshot';
  const REFRESH_MS = 5000;
  const REQUIRED_ROW_LABELS = [
    'Task Title',
    'Why It Matters',
    'Owner',
    'Status',
    'Last Updated',
    'Source',
    'Next Action',
  ];
  const HISTORY_ROW_LABELS = [
    'Task Title',
    'What Happened',
    'Owner',
    'Verdict',
    'Closed At',
    'Source',
    'Why',
  ];
  const TAB_CONFIG = {
    active: {
      title: 'Needs Doing',
      countId: 'activeCount',
      telemetryId: 'terminalActiveCount',
      labels: REQUIRED_ROW_LABELS,
      emptyTitle: 'Nothing needs doing',
      emptyDetail: 'No active work appears in the read-only snapshot.',
    },
    future: {
      title: 'Audit / Cleanup Later',
      countId: 'futureCount',
      telemetryId: 'terminalFutureCount',
      labels: REQUIRED_ROW_LABELS,
      emptyTitle: 'No audit or cleanup items parked',
      emptyDetail: 'Future audit and cleanup are empty in this snapshot.',
    },
    history: {
      title: 'History',
      countId: 'historyCount',
      telemetryId: 'terminalHistoryCount',
      labels: HISTORY_ROW_LABELS,
      emptyTitle: 'No closed work in history',
      emptyDetail: 'Closed work items will appear here with what happened and why.',
    },
  };
  const LAYOUTS = [
    {
      id: 'table',
      label: 'Table',
      note: 'Most compact scan.',
    },
    {
      id: 'timeline',
      label: 'Timeline',
      note: 'Updated-first stack.',
    },
  ];

  let selectedTab = 'active';
  let refreshTimer = null;
  let lastSnapshotOk = false;
  let currentSnapshot = null;

  function getBridgeApi() {
    return window.squidrunAPI || window.squidrun || {};
  }

  function bridgeInvoke(channel, payload) {
    const api = getBridgeApi();
    const invoke = typeof api.invoke === 'function'
      ? api.invoke.bind(api)
      : (api.ipc && typeof api.ipc.invoke === 'function' ? api.ipc.invoke.bind(api.ipc) : null);
    if (!invoke) return Promise.resolve({ ok: false, reason: 'bridge_unavailable' });
    return invoke(channel, payload);
  }

  function params() {
    return new URLSearchParams(window.location.search || '');
  }

  function getSnapshotUrl() {
    return params().get('snapshotUrl')
      || document.body?.dataset.snapshotUrl
      || '';
  }

  function getLayout() {
    const requested = String(params().get('layout') || document.body?.dataset.layout || 'table').toLowerCase();
    return LAYOUTS.some((layout) => layout.id === requested) ? requested : 'table';
  }

  async function fetchSnapshot(snapshotUrl) {
    const response = await fetch(snapshotUrl, { cache: 'no-store' });
    if (!response.ok) return { ok: false, reason: `snapshot_http_${response.status}` };
    return response.json();
  }

  function loadSnapshot() {
    const snapshotUrl = getSnapshotUrl();
    if (snapshotUrl) return fetchSnapshot(snapshotUrl);
    return bridgeInvoke(SNAPSHOT_CHANNEL, {});
  }

  function safeArray(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
  }

  function formatTime(value) {
    const parsed = Date.parse(value || '');
    if (!Number.isFinite(parsed)) return '-';
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(parsed));
  }

  function formatDateTime(value) {
    const parsed = Date.parse(value || '');
    if (!Number.isFinite(parsed)) return '-';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(parsed));
  }

  function compactPath(value) {
    const raw = String(value || '').replace(/\\/g, '/');
    if (!raw) return '-';
    const parts = raw.split('/').filter(Boolean);
    if (parts.length <= 3) return raw;
    return `.../${parts.slice(-3).join('/')}`;
  }

  function ownerText(item) {
    const roles = safeArray(item.ownerRoles);
    return roles.length ? roles.join(', ') : 'unassigned';
  }

  function sourceText(item) {
    const source = item.source && typeof item.source === 'object' ? item.source : {};
    return source.label || item.sourceRef || item.id || '-';
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function setTone(id, value, tone) {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = value;
    node.dataset.tone = tone || 'neutral';
  }

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  function statusTone(value, future = false) {
    const status = String(value || '').toLowerCase();
    if (status.includes('block') || status.includes('fail') || status.includes('needs_review')) return 'danger';
    if (status.includes('wait') || status.includes('queue') || status.includes('watch') || status.includes('defer')) return 'warn';
    if (status.includes('complete') || status.includes('closed') || status.includes('pass')) return 'good';
    return future ? 'future' : 'active';
  }

  function proofSummary(item = {}) {
    const proofState = item.proofState && typeof item.proofState === 'object' ? item.proofState : null;
    if (!proofState) return null;
    const required = safeArray(proofState.requiredRoles);
    const present = safeArray(proofState.presentRoles);
    const missing = safeArray(proofState.missingRoles);
    return {
      required,
      present,
      missing,
      text: required.length ? `${present.length}/${required.length}` : 'n/a',
    };
  }

  function whyItMatters(item = {}, partition = 'active') {
    const future = partition === 'future';
    if (partition === 'history') return item.whatHappened || item.closureReason || 'Closed work item.';
    if (item.rationale) return item.rationale;
    const proof = proofSummary(item);
    if (!future && proof?.missing?.length) {
      return `Required proof is still missing: ${proof.missing.join(', ')}.`;
    }
    const sourceKind = String(item.source?.kind || item.kind || '').replace(/_/g, ' ');
    if (future) return 'Parked for audit or cleanup so it does not mix with active work.';
    if (sourceKind) return `Current work from ${sourceKind}.`;
    return 'Current active task from the read-only SquidRun snapshot.';
  }

  function nextAction(item = {}, partition = 'active') {
    const future = partition === 'future';
    if (partition === 'history') return item.why || 'Closed work retained for source-of-truth history.';
    if (item.nextAction) return item.nextAction;
    const proof = proofSummary(item);
    const status = String(item.status || '').toLowerCase();
    if (future) return 'Review later only when Architect opens a current lane.';
    if (proof?.missing?.length) return `Attach or verify ${proof.missing.join(', ')}.`;
    if (status.includes('wait')) return 'Wait for the named verifier, then attach proof or close.';
    if (status.includes('block')) return 'Report the blocker with evidence or mark the work item blocked.';
    return 'Advance the owner status, attach proof, or close with a verdict.';
  }

  function activeItems(snapshot) {
    return Array.isArray(snapshot?.active?.items) ? snapshot.active.items : [];
  }

  function futureItems(snapshot) {
    return Array.isArray(snapshot?.future?.items) ? snapshot.future.items : [];
  }

  function historyItems(snapshot) {
    return Array.isArray(snapshot?.history?.items) ? snapshot.history.items : [];
  }

  function reconciliationCounts(snapshot = {}) {
    const reconciliation = snapshot.reconciliation && typeof snapshot.reconciliation === 'object'
      ? snapshot.reconciliation
      : {};
    const conflictMarkers = safeArray(reconciliation.conflictMarkers);
    const staleMarkers = safeArray(reconciliation.staleMarkers);
    return {
      status: reconciliation.status || 'OK',
      authority: reconciliation.authority || reconciliation.chosenAuthority || 'none',
      conflicts: conflictMarkers.length,
      stale: staleMarkers.length,
      warnings: safeArray(reconciliation.warnings).length,
    };
  }

  function itemSeverity(item = {}, future = false) {
    const status = String(item.status || '').toLowerCase();
    const kind = String(item.kind || '').toLowerCase();
    const missing = safeArray(item.proofState?.missingRoles);
    if (item.closedAt || item.source?.kind === 'work_item_history') {
      if (status.includes('fail') || status.includes('block')) return 'danger';
      if (status.includes('cancel')) return 'warn';
      return 'good';
    }
    if (status.includes('block') || status.includes('fail') || kind.includes('conflict')) return 'danger';
    if (status.includes('wait') || status.includes('queue') || status.includes('review') || kind.includes('stale') || missing.length > 0) return 'warn';
    return future ? 'future' : 'active';
  }

  function countBlockers(active, future) {
    return [...active, ...future].filter((item) => itemSeverity(item, Boolean(future.includes(item))) === 'danger'
      || safeArray(item.proofState?.missingRoles).length > 0).length;
  }

  function summary(snapshot) {
    const active = activeItems(snapshot);
    const future = futureItems(snapshot);
    const history = historyItems(snapshot);
    const reconciliation = reconciliationCounts(snapshot);
    return {
      active,
      future,
      history,
      blockers: countBlockers(active, future),
      signals: reconciliation.conflicts + reconciliation.stale,
      reconciliation,
    };
  }

  function renderMeta(snapshot) {
    const data = summary(snapshot);
    const sessionNumber = snapshot?.session?.number;
    const sessionId = snapshot?.session?.id;
    setText('taskAuditSession', sessionNumber ? `Session #${sessionNumber}` : (sessionId || 'Session -'));
    setText('taskAuditUpdated', `Updated ${formatTime(snapshot?.generatedAt)}`);
    setText('taskAuditSchema', snapshot?.schema || 'snapshot unavailable');
    setText('taskAuditSource', compactPath(snapshot?.sources?.taskAuditItemsPath || snapshot?.future?.sourcePath));
    setTone('taskAuditHealth', lastSnapshotOk ? 'Snapshot live' : 'Snapshot issue', lastSnapshotOk ? 'good' : 'danger');
    setTone('taskAuditAuthority', `Authority: ${data.reconciliation.authority}`, data.reconciliation.conflicts ? 'danger' : 'neutral');
    Object.entries(TAB_CONFIG).forEach(([key, config]) => {
      const count = data[key]?.length || 0;
      setText(config.countId, String(count));
      setText(config.telemetryId, String(count));
    });
    setText('terminalBlockerCount', String(data.blockers));
    setText('terminalSignalCount', String(data.signals));
  }

  function emptyState(title, detail) {
    const node = el('div', 'task-audit-empty');
    node.appendChild(el('strong', '', title));
    node.appendChild(el('span', '', detail));
    return node;
  }

  function layoutUrl(layoutId) {
    const next = params();
    next.set('layout', layoutId);
    const query = next.toString();
    return `${window.location.pathname}${query ? `?${query}` : ''}`;
  }

  function renderLayoutOptions(selectedLayout) {
    const nav = document.getElementById('taskAuditLayouts');
    if (!nav) return;
    nav.replaceChildren();
    LAYOUTS.forEach((layout) => {
      const link = el('a', layout.id === selectedLayout ? 'active' : '');
      link.href = layoutUrl(layout.id);
      link.dataset.layout = layout.id;
      link.appendChild(el('strong', '', layout.label));
      link.appendChild(el('span', '', layout.note));
      nav.appendChild(link);
    });
  }

  function rowLabels(partition = 'active') {
    return TAB_CONFIG[partition]?.labels || REQUIRED_ROW_LABELS;
  }

  function renderRow(item, partition = 'active') {
    const future = partition === 'future';
    const labels = rowLabels(partition);
    const row = el('tr');
    row.dataset.partition = partition;
    row.dataset.tone = itemSeverity(item, future);
    const activeValues = [
      item.title || '(no title)',
      whyItMatters(item, partition),
      ownerText(item),
      item.status || 'unknown',
      formatDateTime(item.updatedAt || item.timestamp),
      sourceText(item),
      nextAction(item, partition),
    ];
    const historyValues = [
      item.title || '(no title)',
      whyItMatters(item, partition),
      ownerText(item),
      item.verdict || item.status || 'closed',
      formatDateTime(item.closedAt || item.timestamp || item.updatedAt),
      sourceText(item),
      nextAction(item, partition),
    ];
    const values = partition === 'history' ? historyValues : activeValues;
    values.forEach((value, index) => {
      const cell = el('td', index === 0 ? 'task-title' : '', value);
      cell.dataset.label = labels[index];
      row.appendChild(cell);
    });
    return row;
  }

  function fieldValueMap(item, partition = 'active') {
    if (partition === 'history') {
      return {
        'Task Title': item.title || '(no title)',
        'What Happened': whyItMatters(item, partition),
        Owner: ownerText(item),
        Verdict: item.verdict || item.status || 'closed',
        'Closed At': formatDateTime(item.closedAt || item.timestamp || item.updatedAt),
        Source: sourceText(item),
        Why: nextAction(item, partition),
      };
    }
    return {
      'Task Title': item.title || '(no title)',
      'Why It Matters': whyItMatters(item, partition),
      Owner: ownerText(item),
      Status: item.status || 'unknown',
      'Last Updated': formatDateTime(item.updatedAt || item.timestamp),
      Source: sourceText(item),
      'Next Action': nextAction(item, partition),
    };
  }

  function renderFieldCard(item, partition = 'active', options = {}) {
    const future = partition === 'future';
    const row = el('article', `task-audit-field-row ${options.compact ? 'compact' : ''}`.trim());
    row.dataset.partition = partition;
    row.dataset.tone = itemSeverity(item, future);
    const values = fieldValueMap(item, partition);
    rowLabels(partition).forEach((label, index) => {
      const field = el('div', index === 0 ? 'primary' : '');
      field.dataset.label = label;
      field.appendChild(el('span', '', label));
      field.appendChild(el(index === 0 ? 'strong' : 'p', '', values[label]));
      row.appendChild(field);
    });
    return row;
  }

  function renderRows(items, partition = 'active', layout = 'table') {
    const future = partition === 'future';
    const config = TAB_CONFIG[partition] || TAB_CONFIG.active;
    const section = el('section', 'task-audit-table-wrap');
    section.dataset.partition = partition;
    section.dataset.layout = layout;
    section.appendChild(el('h2', '', config.title));
    if (!items.length) {
      section.appendChild(emptyState(
        config.emptyTitle,
        config.emptyDetail
      ));
      return section;
    }

    if (layout === 'timeline') {
      const timeline = el('div', 'task-audit-timeline-layout');
      items.forEach((item) => timeline.appendChild(renderFieldCard(item, partition)));
      section.appendChild(timeline);
      return section;
    }

    const table = el('table', 'task-audit-table');
    const head = el('thead');
    const headRow = el('tr');
    rowLabels(partition).forEach((label) => headRow.appendChild(el('th', '', label)));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el('tbody');
    items.forEach((item) => body.appendChild(renderRow(item, partition)));
    table.appendChild(body);
    section.appendChild(table);
    return section;
  }

  function updateTabs() {
    document.querySelectorAll('.task-audit-tab').forEach((button) => {
      const active = button.dataset.tab === selectedTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function renderStage(snapshot) {
    const stage = document.getElementById('taskAuditStage');
    if (!stage) return;
    const layout = getLayout();
    document.body.dataset.layout = layout;
    renderMeta(snapshot);
    renderLayoutOptions(layout);
    updateTabs();
    stage.replaceChildren();
    const data = summary(snapshot);
    const partition = TAB_CONFIG[selectedTab] ? selectedTab : 'active';
    stage.appendChild(renderRows(data[partition] || [], partition, layout));
  }

  function renderSnapshot(snapshot) {
    currentSnapshot = snapshot;
    renderStage(snapshot);
  }

  async function refresh() {
    const button = document.getElementById('taskAuditRefresh');
    if (button) button.disabled = true;
    try {
      const result = await loadSnapshot();
      if (result && result.ok === false) {
        lastSnapshotOk = false;
        renderSnapshot({
          generatedAt: new Date().toISOString(),
          session: {},
          active: { items: [] },
          future: {
            items: [{
              id: 'snapshot-error',
              title: result.reason || result.error || 'Snapshot unavailable',
              status: 'blocked',
              kind: 'sidecar_runtime',
              updatedAt: new Date().toISOString(),
              ownerRoles: ['builder'],
              source: { label: SNAPSHOT_CHANNEL },
              rationale: 'The Task Audit view could not load its read-only snapshot.',
            }],
          },
        });
        return;
      }
      lastSnapshotOk = true;
      renderSnapshot(result);
    } catch (error) {
      lastSnapshotOk = false;
      renderSnapshot({
        generatedAt: new Date().toISOString(),
        session: {},
        active: { items: [] },
        future: {
          items: [{
            id: 'snapshot-exception',
            title: error?.message || 'Snapshot refresh failed',
            status: 'blocked',
            kind: 'sidecar_runtime',
            updatedAt: new Date().toISOString(),
            ownerRoles: ['builder'],
            source: { label: SNAPSHOT_CHANNEL },
            rationale: 'The Task Audit view could not load its read-only snapshot.',
          }],
        },
      });
    } finally {
      if (button) button.disabled = false;
    }
  }

  function init() {
    document.documentElement.classList.toggle('task-audit-preview-mode', document.body?.dataset.surface === 'preview');
    document.querySelectorAll('.task-audit-tab').forEach((button) => {
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => {
        selectedTab = TAB_CONFIG[button.dataset.tab] ? button.dataset.tab : 'active';
        if (currentSnapshot) renderStage(currentSnapshot);
      });
    });
    document.getElementById('taskAuditRefresh')?.addEventListener('click', refresh);
    refresh();
    refreshTimer = setInterval(refresh, REFRESH_MS);
    if (refreshTimer && typeof refreshTimer.unref === 'function') refreshTimer.unref();
  }

  window.addEventListener('beforeunload', () => {
    if (refreshTimer) clearInterval(refreshTimer);
  });
  window.addEventListener('DOMContentLoaded', init);
}());
