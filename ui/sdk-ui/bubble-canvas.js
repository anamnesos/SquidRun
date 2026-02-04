const STYLE_ID = 'sdk-bubble-canvas-styles';
const STREAM_POOL_SIZE = 6;
const STREAM_PARTICLE_COUNT = 6;
const STREAM_DURATION_MS = 1600;
const STREAM_STAGGER_MS = 140;

const DEFAULT_AGENTS = [
  { id: 'arch', label: 'Arch', color: '#7C3AED', x: 50, y: 40, size: 170, state: 'thinking' },
  { id: 'infra', label: 'Infra', color: '#F59E0B', x: 35, y: 18, size: 120, state: 'idle' },
  { id: 'front', label: 'Front', color: '#10B981', x: 25, y: 48, size: 130, state: 'idle' },
  { id: 'back', label: 'Back', color: '#3B82F6', x: 75, y: 48, size: 130, state: 'idle' },
  { id: 'ana', label: 'Ana', color: '#EC4899', x: 30, y: 72, size: 115, state: 'idle' },
  { id: 'rev', label: 'Rev', color: '#6366F1', x: 70, y: 72, size: 115, state: 'idle' }
];

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    :root {
      --sdk-canvas-bg: #0b0f14;
      --sdk-canvas-grid: rgba(255, 255, 255, 0.03);
      --sdk-bubble-text: #e7ebf0;
      --sdk-bubble-ring: rgba(255, 255, 255, 0.08);
      --sdk-input-bg: #0f141b;
      --sdk-input-border: rgba(255, 255, 255, 0.14);
      --sdk-input-focus: rgba(124, 58, 237, 0.55);
    }

    .sdk-bubble-canvas {
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 520px;
      background:
        radial-gradient(circle at 20% 20%, rgba(255, 255, 255, 0.04), transparent 45%),
        radial-gradient(circle at 80% 25%, rgba(255, 255, 255, 0.03), transparent 40%),
        radial-gradient(circle at 50% 80%, rgba(255, 255, 255, 0.04), transparent 45%),
        var(--sdk-canvas-bg);
      overflow: hidden;
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      color: var(--sdk-bubble-text);
    }

    .sdk-bubble-layer {
      position: absolute;
      inset: 0;
      z-index: 3;
    }

    .sdk-stream-layer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1;
    }

    .sdk-stream-line {
      fill: none;
      stroke: var(--stream-color, rgba(255, 255, 255, 0.35));
      stroke-width: 1.4;
      stroke-linecap: round;
      opacity: 0;
    }

    .sdk-stream-line.is-active {
      animation: sdk-stream-line var(--stream-duration, 1600ms) ease-out 1;
    }

    .sdk-stream-particles {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2;
    }

    .sdk-stream-particle {
      position: absolute;
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--stream-color, rgba(255, 255, 255, 0.8));
      opacity: 0;
      left: 0;
      top: 0;
      offset-anchor: 50% 50%;
      offset-rotate: 0deg;
    }

    .sdk-stream-particle.is-active {
      animation: sdk-stream-flow var(--stream-duration, 1600ms) linear 1;
      animation-delay: var(--stream-delay, 0ms);
    }

    .sdk-bubble {
      position: absolute;
      border-radius: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid var(--bubble-color, var(--sdk-bubble-ring));
      background: rgba(255, 255, 255, 0.02);
      color: var(--sdk-bubble-text);
      letter-spacing: 0.6px;
      text-transform: uppercase;
      font-size: 12px;
      transform: translate(-50%, -50%);
      transition: transform 0.4s ease, opacity 0.4s ease;
    }

    .sdk-bubble.idle {
      opacity: 0.65;
    }

    .sdk-bubble.thinking {
      opacity: 0.9;
      animation: sdk-breathe 3s ease-in-out infinite;
    }

    .sdk-bubble.active {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1.08);
    }

    .sdk-bubble-canvas.is-hidden .sdk-bubble {
      animation-play-state: paused;
    }

    .sdk-bubble-canvas.is-hidden .sdk-stream-line,
    .sdk-bubble-canvas.is-hidden .sdk-stream-particle {
      animation-play-state: paused;
    }

    @keyframes sdk-breathe {
      0%, 100% { transform: translate(-50%, -50%) scale(1); }
      50% { transform: translate(-50%, -50%) scale(1.03); }
    }

    @keyframes sdk-stream-flow {
      0% { opacity: 0; offset-distance: 0%; }
      15% { opacity: 0.9; }
      85% { opacity: 0.9; }
      100% { opacity: 0; offset-distance: 100%; }
    }

    @keyframes sdk-stream-line {
      0% { opacity: 0; }
      20% { opacity: 0.45; }
      80% { opacity: 0.35; }
      100% { opacity: 0; }
    }

    @media (prefers-reduced-motion: reduce) {
      .sdk-bubble.thinking {
        animation: none;
      }

      .sdk-stream-line.is-active,
      .sdk-stream-particle.is-active {
        animation: none;
        opacity: 0;
      }
    }

    .sdk-bubble-label {
      pointer-events: none;
      opacity: 0.9;
    }

    .sdk-input-area {
      position: absolute;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      width: min(860px, calc(100% - 48px));
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-radius: 999px;
      border: 1px solid var(--sdk-input-border);
      background: var(--sdk-input-bg);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.03);
      z-index: 5;
    }

    .sdk-input-field {
      flex: 1;
      border: none;
      outline: none;
      background: transparent;
      color: var(--sdk-bubble-text);
      font-size: 14px;
      letter-spacing: 0.2px;
    }

    .sdk-input-field::placeholder {
      color: rgba(231, 235, 240, 0.45);
    }

    .sdk-input-field:focus {
      outline: none;
    }

    .sdk-input-area:focus-within {
      border-color: var(--sdk-input-focus);
      box-shadow: 0 0 0 1px var(--sdk-input-focus);
    }

    .sdk-input-send {
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.06);
      color: var(--sdk-bubble-text);
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      cursor: pointer;
    }

    .sdk-input-send:hover {
      border-color: rgba(255, 255, 255, 0.22);
      background: rgba(255, 255, 255, 0.12);
    }
  `;

  document.head.appendChild(style);
}

const ROLE_ALIASES = {
  '1': 'arch',
  '2': 'infra',
  '3': 'front',
  '4': 'back',
  '5': 'ana',
  '6': 'rev',
  arch: 'arch',
  architect: 'arch',
  infra: 'infra',
  infrastructure: 'infra',
  front: 'front',
  frontend: 'front',
  back: 'back',
  backend: 'back',
  ana: 'ana',
  analyst: 'ana',
  rev: 'rev',
  reviewer: 'rev'
};

function buildBubble(agent) {
  const bubble = document.createElement('div');
  const stateClass = agent.state ? String(agent.state).toLowerCase() : 'idle';
  bubble.className = `sdk-bubble ${stateClass}`;
  bubble.dataset.agent = agent.id;
  bubble.style.setProperty('--bubble-color', agent.color);
  bubble.style.width = `${agent.size}px`;
  bubble.style.height = `${agent.size}px`;
  bubble.style.left = `${agent.x}%`;
  bubble.style.top = `${agent.y}%`;

  const label = document.createElement('span');
  label.className = 'sdk-bubble-label';
  label.textContent = agent.label;
  bubble.appendChild(label);

  return bubble;
}

function buildStreamPath(start, end, curveSeed) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy) || 1;
  const nx = -dy / distance;
  const ny = dx / distance;
  const direction = curveSeed % 2 === 0 ? 1 : -1;
  const curvature = Math.min(140, distance * 0.35) * direction;
  const cx = start.x + dx * 0.5 + nx * curvature;
  const cy = start.y + dy * 0.5 + ny * curvature;
  return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

function restartAnimation(element, className) {
  element.classList.remove(className);
  element.getBoundingClientRect();
  element.classList.add(className);
}

function createBubbleCanvas(options = {}) {
  ensureStyles();

  const mount = options.mount || document.body;
  const agents = options.agents || DEFAULT_AGENTS;
  const agentMeta = new Map(agents.map(agent => [agent.id, agent]));

  const canvas = document.createElement('div');
  canvas.className = 'sdk-bubble-canvas';

  const streamLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  streamLayer.classList.add('sdk-stream-layer');
  streamLayer.setAttribute('aria-hidden', 'true');
  streamLayer.setAttribute('width', '100%');
  streamLayer.setAttribute('height', '100%');

  const particleLayer = document.createElement('div');
  particleLayer.className = 'sdk-stream-particles';

  const layer = document.createElement('div');
  layer.className = 'sdk-bubble-layer';
  canvas.appendChild(streamLayer);
  canvas.appendChild(particleLayer);
  canvas.appendChild(layer);

  const bubbleMap = new Map();
  agents.forEach(agent => {
    const bubble = buildBubble(agent);
    bubbleMap.set(agent.id, bubble);
    layer.appendChild(bubble);
  });

  const streamPool = Array.from({ length: STREAM_POOL_SIZE }, () => {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('sdk-stream-line');
    group.appendChild(path);
    streamLayer.appendChild(group);

    const particles = Array.from({ length: STREAM_PARTICLE_COUNT }, () => {
      const particle = document.createElement('div');
      particle.className = 'sdk-stream-particle';
      particleLayer.appendChild(particle);
      return particle;
    });

    return {
      path,
      particles,
      timeoutId: null
    };
  });

  let streamIndex = 0;

  const resolveAgentId = value => {
    if (!value) return null;
    const key = String(value).toLowerCase();
    return ROLE_ALIASES[key] || (agentMeta.has(key) ? key : null);
  };

  const getBubbleCenter = agentId => {
    const bubble = bubbleMap.get(agentId);
    if (!bubble) return null;
    const bubbleRect = bubble.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      x: bubbleRect.left - canvasRect.left + bubbleRect.width / 2,
      y: bubbleRect.top - canvasRect.top + bubbleRect.height / 2
    };
  };

  const triggerMessageStream = payload => {
    if (document.hidden) return;
    const fromId = resolveAgentId(payload?.fromRole || payload?.from || payload?.fromId);
    const toId = resolveAgentId(payload?.toRole || payload?.to || payload?.toId);
    if (!fromId || !toId || fromId === toId) return;
    const phase = payload?.phase;
    if (phase && !['queued', 'sending'].includes(String(phase).toLowerCase())) return;

    const start = getBubbleCenter(fromId);
    const end = getBubbleCenter(toId);
    if (!start || !end) return;

    const meta = agentMeta.get(fromId);
    const streamColor = meta?.color || '#ffffff';
    const stream = streamPool[streamIndex];
    streamIndex = (streamIndex + 1) % streamPool.length;
    if (stream.timeoutId) {
      clearTimeout(stream.timeoutId);
      stream.timeoutId = null;
    }

    const curveSeed = fromId.charCodeAt(0) + toId.charCodeAt(0);
    const pathData = buildStreamPath(start, end, curveSeed);
    stream.path.setAttribute('d', pathData);
    stream.path.style.setProperty('--stream-color', streamColor);
    stream.path.style.setProperty('--stream-duration', `${STREAM_DURATION_MS}ms`);
    restartAnimation(stream.path, 'is-active');

    stream.particles.forEach((particle, index) => {
      particle.style.setProperty('--stream-color', streamColor);
      particle.style.setProperty('--stream-duration', `${STREAM_DURATION_MS}ms`);
      particle.style.setProperty('--stream-delay', `${index * STREAM_STAGGER_MS}ms`);
      particle.style.offsetPath = `path("${pathData}")`;
      restartAnimation(particle, 'is-active');
    });

    const totalDuration = STREAM_DURATION_MS + STREAM_STAGGER_MS * STREAM_PARTICLE_COUNT;
    stream.timeoutId = setTimeout(() => {
      stream.path.classList.remove('is-active');
      stream.particles.forEach(particle => particle.classList.remove('is-active'));
      stream.timeoutId = null;
    }, totalDuration);
  };

  const inputArea = document.createElement('div');
  inputArea.className = 'sdk-input-area';

  const input = document.createElement('input');
  input.className = 'sdk-input-field';
  input.type = 'text';
  input.placeholder = 'Type your message...';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'sdk-input-send';
  sendBtn.type = 'button';
  sendBtn.textContent = 'Send';

  inputArea.appendChild(input);
  inputArea.appendChild(sendBtn);
  canvas.appendChild(inputArea);

  mount.appendChild(canvas);

  const handleVisibilityChange = () => {
    canvas.classList.toggle('is-hidden', document.hidden);
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);
  handleVisibilityChange();

  return {
    canvas,
    input,
    sendBtn,
    triggerMessageStream,
    destroy() {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      streamPool.forEach(stream => {
        if (stream.timeoutId) {
          clearTimeout(stream.timeoutId);
          stream.timeoutId = null;
        }
      });
      canvas.remove();
    }
  };
}

module.exports = {
  DEFAULT_AGENTS,
  createBubbleCanvas
};
