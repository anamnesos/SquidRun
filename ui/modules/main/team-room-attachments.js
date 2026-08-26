'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalPathContains,
  canonicalizePathIdentity,
} = require('../canonical-path');

const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_PREVIEW_PIXELS = 40 * 1024 * 1024;
const MAX_PREVIEW_DIMENSION = 16_384;
const MAX_PREVIEW_FRAMES = 1;

const MIME_ALIASES = Object.freeze({
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/heif-sequence': 'image/heif',
  'image/heic-sequence': 'image/heic',
});

function cleanMime(value) {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return MIME_ALIASES[mime] || mime;
}

function sanitizeAttachmentName(value) {
  const base = path.basename(String(value || 'attachment'))
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[<>:"/\\|?*]/gu, '_')
    .trim();
  const safe = base.replace(/^\.+/u, '').slice(0, 180);
  return safe || 'attachment';
}

function resolveSafeExistingFile(rootPath, candidatePath) {
  const candidateLexical = path.resolve(String(candidatePath || ''));
  const parsedCandidate = path.parse(candidateLexical);
  let lexicalCursor = parsedCandidate.root;
  const lexicalParts = candidateLexical.slice(parsedCandidate.root.length)
    .split(path.sep)
    .filter(Boolean);
  for (const part of lexicalParts) {
    lexicalCursor = path.join(lexicalCursor, part);
    try {
      if (fs.lstatSync(lexicalCursor).isSymbolicLink()) {
        return { ok: false, reason: 'attachment_symlink_forbidden' };
      }
    } catch {
      break;
    }
  }

  const resolvedRoot = canonicalizePathIdentity(String(rootPath || ''), { allowMissing: true });
  const resolvedCandidate = canonicalizePathIdentity(String(candidatePath || ''), { allowMissing: true });
  if (!rootPath || !candidatePath || !resolvedRoot || !resolvedCandidate
      || !canonicalPathContains(resolvedRoot, resolvedCandidate, {
        allowEqual: false,
        allowMissing: true,
      })) {
    return { ok: false, reason: 'attachment_path_outside_root' };
  }

  try {
    const rootLstat = fs.lstatSync(resolvedRoot);
    if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
      return { ok: false, reason: 'attachment_root_unsafe' };
    }
    const rootReal = fs.realpathSync.native(resolvedRoot);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    let cursor = resolvedRoot;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      const item = fs.lstatSync(cursor);
      if (item.isSymbolicLink()) return { ok: false, reason: 'attachment_symlink_forbidden' };
    }
    const candidateReal = fs.realpathSync.native(resolvedCandidate);
    if (!canonicalPathContains(rootReal, candidateReal, {
      allowEqual: false,
      allowMissing: false,
    })) {
      return { ok: false, reason: 'attachment_real_path_outside_root' };
    }
    const stat = fs.statSync(candidateReal);
    if (!stat.isFile()) return { ok: false, reason: 'attachment_not_regular_file' };
    return { ok: true, rootPath: rootReal, filePath: candidateReal, stat };
  } catch (err) {
    return { ok: false, reason: 'attachment_path_unreadable', details: err.message };
  }
}

function detectMimeFromMagic(header) {
  if (!Buffer.isBuffer(header)) return null;
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (header.length >= 6 && ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (header.length >= 5 && header.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = header.subarray(8, 12).toString('ascii').toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
  }
  return null;
}

function hashAndReadHeader(filePath) {
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let header = Buffer.alloc(0);
  let bytes = 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    while (true) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const current = chunk.subarray(0, read);
      if (header.length < 32) header = Buffer.concat([header, current.subarray(0, 32 - header.length)]);
      hash.update(current);
      bytes += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes, header };
}

function inspectAttachmentFile(options = {}) {
  const safe = resolveSafeExistingFile(options.rootPath, options.filePath);
  if (!safe.ok) return safe;
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_ATTACHMENT_BYTES);
  if (safe.stat.size <= 0) return { ok: false, reason: 'attachment_empty' };
  if (safe.stat.size > maxBytes) return { ok: false, reason: 'attachment_too_large', bytes: safe.stat.size, maxBytes };

  let measured;
  try {
    measured = hashAndReadHeader(safe.filePath);
  } catch (err) {
    return { ok: false, reason: 'attachment_read_failed', details: err.message };
  }
  if (measured.bytes !== safe.stat.size) {
    return { ok: false, reason: 'attachment_changed_during_read' };
  }
  const mimeType = detectMimeFromMagic(measured.header);
  if (!mimeType) return { ok: false, reason: 'attachment_magic_unsupported' };

  const claimedMime = cleanMime(options.claimedMime);
  if (claimedMime && claimedMime !== mimeType) {
    return { ok: false, reason: 'attachment_mime_mismatch', detectedMime: mimeType, claimedMime };
  }
  const expectedBytes = options.expectedBytes === undefined ? null : Number(options.expectedBytes);
  if (expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes !== measured.bytes)) {
    return { ok: false, reason: 'attachment_byte_count_mismatch', expectedBytes, actualBytes: measured.bytes };
  }
  const expectedSha256 = String(options.expectedSha256 || '').trim().toLowerCase();
  if (expectedSha256 && (!/^[a-f0-9]{64}$/u.test(expectedSha256) || expectedSha256 !== measured.sha256)) {
    return { ok: false, reason: 'attachment_hash_mismatch', expectedSha256, actualSha256: measured.sha256 };
  }

  return {
    ok: true,
    filePath: safe.filePath,
    relativePath: path.relative(safe.rootPath, safe.filePath).split(path.sep).join('/'),
    bytes: measured.bytes,
    sha256: measured.sha256,
    mimeType,
    originalName: sanitizeAttachmentName(options.originalName || path.basename(safe.filePath)),
  };
}

function buildContentAddressedRelativePath(sha256, originalName) {
  const digest = String(sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('attachment_sha256_invalid');
  const safeName = sanitizeAttachmentName(originalName);
  return path.posix.join('objects', digest.slice(0, 2), digest.slice(2, 4), `${digest}-${safeName}`);
}

function buildContentAddressedOriginalRelativePath(sha256) {
  const digest = String(sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('attachment_sha256_invalid');
  return digest;
}

function buildPreviewRelativePath(sha256) {
  const digest = String(sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('attachment_sha256_invalid');
  return path.posix.join('previews', `${digest}.webp`);
}

function validatePreviewMetadata(metadata = {}, options = {}) {
  const maxPixels = Math.max(1, Number(options.maxPixels) || MAX_PREVIEW_PIXELS);
  const maxDimension = Math.max(1, Number(options.maxDimension) || MAX_PREVIEW_DIMENSION);
  const maxFrames = Math.max(1, Number(options.maxFrames) || MAX_PREVIEW_FRAMES);
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const frames = Math.max(1, Number(metadata.pages) || 1);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: 'attachment_preview_dimensions_invalid' };
  }
  if (width > maxDimension || height > maxDimension) {
    return { ok: false, reason: 'attachment_preview_dimension_limit', width, height, maxDimension };
  }
  if (width * height > maxPixels) {
    return { ok: false, reason: 'attachment_preview_pixel_limit', width, height, maxPixels };
  }
  if (frames > maxFrames) {
    return { ok: false, reason: 'attachment_preview_frame_limit', frames, maxFrames };
  }
  return { ok: true, width, height, frames };
}

module.exports = {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  MAX_PREVIEW_DIMENSION,
  MAX_PREVIEW_FRAMES,
  MAX_PREVIEW_PIXELS,
  buildContentAddressedOriginalRelativePath,
  buildContentAddressedRelativePath,
  buildPreviewRelativePath,
  cleanMime,
  detectMimeFromMagic,
  inspectAttachmentFile,
  resolveSafeExistingFile,
  sanitizeAttachmentName,
  validatePreviewMetadata,
};
