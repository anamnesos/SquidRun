(function () {
  'use strict';

  const EXPORT_CHANNEL = 'mira:lab-export';
  const PROMPT_REPLY_CHANNEL = 'mira:lab-prompt-reply';
  const RENDERER_DRIVE_CHANNEL = 'mira:lab-renderer-drive';
  const RENDERER_DRIVE_RESULT_CHANNEL = 'mira:lab-renderer-drive-result';
  const sessionId = `mira-lab-${new Date().toISOString().slice(0, 10)}`;

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

  function bridgeOn(channel, listener) {
    const api = getBridgeApi();
    const on = typeof api.on === 'function'
      ? api.on.bind(api)
      : (api.ipc && typeof api.ipc.on === 'function' ? api.ipc.on.bind(api.ipc) : null);
    if (!on) return null;
    return on(channel, listener);
  }

  function bridgeSend(channel, payload) {
    const api = getBridgeApi();
    const send = typeof api.send === 'function'
      ? api.send.bind(api)
      : (api.ipc && typeof api.ipc.send === 'function' ? api.ipc.send.bind(api.ipc) : null);
    if (!send) return false;
    send(channel, payload);
    return true;
  }

  function lineClass(role) {
    if (role === 'mira') return 'mira';
    if (['architect', 'builder', 'oracle'].includes(role)) return 'agent';
    return 'james';
  }

  function appendLine(role, text, extraClass) {
    const transcript = document.getElementById('miraLabTranscript');
    if (!transcript) return null;
    const line = document.createElement('p');
    const classes = ['mira-lab-line', lineClass(role)];
    if (extraClass) classes.push(extraClass);
    line.className = classes.join(' ');
    line.textContent = text;
    transcript.appendChild(line);
    transcript.scrollTop = transcript.scrollHeight;
    return line;
  }

  function appendBlockedBanner(reason) {
    return appendLine('mira', `Mira Lab reply unavailable: ${reason || 'unknown'}`, 'mira-lab-blocked');
  }

  function appendQuarantinedReply(text) {
    return appendLine('mira', `[MIRA LAB OUTPUT - GATE FAILED] ${text}`, 'mira-lab-gate-failed');
  }

  function renderPromptReply(result) {
    if (!result) return null;
    const hint = result.visible_render_hint || {};
    if (hint.kind === 'clean_reply' && hint.text) {
      return appendLine('mira', hint.text);
    } else if (hint.kind === 'gate_failed_quarantined' && hint.text) {
      return appendQuarantinedReply(hint.text);
    } else if (hint.kind === 'blocked_banner') {
      return appendBlockedBanner(hint.banner ? hint.banner.replace(/^Mira Lab reply unavailable:\s*/, '') : (result.gates && result.gates.reason_class) || 'unknown');
    } else if (result.decision === 'pass' && result.reply && result.reply.text) {
      return appendLine('mira', result.reply.text);
    } else if (result.decision === 'fail' && result.raw_reply && result.raw_reply.text) {
      return appendQuarantinedReply(result.raw_reply.text);
    }
    return appendBlockedBanner((result.gates && result.gates.reason_class) || result.reason || 'unknown');
  }

  function updateEvalPacket(packet) {
    const evalNode = document.getElementById('miraLabEvalPacket');
    if (!evalNode) return;
    evalNode.textContent = JSON.stringify(packet || {}, null, 2);
  }

  // Mira Lab UI is James <-> Mira ONLY. Any agent-side probe of Mira (Architect
  // only) lives outside this UI in CLI/module diagnostics (e.g.
  // ui/scripts/hm-mira-lab-prompt.js). No UI control selects or hints at agent
  // speakers; user sends always carry speakerRole='james'.
  const USER_SPEAKER_ROLE = 'james';

  function setupComposer() {
    const form = document.getElementById('miraLabComposer');
    const input = document.getElementById('miraLabInput');
    const state = document.getElementById('miraLabState');
    if (!form || !input) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      appendLine(USER_SPEAKER_ROLE, text);
      input.value = '';
      if (state) state.textContent = 'awaiting Mira reply / diagnostics hidden';
      const replyResult = await bridgeInvoke(PROMPT_REPLY_CHANNEL, {
        sessionId,
        prompt: text,
        speakerRole: USER_SPEAKER_ROLE,
        requesterPane: null,
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

  function classListSnapshot(line) {
    if (!line || !line.classList) return [];
    return Array.from(line.classList);
  }

  // External-drive entry: main process sends `mira:lab-renderer-drive` with
  // {correlationId, prompt, requesterPane, speakerRole}. We run the same
  // IPC flow the form uses, capture the actually-appended DOM line, and
  // report `rendered_text + dom_classes` back so the verifier can prove the
  // reply visibly rendered (not just that the IPC envelope existed).
  async function handleExternalDrive(payload = {}) {
    const correlationId = payload && typeof payload.correlationId === 'string' ? payload.correlationId : null;
    if (!correlationId) return;
    const prompt = String(payload.prompt || '').trim();
    const requesterPane = payload.requesterPane || null;
    const speakerRole = payload.speakerRole || USER_SPEAKER_ROLE;
    const driveSessionId = typeof payload.sessionId === 'string' && payload.sessionId
      ? payload.sessionId
      : sessionId;

    const respond = (extras) => {
      bridgeSend(RENDERER_DRIVE_RESULT_CHANNEL, { correlationId, ...extras });
    };

    if (!prompt) {
      respond({
        ok: false,
        error: 'empty_prompt',
        rendered_text: null,
        dom_classes: [],
      });
      return;
    }

    let promptLine = null;
    try {
      promptLine = appendLine(speakerRole, prompt);
    } catch (err) {
      respond({ ok: false, error: 'append_prompt_failed', error_message: err && err.message ? err.message : String(err) });
      return;
    }

    let result;
    try {
      result = await bridgeInvoke(PROMPT_REPLY_CHANNEL, {
        sessionId: driveSessionId,
        prompt,
        speakerRole,
        requesterPane,
      });
    } catch (err) {
      respond({
        ok: false,
        error: 'prompt_reply_invoke_failed',
        error_message: err && err.message ? err.message : String(err),
        prompt_line_classes: classListSnapshot(promptLine),
      });
      return;
    }

    let replyLine = null;
    try {
      replyLine = renderPromptReply(result || {});
    } catch (err) {
      respond({
        ok: false,
        error: 'render_failed',
        error_message: err && err.message ? err.message : String(err),
        envelope: result || null,
        prompt_line_classes: classListSnapshot(promptLine),
      });
      return;
    }

    const renderedText = replyLine && typeof replyLine.textContent === 'string'
      ? replyLine.textContent
      : null;
    respond({
      ok: true,
      rendered_text: renderedText,
      dom_classes: classListSnapshot(replyLine),
      prompt_line_classes: classListSnapshot(promptLine),
      decision: (result && result.decision) || null,
      gates: (result && result.gates) || null,
      reason_class: (result && result.gates && result.gates.reason_class) || null,
      requester_pane: (result && result.requester_envelope && result.requester_envelope.requester_pane) || requesterPane || null,
      requester_dispatch: (result && result.requester_dispatch) || null,
      requester_envelope: (result && result.requester_envelope) || null,
      session_id: driveSessionId,
    });
  }

  function setupExternalDriveListener() {
    bridgeOn(RENDERER_DRIVE_CHANNEL, (payload) => {
      // Fire-and-forget; respond via separate send channel keyed by correlationId.
      handleExternalDrive(payload || {});
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    setupField();
    setupComposer();
    setupExternalDriveListener();
    bridgeInvoke(EXPORT_CHANNEL, { sessionId }).then((result) => updateEvalPacket(result.eval_packet));
  });
}());
