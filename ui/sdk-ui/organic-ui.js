/**
 * Organic UI v2 - Styled terminal containers with visual message streams
 *
 * Replaces bubble-canvas.js with rounded containers that show actual text output.
 * Phase 1: Layout + text display + scale animations + basic light streams
 */

const STYLE_ID = 'sdk-organic-ui-styles';
const STREAM_DURATION_MS = 700;

// Status dot colors
const STATUS_COLORS = {
  active: '#22c55e',   // Green - working
  idle: '#eab308',     // Yellow - waiting
  error: '#ef4444',    // Red - stuck
  offline: '#6b7280'   // Gray - offline
};

const AGENT_CONFIG = [
  { id: 'arch', label: 'Arch', fullName: 'Architect', color: '#7C3AED' },
  { id: 'infra', label: 'Infra', fullName: 'Infrastructure', color: '#F59E0B' },
  { id: 'front', label: 'Front', fullName: 'Frontend', color: '#10B981' },
  { id: 'back', label: 'Back', fullName: 'Backend', color: '#3B82F6' },
  { id: 'ana', label: 'Ana', fullName: 'Analyst', color: '#EC4899' },
  { id: 'rev', label: 'Rev', fullName: 'Reviewer', color: '#6366F1' }
];

const ROLE_ALIASES = {
  '1': 'arch', '2': 'infra', '3': 'front', '4': 'back', '5': 'ana', '6': 'rev',
  arch: 'arch', architect: 'arch',
  infra: 'infra', infrastructure: 'infra',
  front: 'front', frontend: 'front',
  back: 'back', backend: 'back',
  ana: 'ana', analyst: 'ana',
  rev: 'rev', reviewer: 'rev'
};

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    :root {
      --organic-bg: #0a0d12;
      --organic-container-bg: #12171f;
      --organic-border: rgba(255, 255, 255, 0.08);
      --organic-text: #e0e4ea;
      --organic-text-dim: rgba(224, 228, 234, 0.5);
    }

    .organic-ui {
      position: relative;
      width: 100%;
      height: 100vh;
      background: var(--organic-bg);
      display: flex;
      gap: 16px;
      padding: 16px;
      box-sizing: border-box;
      font-family: system-ui, -apple-system, sans-serif;
      color: var(--organic-text);
    }

    /* Left side: War Room (~60% width) */
    .organic-war-room {
      flex: 0 0 60%;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }

    /* War Room message stream */
    .organic-command-center {
      flex: 1 1 auto;
      background: var(--organic-container-bg);
      border: 1px solid var(--organic-border);
      border-radius: 20px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
    }

    .organic-command-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--organic-border);
      font-size: 13px;
      font-weight: 600;
      color: var(--organic-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .organic-command-content {
      flex: 1;
      padding: 12px 16px;
      overflow-y: auto;
      font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Right side: Agent grid (~40% width, 2x3) */
    .organic-agent-grid {
      flex: 0 0 40%;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      grid-template-rows: repeat(3, 1fr);
      gap: 12px;
      min-width: 0;
      min-height: 0;
    }

    /* Agent container */
    .organic-agent {
      background: var(--organic-container-bg);
      border: 1px solid var(--organic-border);
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: transform 250ms ease, box-shadow 250ms ease;
      will-change: transform;
      min-height: 0;
    }

    .organic-agent.is-sending {
      transform: scale(1.03);
      box-shadow: 0 0 20px rgba(var(--agent-color-rgb), 0.3);
    }

    .organic-agent.is-receiving {
      transform: scale(1.02);
      box-shadow: 0 0 15px rgba(var(--agent-color-rgb), 0.25);
    }

    .organic-agent.is-offline {
      opacity: 0.4;
    }

    .organic-agent.is-thinking {
      border-color: var(--agent-color);
      box-shadow: 0 0 15px rgba(var(--agent-color-rgb), 0.4);
      animation: organic-breathe 2s ease-in-out infinite;
    }

    .organic-agent.is-thinking .organic-agent-header::after {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--agent-color);
      animation: organic-pulse 1.2s ease-in-out infinite;
    }

    @keyframes organic-breathe {
      0%, 100% { transform: scale(1); box-shadow: 0 0 15px rgba(var(--agent-color-rgb), 0.3); }
      50% { transform: scale(1.02); box-shadow: 0 0 25px rgba(var(--agent-color-rgb), 0.5); }
    }

    @keyframes organic-pulse {
      0%, 100% { opacity: 0.4; transform: scale(0.9); }
      50% { opacity: 1; transform: scale(1.1); }
    }

    .organic-agent-header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--organic-border);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--agent-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-shrink: 0;
    }

    .organic-agent-header-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .organic-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--status-color, #6b7280);
      flex-shrink: 0;
    }

    .organic-status-dot.is-active {
      background: #22c55e;
      box-shadow: 0 0 6px #22c55e;
    }

    .organic-status-dot.is-idle {
      background: #eab308;
    }

    .organic-status-dot.is-error {
      background: #ef4444;
      animation: status-pulse 1s ease-in-out infinite;
    }

    .organic-status-dot.is-offline {
      background: #6b7280;
      opacity: 0.5;
    }

    @keyframes status-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .organic-agent-task {
      padding: 6px 10px;
      font-size: 9px;
      color: var(--organic-text-dim);
      border-bottom: 1px solid var(--organic-border);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 0;
    }

    .organic-agent-task-label {
      color: var(--organic-text-dim);
      margin-right: 4px;
    }

    .organic-agent-task-text {
      color: var(--organic-text);
    }

    .organic-agent-content {
      flex: 1 1 auto;
      padding: 8px 10px;
      overflow-y: auto;
      font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
      font-size: 10px;
      line-height: 1.4;
      color: var(--organic-text);
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 0;
    }

    .organic-agent-content:empty::before {
      content: 'Ready';
      color: var(--organic-text-dim);
    }

    /* Bottom: Input bar (inside War Room section) */
    .organic-input-bar {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-shrink: 0;
    }

    .organic-input-field {
      flex: 1;
      background: var(--organic-container-bg);
      border: 1px solid var(--organic-border);
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 14px;
      color: var(--organic-text);
      outline: none;
      transition: border-color 200ms, box-shadow 200ms;
    }

    .organic-input-field:focus {
      border-color: rgba(124, 58, 237, 0.5);
      box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.15);
    }

    .organic-input-field::placeholder {
      color: var(--organic-text-dim);
    }

    .organic-send-btn {
      background: linear-gradient(135deg, #7C3AED, #6366F1);
      border: none;
      border-radius: 10px;
      padding: 12px 24px;
      font-size: 13px;
      font-weight: 600;
      color: white;
      cursor: pointer;
      transition: transform 150ms, box-shadow 150ms;
    }

    .organic-send-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(124, 58, 237, 0.4);
    }

    .organic-send-btn:active {
      transform: translateY(0);
    }

    /* Message stream overlay */
    .organic-stream-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 100;
    }

    .organic-stream-line {
      position: absolute;
      height: 3px;
      border-radius: 2px;
      background: linear-gradient(90deg, var(--stream-color) 0%, transparent 100%);
      opacity: 0;
      transform-origin: left center;
    }

    .organic-stream-line.is-active {
      animation: organic-stream ${STREAM_DURATION_MS}ms ease-out forwards;
    }

    @keyframes organic-stream {
      0% { opacity: 0.8; transform: scaleX(0); }
      50% { opacity: 1; }
      100% { opacity: 0; transform: scaleX(1); }
    }
  `;

  document.head.appendChild(style);
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
    : '255, 255, 255';
}

function createOrganicUI(options = {}) {
  ensureStyles();

  const mount = options.mount || document.body;
  const agentMeta = new Map(AGENT_CONFIG.map(a => [a.id, a]));
  const agentElements = new Map();
  const agentTextBuffers = new Map();
  const MAX_LINES = 50;

  // Main container
  const container = document.createElement('div');
  container.className = 'organic-ui';

  // War Room wrapper (left side)
  const warRoomWrapper = document.createElement('div');
  warRoomWrapper.className = 'organic-war-room';

  // War Room message stream
  const commandCenter = document.createElement('div');
  commandCenter.className = 'organic-command-center';

  const commandHeader = document.createElement('div');
  commandHeader.className = 'organic-command-header';
  commandHeader.textContent = 'War Room';

  const commandContent = document.createElement('div');
  commandContent.className = 'organic-command-content';
  commandContent.textContent = 'Message stream coming soon...';

  commandCenter.appendChild(commandHeader);
  commandCenter.appendChild(commandContent);

  // Agent grid (right)
  const agentGrid = document.createElement('div');
  agentGrid.className = 'organic-agent-grid';

  for (const agent of AGENT_CONFIG) {
    const agentEl = document.createElement('div');
    agentEl.className = 'organic-agent';
    agentEl.dataset.agent = agent.id;
    agentEl.style.setProperty('--agent-color', agent.color);
    agentEl.style.setProperty('--agent-color-rgb', hexToRgb(agent.color));

    // Header with status dot
    const header = document.createElement('div');
    header.className = 'organic-agent-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'organic-agent-header-left';

    const label = document.createElement('span');
    label.textContent = agent.label;

    const statusDot = document.createElement('div');
    statusDot.className = 'organic-status-dot is-offline';

    headerLeft.appendChild(label);
    header.appendChild(headerLeft);
    header.appendChild(statusDot);

    // Task line
    const taskLine = document.createElement('div');
    taskLine.className = 'organic-agent-task';

    const taskLabel = document.createElement('span');
    taskLabel.className = 'organic-agent-task-label';
    taskLabel.textContent = 'Working on:';

    const taskText = document.createElement('span');
    taskText.className = 'organic-agent-task-text';
    taskText.textContent = '—';

    taskLine.appendChild(taskLabel);
    taskLine.appendChild(taskText);

    // Content area
    const content = document.createElement('div');
    content.className = 'organic-agent-content';

    agentEl.appendChild(header);
    agentEl.appendChild(taskLine);
    agentEl.appendChild(content);
    agentGrid.appendChild(agentEl);

    agentElements.set(agent.id, { element: agentEl, content, statusDot, taskText });
    agentTextBuffers.set(agent.id, []);
  }

  // Input bar (bottom)
  const inputBar = document.createElement('div');
  inputBar.className = 'organic-input-bar';

  const input = document.createElement('input');
  input.className = 'organic-input-field';
  input.type = 'text';
  input.placeholder = 'Send a message to agents...';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'organic-send-btn';
  sendBtn.textContent = 'Send';

  inputBar.appendChild(input);
  inputBar.appendChild(sendBtn);

  // Stream layer (overlay for message animations)
  const streamLayer = document.createElement('div');
  streamLayer.className = 'organic-stream-layer';

  // Assemble - War Room wrapper contains command center + input
  warRoomWrapper.appendChild(commandCenter);
  warRoomWrapper.appendChild(inputBar);

  container.appendChild(warRoomWrapper);
  container.appendChild(agentGrid);
  container.appendChild(streamLayer);
  mount.appendChild(container);

  // Helper: resolve agent ID from various formats
  const resolveAgentId = value => {
    if (!value) return null;
    const key = String(value).toLowerCase();
    return ROLE_ALIASES[key] || (agentMeta.has(key) ? key : null);
  };

  // Helper: get center position of an agent container
  const getAgentCenter = agentId => {
    const agentData = agentElements.get(agentId);
    if (!agentData) return null;
    const rect = agentData.element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      x: rect.left - containerRect.left + rect.width / 2,
      y: rect.top - containerRect.top + rect.height / 2
    };
  };

  // Update agent state (idle, thinking, active, offline)
  const updateState = (agentIdOrPane, state) => {
    const agentId = resolveAgentId(agentIdOrPane);
    if (!agentId) return;
    const agentData = agentElements.get(agentId);
    if (!agentData) return;

    const el = agentData.element;
    const dot = agentData.statusDot;

    // Update container classes
    el.classList.remove('is-thinking', 'is-offline', 'is-sending', 'is-receiving');

    // Update status dot
    if (dot) {
      dot.classList.remove('is-active', 'is-idle', 'is-error', 'is-offline');
    }

    if (state === 'thinking' || state === 'tool' || state === 'active') {
      el.classList.add('is-thinking');
      if (dot) dot.classList.add('is-active');
    } else if (state === 'idle') {
      if (dot) dot.classList.add('is-idle');
    } else if (state === 'error' || state === 'stuck') {
      if (dot) dot.classList.add('is-error');
    } else if (state === 'offline') {
      el.classList.add('is-offline');
      if (dot) dot.classList.add('is-offline');
    }
  };

  // Set the current task for an agent
  const setTask = (agentIdOrPane, taskText) => {
    const agentId = resolveAgentId(agentIdOrPane);
    if (!agentId) return;
    const agentData = agentElements.get(agentId);
    if (!agentData || !agentData.taskText) return;

    agentData.taskText.textContent = taskText || '—';
  };

      // Helper to strip ANSI escape codes
      const stripAnsi = (str) => {
        return str.replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
                  .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
      };
  
      // Append text to an agent's content area
      const appendText = (agentIdOrPane, text) => {
        const agentId = resolveAgentId(agentIdOrPane);
        if (!agentId) return;
        const agentData = agentElements.get(agentId);
        if (!agentData) return;
  
        const buffer = agentTextBuffers.get(agentId);
        const cleanText = stripAnsi(text);
        const lines = cleanText.split('\n');
        buffer.push(...lines);
    // Keep only last MAX_LINES
    while (buffer.length > MAX_LINES) {
      buffer.shift();
    }

    agentData.content.textContent = buffer.join('\n');
    agentData.content.scrollTop = agentData.content.scrollHeight;
  };

  // Set text (replace) for an agent
  const setText = (agentIdOrPane, text) => {
    const agentId = resolveAgentId(agentIdOrPane);
    if (!agentId) return;
    const agentData = agentElements.get(agentId);
    if (!agentData) return;

    const lines = text.split('\n').slice(-MAX_LINES);
    agentTextBuffers.set(agentId, lines);
    agentData.content.textContent = lines.join('\n');
    agentData.content.scrollTop = agentData.content.scrollHeight;
  };

  // Trigger scale animation on send/receive
  const triggerScale = (agentIdOrPane, type) => {
    const agentId = resolveAgentId(agentIdOrPane);
    if (!agentId) return;
    const agentData = agentElements.get(agentId);
    if (!agentData) return;

    const el = agentData.element;
    const className = type === 'send' ? 'is-sending' : 'is-receiving';
    el.classList.add(className);

    setTimeout(() => {
      el.classList.remove(className);
    }, 300);
  };

  // Trigger message stream animation between agents
  const triggerMessageStream = payload => {
    if (document.hidden) return;

    const fromId = resolveAgentId(payload?.fromRole || payload?.from || payload?.fromId);
    const toId = resolveAgentId(payload?.toRole || payload?.to || payload?.toId);
    if (!fromId || !toId || fromId === toId) return;

    const phase = payload?.phase;
    if (phase && !['queued', 'sending'].includes(String(phase).toLowerCase())) return;

    const start = getAgentCenter(fromId);
    const end = getAgentCenter(toId);
    if (!start || !end) return;

    // Trigger scale animations
    triggerScale(fromId, 'send');
    setTimeout(() => triggerScale(toId, 'receive'), STREAM_DURATION_MS * 0.6);

    // Create stream line
    const meta = agentMeta.get(fromId);
    const streamColor = meta?.color || '#ffffff';

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    const line = document.createElement('div');
    line.className = 'organic-stream-line';
    line.style.setProperty('--stream-color', streamColor);
    line.style.left = `${start.x}px`;
    line.style.top = `${start.y}px`;
    line.style.width = `${length}px`;
    line.style.transform = `rotate(${angle}deg)`;

    streamLayer.appendChild(line);

    // Trigger animation
    requestAnimationFrame(() => {
      line.classList.add('is-active');
    });

    // Cleanup after animation
    setTimeout(() => {
      line.remove();
    }, STREAM_DURATION_MS + 100);
  };

  // Track if placeholder has been cleared
  let placeholderCleared = false;

  // Append to command center (War Room)
  const appendToCommandCenter = text => {
    // Clear placeholder on first real message
    if (!placeholderCleared) {
      commandContent.textContent = '';
      placeholderCleared = true;
    }
    commandContent.textContent += text;
    // Keep scrolled to bottom
    commandContent.scrollTop = commandContent.scrollHeight;
  };

  // Visibility handling
  const handleVisibilityChange = () => {
    container.style.visibility = document.hidden ? 'hidden' : 'visible';
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return {
    container,
    input,
    sendBtn,
    commandContent, // Expose for War Room message appending
    // API matching bubble-canvas
    triggerMessageStream,
    // New v2 API
    updateState,
    setTask,
    appendText,
    setText,
    appendToCommandCenter,
    triggerScale,
    destroy() {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      container.remove();
    }
  };
}

module.exports = {
  AGENT_CONFIG,
  createOrganicUI
};
