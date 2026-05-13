'use strict';

const fs = require('fs');
const path = require('path');

const MIRA_VISUAL_ASSET_CURIOSITY_SCHEMA = 'squidrun.mira.visual_asset_curiosity_read_v0';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeRelativePath(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

function defaultVisualAssetRoots(projectRoot) {
  return [
    { bucket: 'screenshots', dir: path.join(projectRoot, '.squidrun', 'screenshots') },
    { bucket: 'generated_images', dir: path.join(projectRoot, 'workspace', 'generated-images') },
  ];
}

function readPngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readGifDimensions(buffer) {
  if (!buffer || buffer.length < 10) return null;
  const header = buffer.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function readWebpDimensions(buffer) {
  if (!buffer || buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function readImageDimensions(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.svg') {
    const text = fs.readFileSync(filePath, 'utf8').slice(0, 2000);
    const width = Number((text.match(/\bwidth=["']?([0-9.]+)/i) || [])[1]);
    const height = Number((text.match(/\bheight=["']?([0-9.]+)/i) || [])[1]);
    if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
    const viewBox = text.match(/\bviewBox=["'][^"']*?([0-9.]+)\s+([0-9.]+)["']/i);
    if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
    return null;
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const bytes = fs.readSync(fd, buffer, 0, 64, 0);
    const slice = buffer.slice(0, bytes);
    return readPngDimensions(slice) || readGifDimensions(slice) || readWebpDimensions(slice);
  } finally {
    fs.closeSync(fd);
  }
}

function aspectRatioLabel(width, height) {
  const numericWidth = Number(width);
  const numericHeight = Number(height);
  if (!Number.isFinite(numericWidth) || !Number.isFinite(numericHeight) || numericWidth <= 0 || numericHeight <= 0) return null;
  const ratio = numericWidth / numericHeight;
  if (ratio > 1.15) return 'landscape';
  if (ratio < 0.87) return 'portrait';
  return 'square_or_near_square';
}

function buildLatestAssetFollowup(latestAsset) {
  if (!latestAsset) return null;
  const dimensions = latestAsset.width && latestAsset.height
    ? `${latestAsset.width}x${latestAsset.height}`
    : 'unknown dimensions';
  return {
    path: latestAsset.path,
    name: latestAsset.name,
    source_bucket: latestAsset.source_bucket,
    ext: latestAsset.ext,
    size_bytes: latestAsset.size_bytes,
    width: latestAsset.width,
    height: latestAsset.height,
    aspect_hint: aspectRatioLabel(latestAsset.width, latestAsset.height),
    suggested_question: `What changed in latest visual asset ${latestAsset.path} (${dimensions}) that Mira should ask about before deciding whether visual understanding is needed?`,
    possible_action: 'Use compact file metadata as the first visual-context signal; if the answer depends on visible content, route a separate reviewed visual-understanding step.',
    visual_understanding_step: {
      status: 'separate_explicit_step_required',
      image_ocr_performed: false,
      image_model_performed: false,
      file_write_performed: false,
      external_send_performed: false,
    },
  };
}

function normalizeVisualRoots(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const raw = options.visualRoots || payload.visualRoots || payload.roots;
  if (raw) {
    return asArray(raw).map((entry, index) => {
      if (entry && typeof entry === 'object') {
        return {
          bucket: trimText(entry.bucket || entry.source || `visual_${index + 1}`) || `visual_${index + 1}`,
          dir: path.resolve(projectRoot, trimText(entry.dir || entry.path || entry.root)),
        };
      }
      return { bucket: `visual_${index + 1}`, dir: path.resolve(projectRoot, trimText(entry)) };
    }).filter((entry) => entry.dir);
  }
  return defaultVisualAssetRoots(projectRoot);
}

function collectVisualFiles(projectRoot, roots, limit) {
  const files = [];
  for (const root of roots) {
    if (!root.dir || !fs.existsSync(root.dir)) continue;
    const stack = [root.dir];
    while (stack.length > 0 && files.length < limit * 5) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!/node_modules|\.git|private-overlays/i.test(entry.name)) stack.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const stat = fs.statSync(fullPath);
          files.push({
            bucket: root.bucket,
            path: fullPath,
            name: entry.name,
            ext: path.extname(entry.name).toLowerCase(),
            size: stat.size,
            modifiedMs: stat.mtimeMs,
            modified: stat.mtime.toISOString(),
          });
        } catch {}
      }
    }
  }
  return files
    .sort((left, right) => right.modifiedMs - left.modifiedMs || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function readMiraVisualAssetCuriosity(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const roots = normalizeVisualRoots(payload, { ...options, projectRoot });
  const limit = Math.max(1, Math.min(80, Number(payload.limit || options.limit || 24) || 24));
  const files = collectVisualFiles(projectRoot, roots, limit);
  if (files.length === 0) {
    return {
      schema: MIRA_VISUAL_ASSET_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: 'visual_assets_missing',
      checked_roots: roots.map((root) => ({ bucket: root.bucket, exists: fs.existsSync(root.dir) })),
      result_count: 0,
      results: [],
      no_mutation_performed: true,
    };
  }

  const results = files.map((file) => {
    let dimensions = null;
    try {
      dimensions = readImageDimensions(file.path);
    } catch {}
    return {
      source_bucket: file.bucket,
      path: safeRelativePath(projectRoot, file.path),
      name: file.name,
      ext: file.ext,
      modified_at: file.modified,
      size_bytes: file.size,
      width: dimensions?.width || null,
      height: dimensions?.height || null,
    };
  }).filter((entry) => entry.path);
  const buckets = results.reduce((acc, entry) => {
    acc[entry.source_bucket] = (acc[entry.source_bucket] || 0) + 1;
    return acc;
  }, {});
  const extension_counts = results.reduce((acc, entry) => {
    acc[entry.ext] = (acc[entry.ext] || 0) + 1;
    return acc;
  }, {});
  const latestAsset = results[0] || null;

  return {
    schema: MIRA_VISUAL_ASSET_CURIOSITY_SCHEMA,
    ok: true,
    decision: 'visual_assets_read_only',
    result_count: results.length,
    buckets,
    extension_counts,
    latest_asset: latestAsset,
    latest_asset_followup: buildLatestAssetFollowup(latestAsset),
    results,
    no_mutation_performed: true,
    consequence_controls: {
      internal_only: true,
      read_only: true,
      image_ocr_performed: false,
      image_model_performed: false,
      file_write_performed: false,
      external_send_performed: false,
    },
  };
}

module.exports = {
  MIRA_VISUAL_ASSET_CURIOSITY_SCHEMA,
  defaultVisualAssetRoots,
  readImageDimensions,
  readMiraVisualAssetCuriosity,
};
