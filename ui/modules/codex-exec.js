/**
 * Codex exec runner (non-interactive)
 * Spawns `codex exec --json` and streams JSONL output to xterm.
 */

const { spawn } = require('child_process');

// ANSI color codes for terminal output
const ANSI = {
  RESET: '\x1b[0m',
  CYAN: '\x1b[36m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  // Thinking/reasoning styling: dim + italic for visual distinction
  DIM_ITALIC: '\x1b[2;3m',
};

// Strip Unicode bidirectional control characters that can cause RTL rendering
// Includes: LTR/RTL marks (200E-200F), embedding/override (202A-202E), isolates (2066-2069)
function stripBidiControls(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

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

  const WORKING_MARKER = `\r\n${ANSI.CYAN}[Working...]${ANSI.RESET}\r\n`;

  function emitMarker(terminal, paneId, marker, flagKey) {
    if (!terminal || terminal[flagKey]) return;
    terminal[flagKey] = true;
    broadcast({ event: 'data', paneId, data: marker });
    appendScrollback(terminal, marker);
  }

  function emitWorkingOnce(terminal, paneId) {
    emitMarker(terminal, paneId, WORKING_MARKER, 'execWorkingEmitted');
  }

  function emitDoneOnce(terminal, paneId, exitCode) {
    if (!terminal || terminal.execDoneEmitted) return;
    terminal.execDoneEmitted = true;
    const code = typeof exitCode === 'number' ? exitCode : 'unknown';
    const color = (exitCode === 0) ? ANSI.GREEN : ANSI.RED;
    const marker = `\r\n${color}[Done (exit ${code})]${ANSI.RESET}\r\n`;
    broadcast({ event: 'data', paneId, data: marker });
    appendScrollback(terminal, marker);
    // Emit done activity, then ready after delay
    emitActivity(paneId, 'done', exitCode === 0 ? 'Success' : `Exit ${code}`);
    setTimeout(() => emitActivity(paneId, 'ready'), 2000);
  }

  // Activity state emission for UI indicators
  // States: thinking, tool, command, file, streaming, done, ready
  function emitActivity(paneId, state, detail = '') {
    broadcast({ event: 'codex-activity', paneId, state, detail });
  }

  // Event types we silently ignore (metadata, lifecycle, internal)
  const SILENT_EVENT_TYPES = new Set([
    'session_meta', 'session_started', 'session_stopped',
    'message_started', 'message_completed',
    'turn_started', 'turn_completed',
    'turn.started', 'turn.completed',
    'content_block_start', 'content_block_stop',
    'input_json_delta', 'input_json',
    'ping', 'rate_limit',
  ]);

  const MAX_EVENT_DETAIL = 160;

  function normalizeDetail(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function collapseWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function truncateDetail(text, maxLen = MAX_EVENT_DETAIL) {
    const clean = collapseWhitespace(text);
    if (!clean) return '';
    if (clean.length <= maxLen) return clean;
    return `${clean.slice(0, maxLen - 3)}...`;
  }

  function ensureTrailingNewline(text) {
    if (!text) return text;
    return /[\r\n]$/.test(text) ? text : `${text}\r\n`;
  }

  function formatTaggedLine(tag, detail, color = ANSI.RESET) {
    const clean = truncateDetail(normalizeDetail(detail));
    if (!clean) return null;
    return `\r\n${color}[${tag}]${ANSI.RESET} ${clean}\r\n`;
  }

  function isStartLikeEvent(eventType) {
    return eventType.endsWith('started')
      || eventType.endsWith('.started')
      || eventType.endsWith('_started')
      || eventType === 'tool_use'
      || eventType === 'tool_call'
      || eventType === 'command';
  }

  function isCompleteLikeEvent(eventType) {
    return eventType.endsWith('completed')
      || eventType.endsWith('.completed')
      || eventType.endsWith('_completed')
      || eventType.endsWith('stopped')
      || eventType.endsWith('.stopped');
  }

  function extractCommand(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.command === 'string') return payload.command;
    if (Array.isArray(payload.command)) return payload.command.join(' ');
    if (payload.command && typeof payload.command === 'object') {
      if (typeof payload.command.command === 'string') return payload.command.command;
      if (Array.isArray(payload.command.args)) return payload.command.args.join(' ');
    }
    if (typeof payload.command_line === 'string') return payload.command_line;
    if (typeof payload.commandLine === 'string') return payload.commandLine;
    if (typeof payload.cmd === 'string') return payload.cmd;
    if (Array.isArray(payload.args)) return payload.args.join(' ');
    if (Array.isArray(payload.argv)) return payload.argv.join(' ');
    return '';
  }

  function extractToolName(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.tool_name === 'string') return payload.tool_name;
    if (typeof payload.toolName === 'string') return payload.toolName;
    if (typeof payload.name === 'string') return payload.name;
    if (typeof payload.tool === 'string') return payload.tool;
    if (payload.tool && typeof payload.tool.name === 'string') return payload.tool.name;
    if (payload.tool_call && typeof payload.tool_call.name === 'string') return payload.tool_call.name;
    if (payload.tool_call && payload.tool_call.function && typeof payload.tool_call.function.name === 'string') {
      return payload.tool_call.function.name;
    }
    if (payload.function && typeof payload.function.name === 'string') return payload.function.name;
    return '';
  }

  function extractToolDetail(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const input = payload.input || payload.arguments || payload.args || payload.params || payload.parameters;
    if (typeof input === 'string') return input;
    if (input && typeof input === 'object') {
      const query = input.query || input.q || input.search || input.text;
      if (typeof query === 'string') return query;
      return normalizeDetail(input);
    }
    return '';
  }

  function deriveFileAction(eventType, payload) {
    const raw = normalizeDetail(payload?.action || payload?.event || eventType).toLowerCase();
    if (raw.includes('delete') || raw.includes('remove')) return 'deleted';
    if (raw.includes('create') || raw.includes('new')) return 'created';
    if (raw.includes('write') || raw.includes('update') || raw.includes('edit') || raw.includes('patch') || raw.includes('modify')) {
      return 'edited';
    }
    return 'updated';
  }

  function extractFileSummary(eventType, payload) {
    if (!payload || typeof payload !== 'object') return null;
    const files = payload.files || payload.paths || payload.file_paths || payload.filePaths;
    if (Array.isArray(files) && files.length > 0) {
      const action = deriveFileAction(eventType, payload);
      if (files.length === 1) {
        return { action, target: files[0] };
      }
      return { action, target: `${files.length} files` };
    }
    const file = payload.file || payload.path || payload.filename || payload.file_path || payload.filePath;
    if (typeof file === 'string' && file) {
      const action = deriveFileAction(eventType, payload);
      return { action, target: file };
    }
    const count = payload.count || payload.fileCount || payload.filesCount;
    if (typeof count === 'number') {
      const action = deriveFileAction(eventType, payload);
      return { action, target: `${count} files` };
    }
    return null;
  }

  function formatAuxEvent(event) {
    const eventType = String(event.type || '').toLowerCase();
    const payload = event.payload || event;

    const fileSummary = extractFileSummary(eventType, payload);
    if (fileSummary) {
      return formatTaggedLine('FILE', `${fileSummary.action} ${fileSummary.target}`, ANSI.BLUE);
    }

    const isCommandEvent = eventType.includes('command');
    if (isCommandEvent) {
      if (isCompleteLikeEvent(eventType) && !isStartLikeEvent(eventType)) {
        return '';
      }
      const command = extractCommand(payload);
      if (command) {
        return formatTaggedLine('CMD', command, ANSI.YELLOW);
      }
    }

    const isToolEvent = eventType.includes('tool');
    if (isToolEvent) {
      if (isCompleteLikeEvent(eventType) && !isStartLikeEvent(eventType)) {
        return '';
      }
      const toolName = extractToolName(payload);
      const toolDetail = extractToolDetail(payload);
      if (toolName) {
        const detail = toolDetail ? `${toolName} ${toolDetail}` : toolName;
        return formatTaggedLine('TOOL', detail, ANSI.MAGENTA);
      }
    }

    return null;
  }

  // Detect if an event represents reasoning/thinking content
  // Returns: 'reasoning' | 'agent_message' | 'other'
  function getItemType(event) {
    if (!event || typeof event !== 'object') return 'other';
    const payload = event.payload || event;

    // Check item.type for Codex exec format
    const itemType = payload.item?.type || payload.type || '';
    if (itemType === 'reasoning') return 'reasoning';
    if (itemType === 'agent_message') return 'agent_message';

    // Check for delta content block types (Claude API format)
    const deltaType = payload.delta?.type || '';
    if (deltaType === 'thinking' || deltaType === 'reasoning') return 'reasoning';
    if (deltaType === 'text') return 'agent_message';

    return 'other';
  }

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
      const raw = stripBidiControls(line) + '\r\n';
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

    if (isStartEvent || isDelta) {
      emitWorkingOnce(terminal, paneId);
      if (isStartEvent) {
        emitActivity(paneId, 'thinking');
      }
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

    const auxLine = formatAuxEvent(event);
    if (auxLine !== null) {
      if (auxLine) {
        emitWorkingOnce(terminal, paneId);
        broadcast({ event: 'data', paneId, data: auxLine });
        terminal.lastActivity = Date.now();
        appendScrollback(terminal, auxLine);
        // Emit activity based on tag type
        if (auxLine.includes('[FILE]')) {
          const detail = auxLine.replace(/.*\[FILE\]\s*/, '').replace(/\r?\n/g, '').trim();
          emitActivity(paneId, 'file', detail);
        } else if (auxLine.includes('[CMD]')) {
          const detail = auxLine.replace(/.*\[CMD\]\s*/, '').replace(/\r?\n/g, '').trim();
          emitActivity(paneId, 'command', detail);
        } else if (auxLine.includes('[TOOL]')) {
          const detail = auxLine.replace(/.*\[TOOL\]\s*/, '').replace(/\r?\n/g, '').trim();
          emitActivity(paneId, 'tool', detail);
        }
      }
      return;
    }

    const text = extractCodexText(event);
    if (text === '') {
      // Silent event — suppress (metadata, lifecycle, etc.)
      logInfo(`[CodexExec] Silent event type="${event.type || 'unknown'}" for pane ${paneId}`);
      return;
    }
    if (text) {
      const sanitized = stripBidiControls(text);
      const itemType = getItemType(event);

      // Apply styling based on item type:
      // - reasoning: dim + italic for visual distinction
      // - agent_message: normal (bold could be optional)
      // - other: normal (no special styling)
      let styledText;
      if (itemType === 'reasoning') {
        // Wrap reasoning in dim+italic ANSI, reset at end
        styledText = `${ANSI.DIM_ITALIC}${sanitized}${ANSI.RESET}`;
      } else {
        styledText = sanitized;
      }

      const formatted = isDelta ? styledText : ensureTrailingNewline(styledText);
      broadcast({ event: 'data', paneId, data: formatted });
      terminal.lastActivity = Date.now();
      appendScrollback(terminal, formatted);
      // Emit streaming activity for text output
      if (isDelta) {
        emitActivity(paneId, 'streaming');
      }
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
    // Explicitly specify shell path to avoid ENOENT when ComSpec not set
    const shellPath = process.platform === 'win32'
      ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe')
      : true;
    const child = spawn('codex', execArgs, {
      cwd: workDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: shellPath,
      windowsHide: true,
    });

    terminal.execProcess = child;
    terminal.execBuffer = '';
    terminal.lastInputTime = Date.now();
    terminal.execWorkingEmitted = false;
    terminal.execDoneEmitted = false;

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

      // Detect stale session error - clear session ID and retry with fresh session
      if (errText.includes('Session not found') || errText.includes('session not found')) {
        logWarn(`[CodexExec] Stale session detected for pane ${paneId}, will retry with fresh session`);
        terminal.codexSessionId = null;
        terminal.codexHasSession = false;
        terminal.staleSessionRetry = prompt; // Store original prompt for retry
        return; // Don't display error, we'll retry
      }

      // Suppress internal Codex CLI noise (not a Hivemind error)
      if (errText.includes('state db missing rollout path')) {
        return;
      }

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
      terminal.execProcess = null;
      terminal.lastActivity = Date.now();

      // If we had a stale session error, retry with fresh session
      if (terminal.staleSessionRetry) {
        const retryPrompt = terminal.staleSessionRetry;
        terminal.staleSessionRetry = null;
        logInfo(`[CodexExec] Retrying pane ${paneId} with fresh session`);
        const retryMsg = `\r\n${ANSI.YELLOW}[Retrying with fresh session...]${ANSI.RESET}\r\n`;
        broadcast({ event: 'data', paneId, data: retryMsg });
        appendScrollback(terminal, retryMsg);
        // Small delay to ensure cleanup, then retry
        setTimeout(() => runCodexExec(paneId, terminal, retryPrompt), 100);
        return;
      }

      emitDoneOnce(terminal, paneId, code);
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
