const crypto = require('crypto');

const DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES = (
  Number.parseInt(process.env.SQUIDRUN_INJECT_IPC_CHUNK_THRESHOLD_BYTES || '256', 10) || 256
);
const DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES = (
  Number.parseInt(process.env.SQUIDRUN_INJECT_IPC_CHUNK_SIZE_BYTES || '256', 10) || 256
);
const DEFAULT_INJECT_IPC_REASSEMBLY_TTL_MS = Math.max(
  5000,
  Number.parseInt(process.env.SQUIDRUN_INJECT_IPC_REASSEMBLY_TTL_MS || '60000', 10) || 60000
);

function getUtf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function generateChunkGroupId(prefix = 'ipcmsg') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function clampPositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function splitUtf8TextByBytes(value, maxChunkBytes = DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES) {
  const text = String(value ?? '');
  const limit = clampPositiveInt(maxChunkBytes, DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES);
  if (!text) return [''];

  const pieces = [];
  let current = '';
  let currentBytes = 0;

  for (const char of Array.from(text)) {
    const charBytes = getUtf8ByteLength(char);
    if (current && (currentBytes + charBytes) > limit) {
      pieces.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }
    current += char;
    currentBytes += charBytes;
  }

  if (current || pieces.length === 0) {
    pieces.push(current);
  }
  return pieces;
}

function buildInjectMessageIpcPackets(payload = {}, options = {}) {
  const panes = Array.isArray(payload?.panes) && payload.panes.length > 0
    ? payload.panes.map((paneId) => String(paneId))
    : [];
  const normalizedPayload = {
    ...payload,
    panes,
  };
  const text = String(payload?.message ?? '');
  const totalBytes = getUtf8ByteLength(text);
  const thresholdBytes = clampPositiveInt(
    options.chunkThresholdBytes,
    DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES
  );
  const chunkSizeBytes = clampPositiveInt(
    options.chunkSizeBytes,
    DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES
  );
  const shouldChunk = totalBytes >= thresholdBytes;
  const chunks = shouldChunk
    ? splitUtf8TextByBytes(text, chunkSizeBytes)
    : [text];

  return panes.flatMap((paneId) => {
    const groupId = shouldChunk ? generateChunkGroupId('inject') : null;
    return chunks.map((chunk, index) => {
      const chunkBytes = getUtf8ByteLength(chunk);
      return {
        ...normalizedPayload,
        panes: [paneId],
        message: chunk,
        messageBytes: chunkBytes,
        ipcChunk: shouldChunk ? {
          groupId,
          index,
          count: chunks.length,
          chunkBytes,
          totalBytes,
        } : null,
        meta: {
          ...(payload?.meta && typeof payload.meta === 'object' ? payload.meta : {}),
          ipcChunked: shouldChunk,
          ipcOriginalBytes: totalBytes,
        },
      };
    });
  });
}

module.exports = {
  DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES,
  DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES,
  DEFAULT_INJECT_IPC_REASSEMBLY_TTL_MS,
  getUtf8ByteLength,
  splitUtf8TextByBytes,
  buildInjectMessageIpcPackets,
};
