(function () {
  'use strict';

  const TURN_CHANNEL = 'mira:lab-turn';
  const EXPORT_CHANNEL = 'mira:lab-export';
  const PROMPT_REPLY_CHANNEL = 'mira:lab-prompt-reply';
  const sessionId = `mira-lab-${new Date().toISOString().slice(0, 10)}`;

  function bridgeInvoke(channel, payload) {
    const api = window.squidrunAPI || window.squidrun || {};
    const invoke = typeof api.invoke === 'function'
      ? api.invoke.bind(api)
      : (api.ipc && typeof api.ipc.invoke === 'function' ? api.ipc.invoke.bind(api.ipc) : null);
    if (!invoke) return Promise.resolve({ ok: false, reason: 'bridge_unavailable' });
    return invoke(channel, payload);
  }

  function targetAgents(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => ['architect', 'builder', 'oracle'].includes(item));
  }

  function lineClass(role) {
    if (role === 'mira') return 'mira';
    if (['architect', 'builder', 'oracle'].includes(role)) return 'agent';
    return 'james';
  }

  function appendLine(role, text, extraClass) {
    const transcript = document.getElementById('miraLabTranscript');
    if (!transcript) return;
    const line = document.createElement('p');
    const classes = ['mira-lab-line', lineClass(role)];
    if (extraClass) classes.push(extraClass);
    line.className = classes.join(' ');
    line.textContent = text;
    transcript.appendChild(line);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function appendBlockedBanner(reason) {
    appendLine('mira', `Mira Lab reply unavailable: ${reason || 'unknown'}`, 'mira-lab-blocked');
  }

  function appendQuarantinedReply(text) {
    appendLine('mira', `[MIRA LAB OUTPUT - GATE FAILED] ${text}`, 'mira-lab-gate-failed');
  }

  function renderPromptReply(result) {
    if (!result) return;
    const hint = result.visible_render_hint || {};
    if (hint.kind === 'clean_reply' && hint.text) {
      appendLine('mira', hint.text);
    } else if (hint.kind === 'gate_failed_quarantined' && hint.text) {
      appendQuarantinedReply(hint.text);
    } else if (hint.kind === 'blocked_banner') {
      appendBlockedBanner(hint.banner ? hint.banner.replace(/^Mira Lab reply unavailable:\s*/, '') : (result.gates && result.gates.reason_class) || 'unknown');
    } else if (result.decision === 'pass' && result.reply && result.reply.text) {
      appendLine('mira', result.reply.text);
    } else if (result.decision === 'fail' && result.raw_reply && result.raw_reply.text) {
      appendQuarantinedReply(result.raw_reply.text);
    } else {
      appendBlockedBanner((result.gates && result.gates.reason_class) || result.reason || 'unknown');
    }
  }

  function updateEvalPacket(packet) {
    const evalNode = document.getElementById('miraLabEvalPacket');
    if (!evalNode) return;
    evalNode.textContent = JSON.stringify(packet || {}, null, 2);
  }

  function maybeRevealRouting() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      if (params.get('diagnostics') === '1' || params.get('routing') === '1') {
        const routing = document.getElementById('miraLabRouting');
        if (routing) routing.hidden = false;
      }
    } catch (_e) {
      // best-effort; default-hidden routing is the intended UI
    }
  }

  function setupComposer() {
    const form = document.getElementById('miraLabComposer');
    const input = document.getElementById('miraLabInput');
    const speaker = document.getElementById('miraLabSpeaker');
    const targets = document.getElementById('miraLabTargets');
    const state = document.getElementById('miraLabState');
    if (!form || !input || !speaker) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const speakerRole = speaker.value;
      const targetAgentsValue = targetAgents(targets && targets.value);
      appendLine(speakerRole, text);
      input.value = '';
      if (state) state.textContent = 'recording transcript / diagnostics hidden';
      const expectsMiraReply = speakerRole === 'james' || speakerRole === 'architect' || speakerRole === 'builder' || speakerRole === 'oracle';
      if (expectsMiraReply) {
        // Skip TURN_CHANNEL when expecting a reply: the prompt-reply path records both the
        // prompt turn and Mira's reply turn in one transcript write. Calling both would
        // duplicate the prompt row.
        if (state) state.textContent = 'awaiting Mira reply / diagnostics hidden';
        const replyResult = await bridgeInvoke(PROMPT_REPLY_CHANNEL, {
          sessionId,
          prompt: text,
          speakerRole,
          requesterPane: speakerRole === 'james' ? null : speakerRole,
        });
        renderPromptReply(replyResult);
        if (state) {
          if (!replyResult || (replyResult.ok === false && !replyResult.decision)) {
            state.textContent = `Mira Lab reply unavailable: ${(replyResult && replyResult.reason) || 'bridge_unavailable'}`;
          } else if (replyResult.decision === 'pass') {
            state.textContent = 'Mira reply rendered / gates passed';
          } else if (replyResult.decision === 'fail') {
            state.textContent = 'Mira reply quarantined / gate failed';
          } else if (replyResult.decision === 'blocked') {
            state.textContent = `Mira Lab reply blocked: ${(replyResult.gates && replyResult.gates.reason_class) || replyResult.reason || 'unknown'}`;
          }
        }
        return;
      }
      // mira speaking out — keep existing turn-record path (no reply expected)
      const result = await bridgeInvoke(TURN_CHANNEL, {
        sessionId,
        speakerRole,
        targetAgents: targetAgentsValue,
        text,
      });
      updateEvalPacket(result.eval_packet);
      if (state) {
        state.textContent = result.ok
          ? 'transcript recorded / diagnostics hidden'
          : `lab bridge ${result.reason || 'unavailable'}`;
      }
    });
  }

  function setupField() {
    const canvas = document.getElementById('miraLabField');
    if (!canvas) return;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lowPower = (navigator.hardwareConcurrency || 8) < 8;
    if (reduced || lowPower) {
      canvas.hidden = true;
      const shell = document.getElementById('miraLabShell');
      if (shell) shell.dataset.rendering = 'low-power-static';
      return;
    }
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
      ctx.clearRect(0, 0, width, height);
      const t = frame / 90;
      const gradient = ctx.createRadialGradient(
        width * (0.52 + Math.sin(t * 0.7) * 0.08),
        height * (0.52 + Math.cos(t * 0.5) * 0.08),
        30,
        width * 0.5,
        height * 0.54,
        Math.max(width, height) * 0.72,
      );
      gradient.addColorStop(0, 'rgba(154, 240, 189, 0.26)');
      gradient.addColorStop(0.36, 'rgba(80, 170, 210, 0.12)');
      gradient.addColorStop(1, 'rgba(5, 7, 6, 0.95)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(237, 247, 243, 0.09)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 9; i += 1) {
        ctx.beginPath();
        const y = height * (0.18 + i * 0.085);
        for (let x = 0; x <= width; x += 18) {
          const wave = Math.sin((x / 120) + t + i * 0.8) * 11;
          if (x === 0) ctx.moveTo(x, y + wave);
          else ctx.lineTo(x, y + wave);
        }
        ctx.stroke();
      }
      window.requestAnimationFrame(draw);
    }
    window.addEventListener('resize', resize);
    resize();
    draw();
  }

  window.addEventListener('DOMContentLoaded', () => {
    setupField();
    maybeRevealRouting();
    setupComposer();
    bridgeInvoke(EXPORT_CHANNEL, { sessionId }).then((result) => updateEvalPacket(result.eval_packet));
  });
}());
