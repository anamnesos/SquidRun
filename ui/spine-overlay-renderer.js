'use strict';

const bridge = window.squidrunAPI || window.squidrun || null;

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value ?? '');
}

function receiptNode(receipt) {
  const row = document.createElement('div');
  row.className = 'receipt-row';

  const label = document.createElement('span');
  label.className = 'receipt-label';
  label.textContent = receipt?.label || 'receipt';

  const value = document.createElement('strong');
  value.className = 'receipt-value';
  value.textContent = receipt?.value || 'unknown';

  const source = document.createElement('span');
  source.className = 'receipt-source';
  source.textContent = receipt?.source || 'source unavailable';

  row.append(label, value, source);
  return row;
}

function swallowedNode(entry) {
  const line = document.createElement('p');
  line.className = 'ledger-line';
  const signal = document.createElement('span');
  const score = Number.isFinite(Number(entry?.regretScore)) ? Number(entry.regretScore).toFixed(2) : '--';
  signal.textContent = `${entry?.signal || 'signal'} ${score}`;
  const reason = document.createElement('strong');
  const wouldHaveSaid = String(entry?.wouldHaveSaid || '').trim();
  reason.textContent = wouldHaveSaid
    ? `${entry?.reason || 'silent'} | would have said: ${wouldHaveSaid}`
    : (entry?.reason || 'silent');
  line.append(signal, reason);
  return line;
}

function renderSnapshot(snapshot) {
  const artifact = snapshot?.artifact || {};
  const score = clamp01(snapshot?.regretScore ?? artifact.regretScore);
  const threshold = clamp01(artifact.threshold || 0.8);
  const speak = snapshot?.speak === true;
  const claim = snapshot?.claim ?? artifact.claim;
  const whyNow = snapshot?.whyNow ?? artifact.whyNow;
  const receiptList = Array.isArray(snapshot?.receipts) ? snapshot.receipts : (Array.isArray(artifact.receipts) ? artifact.receipts : []);
  const proposedAction = snapshot?.proposedAction || artifact.proposedAction || {};
  const executionMode = String(proposedAction.executionMode || 'dry-run').trim().toLowerCase();
  const dryRunLabel = String(proposedAction.dryRunLabel || '').trim();
  const source = String(snapshot?.source || artifact.source || 'live').trim() || 'live';
  const pushbackText = String(snapshot?.pushback ?? artifact.pushback ?? '').trim();
  const context = snapshot?.context || artifact.context || 'work-life';
  const shell = document.getElementById('spineShell');
  if (!shell) return;

  shell.style.setProperty('--regret', score.toFixed(3));
  shell.dataset.context = context;
  shell.dataset.rift = speak ? 'open' : 'closed';

  setText('spineUpdated', snapshot?.generatedAt || 'unknown');
  const sourceNode = document.getElementById('spineSource');
  const scenarioName = source.replace(/^scenario:/, '');
  if (sourceNode) {
    const isLive = source === 'live';
    sourceNode.hidden = isLive;
    sourceNode.textContent = isLive ? 'source live' : `scenario ${scenarioName}`;
    sourceNode.classList.toggle('scenario-source', !isLive);
  }
  const scenarioBanner = document.getElementById('scenarioBanner');
  if (scenarioBanner) {
    const isLive = source === 'live';
    const isScenario = source.startsWith('scenario:');
    scenarioBanner.hidden = isLive;
    scenarioBanner.querySelector('strong').textContent = isLive ? 'LIVE' : (isScenario ? 'SCENARIO REPLAY' : 'UNVERIFIED FEED');
    scenarioBanner.querySelector('span').textContent = isLive ? '' : `${scenarioName} / not live account state`;
  }
  setText('artifactContext', String(context).toUpperCase());
  setText('artifactScore', `regret ${score.toFixed(2)} / ${threshold.toFixed(2)}`);
  setText('artifactClaim', speak ? (claim || 'Interrupt earned.') : 'No interrupt earned.');
  setText('artifactWhy', speak ? (whyNow || 'The scorer allowed speech.') : (whyNow || 'Edge pressure is visible, but the mind withheld speech.'));
  setText('artifactAction', speak ? (proposedAction.text || 'Wait for confirmation.') : 'Stay quiet. Keep watching read-only status.');

  const confirm = document.getElementById('artifactConfirm');
  if (confirm) {
    confirm.disabled = true;
    confirm.textContent = speak
      ? (dryRunLabel || `dry-run only: drafts/logs, no send/write (${executionMode})`)
      : 'dry-run only: no action armed';
    confirm.setAttribute('aria-label', speak
      ? 'Dry run only. Confirmation would log the proposed action and will not send, write, or execute it.'
      : 'Dry run only. No action is armed.');
  }

  const receiptsNode = document.getElementById('artifactReceipts');
  if (receiptsNode) {
    receiptsNode.replaceChildren(...receiptList.map(receiptNode));
  }

  const pushback = document.getElementById('artifactPushback');
  if (pushback) {
    pushback.hidden = !speak || !pushbackText;
    pushback.textContent = pushbackText;
  }

  const ledger = document.getElementById('swallowedLedger');
  if (ledger) {
    const swallowed = Array.isArray(snapshot?.swallowed) ? snapshot.swallowed : [];
    ledger.replaceChildren(...swallowed.map(swallowedNode));
  }

  const mouth = speak
    ? 'voice placeholder: one interruption earned; execution remains locked'
    : 'voice placeholder: mind withheld speech; edge remains alive';
  setText('mouthLine', mouth);
}

async function loadSnapshot() {
  try {
    const api = bridge?.spine?.snapshot
      ? bridge.spine.snapshot
      : ((payload) => bridge?.invoke?.('spine-overlay:snapshot', payload));
    if (typeof api !== 'function') throw new Error('spine snapshot bridge unavailable');
    const snapshot = await api({ reason: 'renderer_load' });
    renderSnapshot(snapshot);
  } catch (error) {
    renderSnapshot({
      generatedAt: new Date().toISOString(),
      artifact: {
        regretScore: 0.76,
        threshold: 0.8,
        speak: false,
        context: 'work-life',
        claim: 'Spine bridge failed before live read.',
        whyNow: error.message,
        receipts: [
          { label: 'renderer', value: 'bridge unavailable', source: 'spine-overlay-renderer.js' },
        ],
        proposedAction: {
          text: 'Do not execute. Fix the read-only bridge before trusting this surface.',
          reversible: true,
          executionMode: 'dry-run',
        },
        pushback: 'A beautiful overlay with no proof channel is just theater. Fix the proof path first.',
      },
      swallowed: [
        {
          signal: 'execution',
          reason: 'blocked: renderer fallback has no order path',
          regretScore: 1,
          wouldHaveSaid: 'Execution path requested.',
        },
      ],
    });
  }
}

function setupField() {
  const canvas = document.getElementById('spineField');
  const shell = document.getElementById('spineShell');
  if (!canvas || !shell) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let width = 0;
  let height = 0;
  let frame = 0;

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw() {
    frame += 1;
    const regret = clamp01(getComputedStyle(shell).getPropertyValue('--regret'));
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;
    for (let i = 0; i < 26; i += 1) {
      const y = (height / 26) * i;
      const alpha = 0.025 + regret * 0.035;
      ctx.strokeStyle = `rgba(87, 246, 255, ${alpha})`;
      ctx.beginPath();
      for (let x = 0; x <= width; x += 28) {
        const pulse = Math.sin(frame / 48 + x / 190 + i * 0.25) * (1 + regret * 6);
        if (x === 0) ctx.moveTo(x, y + pulse);
        else ctx.lineTo(x, y + pulse);
      }
      ctx.stroke();
    }

    const radius = Math.max(width, height) * (0.18 + regret * 0.34);
    const gradient = ctx.createRadialGradient(width * 0.92, height * 0.48, 4, width * 0.92, height * 0.48, radius);
    gradient.addColorStop(0, `rgba(255, 183, 77, ${0.05 + regret * 0.22})`);
    gradient.addColorStop(0.42, `rgba(54, 244, 255, ${0.02 + regret * 0.08})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    window.requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  resize();
  draw();
}

document.addEventListener('DOMContentLoaded', () => {
  setupField();
  loadSnapshot();
  const pollMs = Math.max(250, Math.min(15000, Number(window.__SPINE_OVERLAY_POLL_MS) || 15000));
  setInterval(loadSnapshot, pollMs);
});
