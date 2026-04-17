const INTERNAL_SENTINEL = '[[SR_INTERNAL]]';
const DEFAULT_PTY_VISIBILITY_HOLD_MS = Math.max(
  50,
  Number.parseInt(process.env.SQUIDRUN_PTY_VISIBILITY_HOLD_MS || '100', 10) || 100
);

function getUtf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function normalizeVisibility(value) {
  return String(value || '').trim().toLowerCase() === 'internal' ? 'internal' : 'user';
}

function splitTextByUtf8Bytes(value, targetBytes) {
  const text = String(value ?? '');
  const maxBytes = Math.max(0, Number(targetBytes) || 0);
  if (!text || maxBytes <= 0) {
    return ['', text];
  }

  let consumed = '';
  let consumedBytes = 0;
  for (const char of Array.from(text)) {
    const charBytes = getUtf8ByteLength(char);
    if ((consumedBytes + charBytes) > maxBytes) break;
    consumed += char;
    consumedBytes += charBytes;
    if (consumedBytes === maxBytes) break;
  }

  return [consumed, text.slice(consumed.length)];
}

function createPaneState() {
  return {
    segments: [],
    atLineStart: true,
    lineStartBuffer: '',
    suppressingSentinelLine: false,
  };
}

function classifyPendingBytes(segments, byteBudget, visibility) {
  let remaining = Math.max(0, Number(byteBudget) || 0);
  if (remaining <= 0) return false;

  let changed = false;
  for (let index = 0; index < segments.length && remaining > 0; index += 1) {
    const segment = segments[index];
    if (!segment || segment.visibility !== null) continue;

    if (remaining >= segment.byteLen) {
      segment.visibility = visibility;
      remaining -= segment.byteLen;
      changed = true;
      continue;
    }

    const [head, tail] = splitTextByUtf8Bytes(segment.text, remaining);
    const headBytes = getUtf8ByteLength(head);
    if (!head || headBytes <= 0) break;

    const headSegment = {
      text: head,
      byteLen: headBytes,
      arrivedAtMs: segment.arrivedAtMs,
      visibility,
    };
    const tailSegment = {
      text: tail,
      byteLen: getUtf8ByteLength(tail),
      arrivedAtMs: segment.arrivedAtMs,
      visibility: null,
    };

    segments.splice(index, 1, headSegment, tailSegment);
    remaining -= headBytes;
    changed = true;
  }

  return changed;
}

function applySentinelFilter(state, text, sentinel = INTERNAL_SENTINEL) {
  if (!text) return '';

  let output = '';
  for (const char of Array.from(String(text))) {
    if (state.suppressingSentinelLine) {
      if (char === '\n' || char === '\r') {
        state.suppressingSentinelLine = false;
        state.atLineStart = true;
        state.lineStartBuffer = '';
      }
      continue;
    }

    if (state.atLineStart) {
      state.lineStartBuffer += char;

      if (sentinel.startsWith(state.lineStartBuffer)) {
        if (state.lineStartBuffer === sentinel) {
          state.suppressingSentinelLine = true;
          state.atLineStart = false;
          state.lineStartBuffer = '';
        }
        continue;
      }

      output += state.lineStartBuffer;
      state.atLineStart = (char === '\n' || char === '\r');
      state.lineStartBuffer = '';
      continue;
    }

    output += char;
    if (char === '\n' || char === '\r') {
      state.atLineStart = true;
      state.lineStartBuffer = '';
    }
  }

  return output;
}

class PtyOutputFilter {
  constructor(options = {}) {
    this.holdMs = Math.max(
      50,
      Number.parseInt(options.holdMs ?? DEFAULT_PTY_VISIBILITY_HOLD_MS, 10) || DEFAULT_PTY_VISIBILITY_HOLD_MS
    );
    this.sentinel = String(options.sentinel || INTERNAL_SENTINEL);
    this.panes = new Map();
  }

  _getPaneState(paneId) {
    const key = String(paneId || '');
    if (!this.panes.has(key)) {
      this.panes.set(key, createPaneState());
    }
    return this.panes.get(key);
  }

  _cleanupPaneState(paneId, state) {
    if (!state) return;
    if (state.segments.length > 0) return;
    if (state.lineStartBuffer) return;
    if (state.suppressingSentinelLine) return;
    if (!state.atLineStart) return;
    this.panes.delete(String(paneId || ''));
  }

  ingest(paneId, chunk, now = Date.now()) {
    const text = String(chunk ?? '');
    if (!text) return;
    const state = this._getPaneState(paneId);
    const arrivedAtMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    state.segments.push({
      text,
      byteLen: getUtf8ByteLength(text),
      arrivedAtMs,
      visibility: null,
    });
  }

  applyKernelEvent(event, now = Date.now()) {
    if (!event || event.type !== 'pty.data.received') {
      return { paneId: null, changed: false };
    }

    const paneId = String(event.paneId || event.payload?.paneId || '').trim();
    const byteLen = Number(event.payload?.byteLen || 0);
    if (!paneId || !Number.isFinite(byteLen) || byteLen <= 0) {
      return { paneId, changed: false };
    }

    const state = this.panes.get(paneId);
    if (!state) {
      return { paneId, changed: false };
    }

    const visibility = normalizeVisibility(event.kernelMeta?.meta?.visibility);
    const changed = classifyPendingBytes(state.segments, byteLen, visibility);
    this._cleanupPaneState(paneId, state, now);
    return { paneId, changed, visibility };
  }

  releaseReady(targetPaneId = null, { now = Date.now(), force = false } = {}) {
    const paneIds = targetPaneId === null
      ? Array.from(this.panes.keys())
      : [String(targetPaneId)];
    const results = [];

    for (const paneId of paneIds) {
      const state = this.panes.get(paneId);
      if (!state) continue;

      if (force) {
        for (const segment of state.segments) {
          if (segment.visibility === null) {
            segment.visibility = 'user';
          }
        }
      } else {
        for (const segment of state.segments) {
          if (segment.visibility !== null) continue;
          if ((Number(now) - segment.arrivedAtMs) >= this.holdMs) {
            segment.visibility = 'user';
            continue;
          }
          break;
        }
      }

      let visibleText = '';
      while (state.segments.length > 0) {
        const segment = state.segments[0];
        if (!segment || segment.visibility === null) break;

        state.segments.shift();
        if (segment.visibility === 'internal') continue;
        visibleText += applySentinelFilter(state, segment.text, this.sentinel);
      }

      this._cleanupPaneState(paneId, state);
      if (visibleText) {
        results.push({ paneId, text: visibleText });
      }
    }

    return results;
  }

  getNextReleaseDelayMs(now = Date.now()) {
    let minDelay = null;

    for (const state of this.panes.values()) {
      const nextPending = state.segments.find((segment) => segment && segment.visibility === null);
      if (!nextPending) continue;

      const delay = Math.max(0, this.holdMs - (Number(now) - nextPending.arrivedAtMs));
      if (minDelay === null || delay < minDelay) {
        minDelay = delay;
      }
    }

    return minDelay;
  }

  clearPane(paneId) {
    this.panes.delete(String(paneId || ''));
  }
}

function createPtyOutputFilter(options = {}) {
  return new PtyOutputFilter(options);
}

module.exports = {
  INTERNAL_SENTINEL,
  DEFAULT_PTY_VISIBILITY_HOLD_MS,
  getUtf8ByteLength,
  splitTextByUtf8Bytes,
  createPtyOutputFilter,
  PtyOutputFilter,
};
