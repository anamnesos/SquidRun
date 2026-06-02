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
      note: 'Rows',
    },
    {
      id: 'timeline',
      label: 'Timeline',
      note: 'Cards',
    },
  ];

  let selectedTab = 'active';
  let refreshTimer = null;
  let lastSnapshotOk = false;
  let currentSnapshot = null;
  const SECTION_ORDER = ['Mira', 'TrustQuote', 'SquidRun', 'Other'];
  const STATUS_LABELS = {
    active: 'Active',
    ask_james: 'Ask James',
    ask_james_protected: 'Protected - ask James',
    ask_verify: 'Needs verification',
    blocked: 'Blocked',
    canceled: 'Canceled',
    cleanup_action: 'Cleanup',
    closed: 'Closed',
    deferred: 'Deferred',
    failed: 'Failed',
    future: 'Parked',
    keep_dormant: 'Keep dormant',
    needs_review: 'Needs review',
    open: 'Open',
    passed: 'Passed',
    queued: 'Queued',
    ready_to_delete_after_proof_check: 'Ready after proof check',
    resolved: 'Resolved',
    watch: 'Watch',
    waiting_codex_visual: 'Waiting for Codex proof',
  };
  const SOURCE_LABELS = {
    active_work_reconciliation: 'Work reconciliation',
    agent_task_queue: 'Agent task queue',
    current_lane: 'Current lane',
    oracle_v2_cleanup: 'Oracle cleanup review',
    protected_file_policy: 'Protected file policy',
    settings_disabled_flag: 'Disabled setting',
    task_audit_history: 'Task Audit history',
    task_audit_item_store: 'Task Audit item store',
    task_audit_items: 'Task Audit item store',
    task_audit_manual_item: 'Manual audit item',
    work_item: 'Work item',
    work_item_history: 'Work item history',
  };
  const OWNER_LABELS = {
    architect: 'Architect',
    builder: 'Builder',
    codex: 'Codex',
    oracle: 'Oracle',
    trustquote_builder: 'TrustQuote Builder',
    trustquote_oracle: 'TrustQuote Oracle',
    unassigned: 'Unassigned',
  };

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
    const values = roles.length ? roles : ['unassigned'];
    return values.map(displayOwnerRole).join(', ');
  }

  function ownerTone(role) {
    const normalized = String(role || '').toLowerCase();
    if (normalized.includes('codex')) return 'codex';
    if (normalized.includes('builder')) return 'builder';
    if (normalized.includes('oracle')) return 'oracle';
    if (normalized.includes('architect')) return 'architect';
    return 'neutral';
  }

  function ownerTokens(item) {
    const roles = safeArray(item.ownerRoles);
    const values = roles.length ? roles : ['unassigned'];
    return values.map((role) => el('span', `task-audit-owner-token ${ownerTone(role)}`, displayOwnerRole(role)));
  }

  function appendOwnerTokens(parent, item) {
    const wrap = el('div', 'task-audit-owner-cell');
    ownerTokens(item).forEach((token) => wrap.appendChild(token));
    parent.appendChild(wrap);
  }

  function sourceText(item) {
    const source = item.source && typeof item.source === 'object' ? item.source : {};
    return displaySource(source.label || source.kind || item.sourceRef || item.id || '-');
  }

  function humanizeToken(value) {
    const text = String(value || '').trim();
    if (!text) return '-';
    return text
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function displayStatus(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'Unknown';
    const key = raw.toLowerCase();
    return STATUS_LABELS[key] || humanizeToken(raw);
  }

  function displaySource(value) {
    const raw = String(value || '').trim();
    if (!raw) return '-';
    const key = raw.toLowerCase();
    if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
    if (/^architect#\d+$/i.test(raw)) return raw.replace(/^architect/i, 'Architect ');
    if (/^builder#\d+$/i.test(raw)) return raw.replace(/^builder/i, 'Builder ');
    if (/^oracle#\d+$/i.test(raw)) return raw.replace(/^oracle/i, 'Oracle ');
    if (/telegram-in-/i.test(raw)) return 'Telegram request';
    if (/codex/i.test(raw)) return 'Codex proof';
    if (raw.includes('/') || raw.includes('\\')) return compactPath(raw);
    return humanizeToken(raw);
  }

  function displayOwnerRole(value) {
    const raw = String(value || '').trim();
    if (!raw) return OWNER_LABELS.unassigned;
    const key = raw.toLowerCase();
    return OWNER_LABELS[key] || humanizeToken(raw);
  }

  function sectionForItem(item = {}) {
    const explicit = String(item.section || '').trim();
    if (SECTION_ORDER.includes(explicit)) return explicit;
    const projectName = String(item.project?.name || '').toLowerCase();
    const profile = String(item.profile || '').toLowerCase();
    const source = `${item.sourceRef || ''} ${item.source?.label || ''} ${item.source?.kind || ''}`.toLowerCase();
    const title = String(item.title || '').toLowerCase();
    const haystack = `${projectName} ${profile} ${source} ${title} ${item.kind || ''}`.toLowerCase();
    if (haystack.includes('trustquote')) return 'TrustQuote';
    if (/\bmira\b|presence|north-star|voice/.test(haystack)) return 'Mira';
    if (/squidrun|task-audit|codex|memory|evidence|mission|restart|hm-send|telegram|supervisor|scheduler|bridge|gemini|firmware|localmodel|future-items/.test(haystack)) return 'SquidRun';
    return 'Other';
  }

  function groupItemsBySection(items = []) {
    const groups = new Map(SECTION_ORDER.map((section) => [section, []]));
    items.forEach((item) => {
      const section = sectionForItem(item);
      if (!groups.has(section)) groups.set('Other', groups.get('Other') || []);
      groups.get(groups.has(section) ? section : 'Other').push(item);
    });
    return SECTION_ORDER
      .map((section) => ({ section, items: groups.get(section) || [] }));
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function setCount(id, value) {
    const node = document.getElementById(id);
    if (!node) return;
    const count = Number(value) || 0;
    node.textContent = String(count);
    node.dataset.hasItems = count > 0 ? 'true' : 'false';
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
    if (status.includes('complete') || status.includes('closed') || status.includes('pass') || status.includes('resolved')) return 'good';
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
    setText('taskAuditSession', sessionNumber ? `Session ${sessionNumber}` : (sessionId || 'Session -'));
    setText('taskAuditUpdated', `Updated ${formatTime(snapshot?.generatedAt)}`);
    setTone('taskAuditHealth', lastSnapshotOk ? 'Live' : 'Needs check', lastSnapshotOk ? 'good' : 'danger');
    Object.entries(TAB_CONFIG).forEach(([key, config]) => {
      const count = data[key]?.length || 0;
      setCount(config.countId, count);
      setCount(config.telemetryId, count);
    });
    setCount('terminalBlockerCount', data.blockers);
    setCount('terminalSignalCount', data.signals);
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
    nav.hidden = true;
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
      displayStatus(item.status || 'unknown'),
      formatDateTime(item.updatedAt || item.timestamp),
      sourceText(item),
      nextAction(item, partition),
    ];
    const historyValues = [
      item.title || '(no title)',
      whyItMatters(item, partition),
      ownerText(item),
      displayStatus(item.verdict || item.status || 'closed'),
      formatDateTime(item.closedAt || item.timestamp || item.updatedAt),
      sourceText(item),
      nextAction(item, partition),
    ];
    const values = partition === 'history' ? historyValues : activeValues;
    values.forEach((value, index) => {
      const label = labels[index];
      const cell = el('td', index === 0 ? 'task-title' : '', label === 'Owner' ? undefined : value);
      cell.dataset.label = labels[index];
      if (label === 'Owner') appendOwnerTokens(cell, item);
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
        Verdict: displayStatus(item.verdict || item.status || 'closed'),
        'Closed At': formatDateTime(item.closedAt || item.timestamp || item.updatedAt),
        Source: sourceText(item),
        Why: nextAction(item, partition),
      };
    }
    return {
      'Task Title': item.title || '(no title)',
      'Why It Matters': whyItMatters(item, partition),
      Owner: ownerText(item),
      Status: displayStatus(item.status || 'unknown'),
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
      if (label === 'Owner') {
        appendOwnerTokens(field, item);
      } else {
        field.appendChild(el(index === 0 ? 'strong' : 'p', '', values[label]));
      }
      row.appendChild(field);
    });
    return row;
  }

  function renderTable(items, partition = 'active') {
    const table = el('table', 'task-audit-table');
    const head = el('thead');
    const headRow = el('tr');
    rowLabels(partition).forEach((label) => headRow.appendChild(el('th', '', label)));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el('tbody');
    items.forEach((item) => body.appendChild(renderRow(item, partition)));
    table.appendChild(body);
    return table;
  }

  function renderSectionGroup(group, partition = 'active', layout = 'table') {
    const groupNode = el('section', 'task-audit-section-group');
    groupNode.dataset.section = group.section;
    const heading = el('h3', '', `${group.section} (${group.items.length})`);
    groupNode.appendChild(heading);
    if (layout === 'timeline') {
      const timeline = el('div', 'task-audit-timeline-layout');
      if (group.items.length > 0) {
        group.items.forEach((item) => timeline.appendChild(renderFieldCard(item, partition)));
      } else {
        timeline.appendChild(emptyState('No items', 'Nothing parked here.'));
      }
      groupNode.appendChild(timeline);
      return groupNode;
    }
    if (group.items.length > 0) {
      groupNode.appendChild(renderTable(group.items, partition));
    } else {
      groupNode.appendChild(emptyState('No items', 'Nothing parked here.'));
    }
    return groupNode;
  }

  function renderRows(items, partition = 'active', layout = 'table') {
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

    groupItemsBySection(items).forEach((group) => {
      section.appendChild(renderSectionGroup(group, partition, layout));
    });
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
