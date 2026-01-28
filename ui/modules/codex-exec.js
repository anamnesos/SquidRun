/**
 * Codex exec runner (non-interactive)
 * Spawns `codex exec --json` and streams JSONL output to xterm.
 */

const { spawn } = require('child_process');

function createCodexExecRunner(options = {}) {
  const {
    broadcast,
    logInfo = () => {},
    logWarn = () => {},
    scrollbackMaxSize = 50000,
  } = options;

  if (typeof broadcast !== 'function') {
    throw new Error('createCodexExecRunner requires a broadcast function');
  }

  function appendScrollback(terminal, data) {
    if (!terminal) return;
    terminal.scrollback = (terminal.scrollback || '') + data;
    if (terminal.scrollback.length > scrollbackMaxSize) {
      terminal.scrollback = terminal.scrollback.slice(-scrollbackMaxSize);
    }
  }

  const WORKING_MARKER = '\r\n[Working...]\r\n';
  const COMPLETE_MARKER = '\r\n[Task complete]\r\n';

  function emitMarker(terminal, paneId, marker, flagKey) {
    if (!terminal || terminal[flagKey]) return;
    terminal[flagKey] = true;
    broadcast({ event: 'data', paneId, data: marker });
    appendScrollback(terminal, marker);
  }

  function emitWorkingOnce(terminal, paneId) {
    emitMarker(terminal, paneId, WORKING_MARKER, 'execWorkingEmitted');
  }

  function emitCompleteOnce(terminal, paneId) {
    emitMarker(terminal, paneId, COMPLETE_MARKER, 'execCompleteEmitted');
  }

  // Event types we silently ignore (metadata, lifecycle, internal)
  const SILENT_EVENT_TYPES = new Set([
    'session_meta', 'session_started', 'session_stopped',
    'message_started', 'message_completed',
    'turn_started', 'turn_completed',
    'turn.started', 'turn.completed',
    'command_started', 'command_completed',
    'tool_use_started', 'tool_use_completed',
    'content_block_start', 'content_block_stop',
    'input_json_delta', 'input_json',
    'ping', 'rate_limit',
  ]);

  function extractCodexText(event) {
    if (!event || typeof event !== 'object') return null;

    // Check top-level type for quick filtering
    const eventType = event.type || '';

    // Silently drop metadata/lifecycle events
    if (SILENT_EVENT_TYPES.has(eventType)) return '';

    const payload = event.payload || event;

    if (typeof payload === 'string') return payload;
    if (typeof payload.text === 'string') return payload.text;
    if (payload.delta && typeof payload.delta.text === 'string') return payload.delta.text;
    if (payload.text_delta && typeof payload.text_delta === 'string') return payload.text_delta;

    // Codex exec item.completed events: { type: "item.completed", item: { text: "..." } }
    if (payload.item && typeof payload.item.text === 'string') return payload.item.text;

    // item.started and item.completed without extractable text are lifecycle events - silence them
    if (eventType === 'item.started' || eventType === 'item.completed') return '';

    // Codex exec agent_message / task_complete patterns
    if (payload.output && typeof payload.output === 'string') return payload.output;
    if (payload.result && typeof payload.result === 'string') return payload.result;

    const content = payload.content || payload.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const block of content) {
        if (block && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (block && typeof block.content === 'string') {
          parts.push(block.content);
        } else if (block && block.content && typeof block.content.text === 'string') {
          parts.push(block.content.text);
        }
      }
      if (parts.length > 0) return parts.join('');
    }

    return null;
  }

  function handleCodexExecLine(paneId, terminal, line) {
    if (!line) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      const raw = line + '\r\n';
      broadcast({ event: 'data', paneId, data: raw });
      terminal.lastActivity = Date.now();
      appendScrollback(terminal, raw);
      return;
    }

    const eventType = event.type || '';
    const isDelta = eventType === 'content_block_delta'
      || eventType === 'response.output_text.delta';
    const isStartEvent = eventType === 'thread.started'
      || eventType === 'message_started'
      || eventType === 'turn_started'
      || eventType === 'turn.started'
      || eventType === 'response.started'
      || eventType === 'item.started';
    const isCompleteEvent = eventType === 'message_completed'
      || eventType === 'turn_completed'
      || eventType === 'turn.completed'
      || eventType === 'response.completed'
      || eventType === 'item.completed';

    if (isStartEvent || isDelta) {
      emitWorkingOnce(terminal, paneId);
    }
    if (isCompleteEvent) {
      emitCompleteOnce(terminal, paneId);
    }

    if (event.type === 'session_meta' && event.payload && event.payload.id) {
      terminal.codexSessionId = event.payload.id;
      terminal.codexHasSession = true;
      logInfo(`[CodexExec] Captured session id for pane ${paneId}`);
      return;
    }

    // Codex exec uses thread.started with thread_id
    if (event.type === 'thread.started' && event.thread_id) {
      terminal.codexSessionId = event.thread_id;
      terminal.codexHasSession = true;
      logInfo(`[CodexExec] Captured thread id for pane ${paneId}: ${event.thread_id}`);
      return;
    }

    const text = extractCodexText(event);
    if (text === '') {
      // Silent event — suppress (metadata, lifecycle, etc.)
      logInfo(`[CodexExec] Silent event type="${event.type || 'unknown'}" for pane ${paneId}`);
      return;
    }
    if (text) {
      const formatted = isDelta ? text : `${text}\r\n`;
      broadcast({ event: 'data', paneId, data: formatted });
      terminal.lastActivity = Date.now();
      appendScrollback(terminal, formatted);
    } else {
      // Unknown event type — log it quietly instead of dumping raw JSON
      logWarn(`[CodexExec] Unhandled event type="${event.type || 'unknown'}" for pane ${paneId}`);
    }
  }

  function runCodexExec(paneId, terminal, prompt) {
    if (!terminal || !terminal.alive) {
      return { success: false, error: 'Terminal not found or not alive' };
    }

    if (terminal.mode !== 'codex-exec') {
      return { success: false, error: 'Codex exec not enabled for this pane' };
    }

    if (terminal.execProcess) {
      const busyMsg = '\r\n[Codex exec busy - wait for current run to finish]\r\n';
      broadcast({ event: 'data', paneId, data: busyMsg });
      appendScrollback(terminal, busyMsg);
      return { success: false, error: 'Codex exec already running' };
    }

    const workDir = terminal.cwd || process.cwd();
    const execArgs = terminal.codexSessionId
      ? ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', 'resume', terminal.codexSessionId, '-']
      : ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--cd', workDir, '-'];

    logInfo(`[CodexExec] Spawning for pane ${paneId} (cwd: ${workDir})`);
    const child = spawn('codex', execArgs, {
      cwd: workDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    });

    terminal.execProcess = child;
    terminal.execBuffer = '';
    terminal.lastInputTime = Date.now();
    terminal.execWorkingEmitted = false;
    terminal.execCompleteEmitted = false;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      terminal.execBuffer += text;
      const lines = terminal.execBuffer.split(/\r?\n/);
      terminal.execBuffer = lines.pop() || '';
      for (const line of lines) {
        handleCodexExecLine(paneId, terminal, line.trim());
      }
    });

    child.stderr.on('data', (chunk) => {
      const errText = chunk.toString();
      const msg = `\r\n[Codex exec stderr] ${errText}\r\n`;
      broadcast({ event: 'data', paneId, data: msg });
      appendScrollback(terminal, msg);
    });

    child.on('error', (err) => {
      terminal.execProcess = null;
      const msg = `\r\n[Codex exec error] ${err.message}\r\n`;
      broadcast({ event: 'data', paneId, data: msg });
      appendScrollback(terminal, msg);
    });

    child.on('close', (code) => {
      if (terminal.execBuffer && terminal.execBuffer.trim()) {
        handleCodexExecLine(paneId, terminal, terminal.execBuffer.trim());
        terminal.execBuffer = '';
      }
      if (terminal.execProcess) {
        emitCompleteOnce(terminal, paneId);
      }
      terminal.execProcess = null;
      terminal.lastActivity = Date.now();
      const exitMsg = `\r\n[Codex exec exited ${code}]\r\n`;
      broadcast({ event: 'data', paneId, data: exitMsg });
      appendScrollback(terminal, exitMsg);
    });

    const payload = typeof prompt === 'string' ? prompt : '';
    child.stdin.write(payload);
    if (!payload.endsWith('\n')) {
      child.stdin.write('\n');
    }
    child.stdin.end();

    return { success: true };
  }

  return { runCodexExec };
}

module.exports = { createCodexExecRunner };
