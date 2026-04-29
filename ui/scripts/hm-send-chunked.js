#!/usr/bin/env node
'use strict';

/**
 * hm-send-chunked — wraps hm-send.js with safe chunking for long content.
 *
 * Bus-clip background: long single-message dispatches via hm-send → ws-runtime
 * → renderer-PTY have been observed to truncate at the 4096-byte boundary on
 * the receiving Claude Code pane. The proper fix is at the renderer→PTY layer
 * but requires deeper restructuring; this wrapper is a soft-fix that splits
 * any --file content > CHUNK_THRESHOLD into N sequential hm-send dispatches,
 * each tagged [PART k/N]. Receiving agent sees N short messages and reads
 * them in order without clipping.
 *
 * Usage:
 *   node hm-send-chunked.js <target> --file <path> [hm-send args...]
 *   node hm-send-chunked.js <target> --stdin [hm-send args...]
 *   node hm-send-chunked.js <target> "<text>" [hm-send args...]
 *
 * Behavior:
 *   - If body bytes <= CHUNK_THRESHOLD, single passthrough to hm-send.js.
 *   - If body bytes > CHUNK_THRESHOLD, split into roughly-equal chunks at
 *     paragraph or line boundaries, each <= CHUNK_PAYLOAD_BYTES, dispatched
 *     sequentially with [PART k/N] prefix.
 *   - Aborts the chain on first hm-send failure.
 *
 * Env:
 *   HM_SEND_CHUNK_THRESHOLD_BYTES  (default 2048)
 *   HM_SEND_CHUNK_PAYLOAD_BYTES    (default 1800; lower than threshold to
 *                                   leave headroom for envelope overhead)
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const HM_SEND = path.resolve(__dirname, 'hm-send.js');
const CHUNK_THRESHOLD = Number.parseInt(process.env.HM_SEND_CHUNK_THRESHOLD_BYTES || '2048', 10) || 2048;
const CHUNK_PAYLOAD = Number.parseInt(process.env.HM_SEND_CHUNK_PAYLOAD_BYTES || '1800', 10) || 1800;

function utf8Bytes(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8');
}

function readBody(args) {
  const fileIdx = args.findIndex((a) => a === '--file');
  if (fileIdx >= 0 && args[fileIdx + 1]) {
    const filePath = path.resolve(args[fileIdx + 1]);
    return { kind: 'file', body: fs.readFileSync(filePath, 'utf8'), filePath, fileIdx };
  }
  const stdinIdx = args.indexOf('--stdin');
  if (stdinIdx >= 0) {
    return { kind: 'stdin', body: fs.readFileSync(0, 'utf8'), stdinIdx };
  }
  // Inline message: target is args[0], message is args[1] if it's not a flag
  if (args.length >= 2 && !args[1].startsWith('--')) {
    return { kind: 'inline', body: args[1], inlineIdx: 1 };
  }
  return { kind: 'none', body: '' };
}

function splitIntoChunks(body, maxBytes) {
  // Prefer paragraph boundaries (\n\n), then single \n, then char-by-char.
  const paragraphs = body.split(/\n\n/);
  const chunks = [];
  let cur = '';
  for (const para of paragraphs) {
    const candidate = cur ? cur + '\n\n' + para : para;
    if (utf8Bytes(candidate) <= maxBytes) {
      cur = candidate;
      continue;
    }
    // candidate too big — flush cur, then handle para
    if (cur) {
      chunks.push(cur);
      cur = '';
    }
    if (utf8Bytes(para) <= maxBytes) {
      cur = para;
      continue;
    }
    // paragraph itself is too big — split by lines
    const lines = para.split('\n');
    let lineBuf = '';
    for (const line of lines) {
      const c = lineBuf ? lineBuf + '\n' + line : line;
      if (utf8Bytes(c) <= maxBytes) {
        lineBuf = c;
        continue;
      }
      if (lineBuf) {
        chunks.push(lineBuf);
        lineBuf = '';
      }
      // line itself too big — split by chars
      if (utf8Bytes(line) <= maxBytes) {
        lineBuf = line;
        continue;
      }
      let charBuf = '';
      for (const ch of line) {
        const cb = charBuf + ch;
        if (utf8Bytes(cb) <= maxBytes) {
          charBuf = cb;
          continue;
        }
        chunks.push(charBuf);
        charBuf = ch;
      }
      if (charBuf) lineBuf = charBuf;
    }
    if (lineBuf) cur = lineBuf;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function passthroughHmSend(args, stdinData = null) {
  const result = spawnSync('node', [HM_SEND, ...args], {
    encoding: 'utf8',
    input: stdinData,
    stdio: stdinData ? ['pipe', 'inherit', 'inherit'] : ['inherit', 'inherit', 'inherit'],
  });
  return result.status === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log('Usage: hm-send-chunked.js <target> --file <path> [hm-send args...]');
    console.log('   or: hm-send-chunked.js <target> "<inline text>" [hm-send args...]');
    console.log('   or: hm-send-chunked.js <target> --stdin [hm-send args...]');
    process.exit(args.length === 0 ? 1 : 0);
  }

  const target = args[0];
  const body = readBody(args);

  if (!body.body) {
    // Nothing to chunk; just passthrough.
    process.exit(passthroughHmSend(args) ? 0 : 1);
  }

  const totalBytes = utf8Bytes(body.body);
  if (totalBytes <= CHUNK_THRESHOLD) {
    process.exit(passthroughHmSend(args) ? 0 : 1);
  }

  const chunks = splitIntoChunks(body.body, CHUNK_PAYLOAD);
  console.error(`hm-send-chunked: splitting ${totalBytes} bytes into ${chunks.length} chunks (max ${CHUNK_PAYLOAD} bytes/chunk)`);

  // Build base args minus the body source flag/value so we can substitute --stdin per chunk.
  const baseArgs = [target];
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--file') { i += 1; continue; }
    if (a === '--stdin') continue;
    if (body.kind === 'inline' && i === body.inlineIdx) continue;
    baseArgs.push(a);
  }

  for (let k = 0; k < chunks.length; k += 1) {
    const partLabel = `[PART ${k + 1}/${chunks.length}]`;
    const chunkBody = `${partLabel}\n${chunks[k]}`;
    const chunkArgs = [...baseArgs, '--stdin'];
    const ok = passthroughHmSend(chunkArgs, chunkBody);
    if (!ok) {
      console.error(`hm-send-chunked: failed at chunk ${k + 1}/${chunks.length}; aborting`);
      process.exit(1);
    }
  }
  process.exit(0);
}

main();
