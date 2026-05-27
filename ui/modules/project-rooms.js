'use strict';

const MAIN_ROOM_ID = 'main';

const PROJECT_ROOMS = Object.freeze([
  Object.freeze({
    id: MAIN_ROOM_ID,
    label: 'Main',
    status: 'LIVE',
    authority: 'live',
    title: 'Current command room',
    summary: 'The room James is in now: live SquidRun panes, current lane evidence, and direct status answers.',
    details: [
      'Panes: Mira, Builder, Oracle',
      'Source authority: current local SquidRun evidence',
      'Other room cards are summaries only',
    ],
    jamesAction: 'JAMES ACTION: NONE',
  }),
  Object.freeze({
    id: 'trustquote',
    label: 'TrustQuote',
    status: 'PREVIEW',
    authority: 'preview',
    title: 'TrustQuote readiness',
    summary: 'Future TrustQuote room for Builder/Oracle work, product map, and workflow knowledge.',
    details: [
      'Room launch proof: not present',
      'Project-context mutation: disabled',
      'Agent routing: preview only',
    ],
    jamesAction: 'JAMES ACTION: NONE',
  }),
  Object.freeze({
    id: 'mira-build',
    label: 'Mira Build',
    status: 'PREVIEW',
    authority: 'preview',
    title: 'SquidRun and Mira internals',
    summary: 'Build room for SquidRun/Mira implementation, system-map evidence, and blocker visibility.',
    details: [
      'Room launch proof: not present',
      'Prototype/archive refs: non-authoritative',
      'Voice and A3/A4 remain blocked',
    ],
    jamesAction: 'JAMES ACTION: NONE',
  }),
]);

const ROOM_BY_ID = Object.freeze(
  PROJECT_ROOMS.reduce((acc, room) => {
    acc[room.id] = room;
    return acc;
  }, {}),
);

function cloneRoom(room) {
  return {
    ...room,
    details: Array.isArray(room.details) ? [...room.details] : [],
  };
}

function getProjectRooms() {
  return PROJECT_ROOMS.map(cloneRoom);
}

function getProjectRoomIds() {
  return PROJECT_ROOMS.map((room) => room.id);
}

function normalizeRoomId(roomId) {
  const normalized = String(roomId || '').trim().toLowerCase();
  return ROOM_BY_ID[normalized] ? normalized : MAIN_ROOM_ID;
}

function getProjectRoom(roomId = MAIN_ROOM_ID) {
  return cloneRoom(ROOM_BY_ID[normalizeRoomId(roomId)]);
}

function getRoomAuthority(roomId = MAIN_ROOM_ID, launchProof = null) {
  const room = getProjectRoom(roomId);
  const launchProofPresent = Boolean(launchProof && launchProof.approved === true);

  if (room.id === MAIN_ROOM_ID) {
    return {
      roomId: room.id,
      status: 'live_authority',
      canOwnCurrentLane: true,
      reason: 'main_current_command_room',
    };
  }

  return {
    roomId: room.id,
    status: launchProofPresent ? 'launch_proof_required_before_live_authority' : 'preview_only',
    canOwnCurrentLane: false,
    reason: launchProofPresent ? 'future_review_required' : 'missing_room_launch_scope_proof',
  };
}

function resolveMainLaneAuthority(candidate = {}) {
  const sourceRoomId = normalizeRoomId(
    candidate.sourceRoomId
      || candidate.source_room_id
      || candidate.roomId
      || candidate.room_id
      || MAIN_ROOM_ID,
  );
  const sourceRef = String(candidate.sourceRef || candidate.source_ref || '').trim();

  if (sourceRoomId !== MAIN_ROOM_ID) {
    return {
      canUseAsAuthority: false,
      sourceRoomId,
      sourceRef: sourceRef || null,
      reason: 'cross_room_preview_only',
    };
  }

  return {
    canUseAsAuthority: true,
    sourceRoomId: MAIN_ROOM_ID,
    sourceRef: sourceRef || null,
    reason: 'main_room_source',
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildRoomCardHtml(room, options = {}) {
  const detailItems = room.details
    .map((detail) => `<li>${escapeHtml(detail)}</li>`)
    .join('');
  const actionHtml = options.showAction
    ? `  <p class="project-room-card-action">${escapeHtml(room.jamesAction)}</p>`
    : '';

  return [
    `<article class="project-room-card" data-room-card="${escapeHtml(room.id)}" data-authority="${escapeHtml(room.authority)}">`,
    '  <div class="project-room-card-head">',
    `    <span class="project-room-card-kicker">${escapeHtml(room.status)}</span>`,
    `    <span class="project-room-card-room">${escapeHtml(room.label)}</span>`,
    '  </div>',
    `  <h2 class="project-room-card-title">${escapeHtml(room.title)}</h2>`,
    `  <p class="project-room-card-summary">${escapeHtml(room.summary)}</p>`,
    `  <ul class="project-room-card-list">${detailItems}</ul>`,
    actionHtml,
    '</article>',
  ].join('');
}

function buildRoomOverviewHtml(roomId = MAIN_ROOM_ID) {
  const selectedRoom = getProjectRoom(roomId);
  const selectedAuthority = getRoomAuthority(selectedRoom.id);
  const supportRooms = PROJECT_ROOMS
    .filter((room) => room.id !== selectedRoom.id)
    .map(cloneRoom);
  const cards = [
    buildRoomCardHtml(selectedRoom, { showAction: true }),
    ...supportRooms.map((room) => buildRoomCardHtml(room)),
  ].join('');

  return [
    `<div class="project-room-overview-grid" data-selected-room="${escapeHtml(selectedRoom.id)}" data-selected-authority="${escapeHtml(selectedAuthority.status)}">`,
    cards,
    '</div>',
  ].join('');
}

function setActiveRoomDom(documentRef, roomId) {
  const selectedRoomId = normalizeRoomId(roomId);
  const root = documentRef.getElementById('projectRooms');
  const overview = documentRef.getElementById('projectRoomOverview');
  const tabs = Array.from(documentRef.querySelectorAll('[data-project-room-tab]'));

  if (root) {
    root.dataset.selectedRoom = selectedRoomId;
  }

  for (const tab of tabs) {
    const active = normalizeRoomId(tab.dataset.projectRoomTab) === selectedRoomId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.setAttribute('tabindex', active ? '0' : '-1');
  }

  if (overview) {
    overview.dataset.roomId = selectedRoomId;
    overview.innerHTML = buildRoomOverviewHtml(selectedRoomId);
  }

  return getProjectRoom(selectedRoomId);
}

function initProjectRooms(options = {}) {
  const documentRef = options.documentRef || (typeof document !== 'undefined' ? document : null);
  if (!documentRef || typeof documentRef.getElementById !== 'function') {
    return {
      ok: false,
      reason: 'missing_document',
      destroy: () => {},
    };
  }

  const root = documentRef.getElementById('projectRooms');
  if (!root) {
    return {
      ok: false,
      reason: 'missing_project_rooms_root',
      destroy: () => {},
    };
  }

  let selectedRoomId = normalizeRoomId(options.initialRoomId || root.dataset.selectedRoom || MAIN_ROOM_ID);
  const cleanup = [];
  const tabs = Array.from(documentRef.querySelectorAll('[data-project-room-tab]'));

  const selectRoom = (roomId) => {
    selectedRoomId = normalizeRoomId(roomId);
    return setActiveRoomDom(documentRef, selectedRoomId);
  };

  for (const tab of tabs) {
    const handler = () => selectRoom(tab.dataset.projectRoomTab);
    tab.addEventListener('click', handler);
    cleanup.push(() => tab.removeEventListener('click', handler));
  }

  selectRoom(selectedRoomId);

  return {
    ok: true,
    getSelectedRoomId: () => selectedRoomId,
    selectRoom,
    destroy: () => {
      for (const fn of cleanup.splice(0)) {
        try {
          fn();
        } catch (_) {}
      }
    },
  };
}

module.exports = {
  MAIN_ROOM_ID,
  PROJECT_ROOMS,
  buildRoomOverviewHtml,
  getProjectRoom,
  getProjectRoomIds,
  getProjectRooms,
  getRoomAuthority,
  initProjectRooms,
  normalizeRoomId,
  resolveMainLaneAuthority,
};
