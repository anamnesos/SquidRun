'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const Busboy = require('busboy');
const sharp = require('sharp');
const {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  MAX_PREVIEW_DIMENSION,
  MAX_PREVIEW_FRAMES,
  MAX_PREVIEW_PIXELS,
  buildContentAddressedOriginalRelativePath,
  buildPreviewRelativePath,
  inspectAttachmentFile,
  resolveSafeExistingFile,
  sanitizeAttachmentName,
  validatePreviewMetadata,
} = require('./team-room-attachments');

const DEFAULT_PREVIEW_EDGE = 1_600;
const UPLOAD_OVERHEAD_BYTES = 256 * 1024;
const CLEANUP_RETRY_DELAYS_MS = Object.freeze([0, 20, 80, 200]);
const RECOVERABLE_TEMP_NAME_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:upload|preview\.webp)$/iu;

function comparablePath(value) {
  const resolved = path.resolve(String(value || '')).replace(/^\\\\\?\\/u, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function errorReason(error, fallback) {
  return String(error?.message || fallback || 'room_upload_failed').slice(0, 1_000);
}

function isImageMime(mimeType) {
  return String(mimeType || '').startsWith('image/');
}

function isHeicMime(mimeType) {
  return ['image/heic', 'image/heif'].includes(String(mimeType || ''));
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function sameFileSnapshot(left, right) {
  if (!left || !right) return false;
  return Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && left.isFile()
    && right.isFile();
}

async function settleWithin(promise, timeoutMs) {
  let timer = null;
  try {
    await Promise.race([
      Promise.allSettled([promise]),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class TeamRoomUploadManager {
  constructor(options = {}) {
    if (!options.store) throw new Error('team_room_upload_store_required');
    this.store = options.store;
    this.attachmentRoot = path.resolve(options.attachmentRoot || this.store.attachmentRoot);
    const trustedRoot = options.trustedRoot
      || this.store.trustedRoot;
    if (!trustedRoot) throw new Error('team_room_upload_trusted_root_required');
    this.trustedRoot = path.resolve(trustedRoot);
    this.maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_ATTACHMENT_BYTES);
    this.maxPreviewPixels = Math.max(1, Number(options.maxPreviewPixels) || MAX_PREVIEW_PIXELS);
    this.maxPreviewDimension = Math.max(1, Number(options.maxPreviewDimension) || MAX_PREVIEW_DIMENSION);
    this.maxPreviewFrames = Math.max(1, Number(options.maxPreviewFrames) || MAX_PREVIEW_FRAMES);
    this.previewEdge = Math.max(256, Number(options.previewEdge) || DEFAULT_PREVIEW_EDGE);
    this.randomUUID = typeof options.randomUUID === 'function' ? options.randomUUID : crypto.randomUUID;
    this.busboyFactory = typeof options.busboyFactory === 'function' ? options.busboyFactory : (config) => Busboy(config);
    this.sharpFactory = typeof options.sharpFactory === 'function' ? options.sharpFactory : sharp;
    this.hooks = options.hooks && typeof options.hooks === 'object' ? options.hooks : {};
    this.ownedTemporaryPaths = options.ownedTemporaryPaths instanceof Set
      ? options.ownedTemporaryPaths
      : new Set();
    this.temporaryPathOwners = new Map();
    this.activeUploadTokens = new Set();
  }

  _verifiedAttachmentRoot() {
    const trustedRoot = path.resolve(this.trustedRoot);
    const attachmentRoot = path.resolve(this.attachmentRoot);
    const relativePath = path.relative(trustedRoot, attachmentRoot);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      return { ok: false, reason: 'room_upload_attachment_root_outside_trusted_root' };
    }
    const components = relativePath ? relativePath.split(path.sep).filter(Boolean) : [];
    let currentPath = trustedRoot;
    for (let index = 0; index <= components.length; index += 1) {
      if (index > 0) currentPath = path.join(currentPath, components[index - 1]);
      let currentStat;
      try {
        currentStat = fs.lstatSync(currentPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return { ok: true, absent: true, path: attachmentRoot, realPath: null };
        }
        return { ok: false, reason: `room_upload_storage_path_unavailable:${errorReason(error)}` };
      }
      if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
        return {
          ok: false,
          reason: index === components.length
            ? 'room_upload_attachment_root_reparse_forbidden'
            : 'room_upload_storage_path_reparse_forbidden',
        };
      }
    }
    try {
      const realTrustedRoot = fs.realpathSync.native(trustedRoot);
      const realAttachmentRoot = fs.realpathSync.native(attachmentRoot);
      const expectedAttachmentRoot = path.resolve(realTrustedRoot, ...components);
      if (comparablePath(realAttachmentRoot) !== comparablePath(expectedAttachmentRoot)) {
        return { ok: false, reason: 'room_upload_attachment_root_outside_trusted_root' };
      }
      return {
        ok: true,
        absent: false,
        path: attachmentRoot,
        realPath: realAttachmentRoot,
        realTrustedRoot,
      };
    } catch (error) {
      return { ok: false, reason: `room_upload_attachment_root_verify_failed:${errorReason(error)}` };
    }
  }

  _stagingPath(suffix, ownerToken = null) {
    const verifiedRoot = this._verifiedStagingRoot({ create: true });
    if (!verifiedRoot.ok) throw new Error(verifiedRoot.reason);
    const filePath = path.join(verifiedRoot.realPath, `${this.randomUUID()}${suffix}`);
    this.ownedTemporaryPaths.add(filePath);
    this.temporaryPathOwners.set(filePath, ownerToken);
    return filePath;
  }

  _verifiedStagingRoot(options = {}) {
    const attachmentRoot = path.resolve(this.attachmentRoot);
    const stagingRoot = path.join(attachmentRoot, '.staging');
    const verifiedAttachment = this._verifiedAttachmentRoot();
    if (!verifiedAttachment.ok) return verifiedAttachment;
    if (verifiedAttachment.absent || !verifiedAttachment.realPath) {
      return options.create === true
        ? { ok: false, reason: 'room_upload_attachment_root_unavailable' }
        : { ok: true, absent: true, path: stagingRoot, realPath: null };
    }
    const canonicalStagingRoot = path.join(verifiedAttachment.realPath, '.staging');
    let stagingStat;
    try {
      stagingStat = fs.lstatSync(canonicalStagingRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { ok: false, reason: `room_upload_staging_root_unavailable:${errorReason(error)}` };
      }
      if (options.create !== true) return { ok: true, absent: true, path: stagingRoot, realPath: null };
      try {
        fs.mkdirSync(canonicalStagingRoot, { recursive: false, mode: 0o700 });
        stagingStat = fs.lstatSync(canonicalStagingRoot);
      } catch (createError) {
        return { ok: false, reason: `room_upload_staging_root_create_failed:${errorReason(createError)}` };
      }
    }
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
      return { ok: false, reason: 'room_upload_staging_root_reparse_forbidden' };
    }
    try {
      const recheckedAttachment = this._verifiedAttachmentRoot();
      if (!recheckedAttachment.ok || recheckedAttachment.absent || !recheckedAttachment.realPath) {
        return recheckedAttachment.ok
          ? { ok: false, reason: 'room_upload_attachment_root_unavailable' }
          : recheckedAttachment;
      }
      const recheckedCanonicalStagingRoot = path.join(recheckedAttachment.realPath, '.staging');
      const recheckedStaging = fs.lstatSync(recheckedCanonicalStagingRoot);
      if (recheckedStaging.isSymbolicLink() || !recheckedStaging.isDirectory()) {
        return { ok: false, reason: 'room_upload_staging_root_reparse_forbidden' };
      }
      const realStagingRoot = fs.realpathSync.native(recheckedCanonicalStagingRoot);
      if (comparablePath(realStagingRoot) !== comparablePath(recheckedCanonicalStagingRoot)) {
        return { ok: false, reason: 'room_upload_staging_root_outside_attachment_root' };
      }
      return { ok: true, absent: false, path: stagingRoot, realPath: realStagingRoot };
    } catch (error) {
      return { ok: false, reason: `room_upload_staging_root_verify_failed:${errorReason(error)}` };
    }
  }

  _verifiedCleanupTarget(filePath) {
    const verifiedRoot = this._verifiedStagingRoot();
    if (!verifiedRoot.ok) return verifiedRoot;
    if (verifiedRoot.absent || !verifiedRoot.realPath) {
      return { ok: false, reason: 'room_upload_staging_root_missing' };
    }
    const resolvedPath = path.resolve(String(filePath || ''));
    if (comparablePath(path.dirname(resolvedPath)) !== comparablePath(verifiedRoot.realPath)
      || !RECOVERABLE_TEMP_NAME_PATTERN.test(path.basename(resolvedPath))) {
      return { ok: false, reason: 'room_upload_temp_target_outside_staging_root' };
    }
    let targetStat;
    try {
      targetStat = fs.lstatSync(resolvedPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, absent: true, realPath: resolvedPath };
      return { ok: false, reason: `room_upload_temp_target_verify_failed:${errorReason(error)}` };
    }
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      return { ok: false, reason: 'room_upload_temp_target_reparse_forbidden' };
    }
    try {
      const realTarget = fs.realpathSync.native(resolvedPath);
      const recheckedRoot = this._verifiedStagingRoot();
      if (!recheckedRoot.ok || recheckedRoot.absent || !recheckedRoot.realPath) {
        return recheckedRoot.ok
          ? { ok: false, reason: 'room_upload_staging_root_missing' }
          : recheckedRoot;
      }
      if (comparablePath(recheckedRoot.realPath) !== comparablePath(verifiedRoot.realPath)
        || comparablePath(path.dirname(realTarget)) !== comparablePath(recheckedRoot.realPath)) {
        return { ok: false, reason: 'room_upload_temp_target_outside_staging_root' };
      }
      const recheckedTarget = fs.lstatSync(realTarget);
      if (recheckedTarget.isSymbolicLink() || !recheckedTarget.isFile()) {
        return { ok: false, reason: 'room_upload_temp_target_reparse_forbidden' };
      }
      return { ok: true, absent: false, realPath: realTarget };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, absent: true, realPath: resolvedPath };
      return { ok: false, reason: `room_upload_temp_target_verify_failed:${errorReason(error)}` };
    }
  }

  async _cleanupExactPath(filePath) {
    if (!filePath) return { ok: true };
    let lastError = null;
    for (const waitMs of CLEANUP_RETRY_DELAYS_MS) {
      await delay(waitMs);
      const verifiedTarget = this._verifiedCleanupTarget(filePath);
      if (verifiedTarget.ok && verifiedTarget.absent) {
        this.ownedTemporaryPaths.delete(filePath);
        this.temporaryPathOwners.delete(filePath);
        return { ok: true };
      }
      if (!verifiedTarget.ok) {
        lastError = new Error(verifiedTarget.reason);
        continue;
      }
      try {
        fs.unlinkSync(verifiedTarget.realPath);
        this.ownedTemporaryPaths.delete(filePath);
        this.temporaryPathOwners.delete(filePath);
        return { ok: true };
      } catch (error) {
        if (error?.code === 'ENOENT') {
          this.ownedTemporaryPaths.delete(filePath);
          this.temporaryPathOwners.delete(filePath);
          return { ok: true };
        }
        lastError = error;
      }
    }
    return { ok: false, reason: errorReason(lastError, 'room_upload_temp_cleanup_failed') };
  }

  async cleanupOwnedTemporaryPaths() {
    const failures = [];
    for (const filePath of [...this.ownedTemporaryPaths]) {
      const cleaned = await this._cleanupExactPath(filePath);
      if (!cleaned.ok) failures.push(`${filePath}:${cleaned.reason}`);
    }
    return failures.length === 0
      ? { ok: true }
      : { ok: false, reason: `room_upload_temp_cleanup_pending:${failures.join('|')}` };
  }

  async recoverStaleTemporaryPaths() {
    const verifiedRoot = this._verifiedStagingRoot();
    if (!verifiedRoot.ok) return verifiedRoot;
    if (verifiedRoot.absent) return { ok: true };
    const stagingRoot = verifiedRoot.realPath;
    let entries = [];
    try { entries = fs.readdirSync(stagingRoot, { withFileTypes: true }); } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, reason: `room_upload_temp_recovery_failed:${errorReason(error)}` };
    }
    for (const entry of entries) {
      if (!entry.isFile() || !RECOVERABLE_TEMP_NAME_PATTERN.test(entry.name)) continue;
      const filePath = path.join(stagingRoot, entry.name);
      this.ownedTemporaryPaths.add(filePath);
      this.temporaryPathOwners.set(filePath, null);
    }
    return this.cleanupOwnedTemporaryPaths();
  }

  async _cleanupTemporaryPathsForToken(ownerToken) {
    const results = [];
    for (const [filePath, token] of [...this.temporaryPathOwners.entries()]) {
      if (token === ownerToken) results.push(await this._cleanupExactPath(filePath));
    }
    const failed = results.find((result) => !result.ok);
    return failed || { ok: true };
  }

  async _cleanupInactiveTemporaryPaths() {
    const results = [];
    for (const [filePath, ownerToken] of [...this.temporaryPathOwners.entries()]) {
      if (!this.activeUploadTokens.has(ownerToken)) results.push(await this._cleanupExactPath(filePath));
    }
    const failed = results.find((result) => !result.ok);
    return failed || { ok: true };
  }

  async _buildPreview(stagedPath, inspection, ownerToken) {
    if (!isImageMime(inspection.mimeType)) {
      return { ok: true, status: 'not_applicable', width: null, height: null, previewPath: null };
    }

    let previewInput;
    try {
      previewInput = fs.readFileSync(stagedPath);
    } catch (error) {
      return {
        ok: true,
        status: 'unavailable',
        reason: `attachment_preview_source_read_failed:${errorReason(error)}`,
        width: null,
        height: null,
        previewPath: null,
      };
    }

    let metadata;
    let metadataPipeline = null;
    try {
      metadataPipeline = this.sharpFactory(previewInput, {
        failOn: 'warning',
        limitInputPixels: this.maxPreviewPixels,
        pages: 1,
      });
      metadata = await metadataPipeline.metadata();
    } catch (error) {
      const reason = errorReason(error);
      if (/pixel limit|exceeds.*pixel/iu.test(reason)) {
        return {
          ok: true,
          status: 'blocked',
          reason: 'attachment_preview_pixel_limit',
          width: null,
          height: null,
          previewPath: null,
        };
      }
      if (isHeicMime(inspection.mimeType)) {
        return {
          ok: true,
          status: 'unavailable',
          reason: 'attachment_heic_preview_decoder_unavailable',
          width: null,
          height: null,
          previewPath: null,
        };
      }
      return {
        ok: true,
        status: 'unavailable',
        reason: `attachment_preview_decode_failed:${reason}`,
        width: null,
        height: null,
        previewPath: null,
      };
    } finally {
      try { metadataPipeline?.destroy?.(); } catch {}
    }

    const bounded = validatePreviewMetadata(metadata, {
      maxPixels: this.maxPreviewPixels,
      maxDimension: this.maxPreviewDimension,
      maxFrames: this.maxPreviewFrames,
    });
    if (!bounded.ok) {
      return {
        ok: true,
        status: 'blocked',
        reason: bounded.reason,
        width: Number(metadata.width) || null,
        height: Number(metadata.height) || null,
        frames: Math.max(1, Number(metadata.pages) || 1),
        previewPath: null,
      };
    }

    const previewPath = this._stagingPath('.preview.webp', ownerToken);
    let previewPipeline = null;
    try {
      previewPipeline = this.sharpFactory(previewInput, {
        failOn: 'warning',
        limitInputPixels: this.maxPreviewPixels,
        pages: 1,
      });
      await previewPipeline
        .rotate()
        .resize({
          width: this.previewEdge,
          height: this.previewEdge,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 84, effort: 4, smartSubsample: true })
        .toFile(previewPath);
      const previewInspection = inspectAttachmentFile({
        rootPath: this.attachmentRoot,
        filePath: previewPath,
        claimedMime: 'image/webp',
        originalName: `${inspection.sha256}.webp`,
      });
      if (!previewInspection.ok) throw new Error(previewInspection.reason);
      return {
        ok: true,
        status: 'ready',
        width: bounded.width,
        height: bounded.height,
        frames: bounded.frames,
        previewPath,
        previewInspection,
      };
    } catch (error) {
      await this._cleanupExactPath(previewPath);
      return {
        ok: true,
        status: 'unavailable',
        reason: isHeicMime(inspection.mimeType)
          ? 'attachment_heic_preview_decoder_unavailable'
          : `attachment_preview_generation_failed:${errorReason(error)}`,
        width: bounded.width,
        height: bounded.height,
        frames: bounded.frames,
        previewPath: null,
      };
    } finally {
      try { previewPipeline?.destroy?.(); } catch {}
    }
  }

  _linkContentAddressed(sourcePath, destinationPath) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    try {
      fs.linkSync(sourcePath, destinationPath);
      return { ok: true, created: true };
    } catch (error) {
      if (error?.code === 'EEXIST') return { ok: true, created: false };
      return { ok: false, reason: `attachment_atomic_publish_failed:${errorReason(error)}` };
    }
  }

  _verifyPublishedOriginal(filePath, inspection) {
    return inspectAttachmentFile({
      rootPath: this.attachmentRoot,
      filePath,
      claimedMime: inspection.mimeType,
      expectedBytes: inspection.bytes,
      expectedSha256: inspection.sha256,
      originalName: inspection.originalName,
    });
  }

  async _finalizeStagedUpload(staged, context, abortState) {
    const inspection = inspectAttachmentFile({
      rootPath: this.attachmentRoot,
      filePath: staged.filePath,
      claimedMime: staged.claimedMime,
      expectedBytes: staged.bytes,
      expectedSha256: staged.sha256,
      originalName: staged.originalName,
      maxBytes: this.maxBytes,
    });
    if (!inspection.ok) {
      await this._cleanupExactPath(staged.filePath);
      return inspection;
    }

    if (typeof this.hooks.afterVerify === 'function') {
      await this.hooks.afterVerify({ request: context.request, staged, inspection });
    }
    if (abortState.aborted) {
      await this._cleanupExactPath(staged.filePath);
      return { ok: false, reason: abortState.reason || 'room_upload_aborted' };
    }

    const preview = await this._buildPreview(staged.filePath, inspection, context.uploadToken);
    if (!preview.ok) {
      await this._cleanupExactPath(staged.filePath);
      return preview;
    }
    if (abortState.aborted) {
      await Promise.all([
        this._cleanupExactPath(staged.filePath),
        this._cleanupExactPath(preview.previewPath),
      ]);
      return { ok: false, reason: abortState.reason || 'room_upload_aborted' };
    }

    if (typeof this.hooks.beforePublish === 'function') {
      await this.hooks.beforePublish({ request: context.request, staged, inspection, preview });
    }
    if (abortState.aborted) {
      await Promise.all([
        this._cleanupExactPath(staged.filePath),
        this._cleanupExactPath(preview.previewPath),
      ]);
      return { ok: false, reason: abortState.reason || 'room_upload_aborted' };
    }

    const originalRelativePath = buildContentAddressedOriginalRelativePath(inspection.sha256);
    const originalPath = path.join(this.attachmentRoot, originalRelativePath);
    const published = this._linkContentAddressed(staged.filePath, originalPath);
    if (!published.ok) {
      await Promise.all([
        this._cleanupExactPath(staged.filePath),
        this._cleanupExactPath(preview.previewPath),
      ]);
      return published;
    }
    const verifiedPublished = this._verifyPublishedOriginal(originalPath, inspection);
    if (!verifiedPublished.ok) {
      await Promise.all([
        this._cleanupExactPath(staged.filePath),
        this._cleanupExactPath(preview.previewPath),
      ]);
      return { ok: false, reason: 'attachment_published_object_integrity_failed', details: verifiedPublished.reason };
    }

    let previewRelativePath = null;
    let previewStatus = preview.status;
    let previewReason = preview.reason || null;
    if (preview.status === 'ready' && preview.previewPath) {
      const candidateRelativePath = buildPreviewRelativePath(inspection.sha256);
      const candidatePath = path.resolve(this.attachmentRoot, ...candidateRelativePath.split('/'));
      const previewPublished = this._linkContentAddressed(preview.previewPath, candidatePath);
      if (previewPublished.ok) {
        const existingPreview = inspectAttachmentFile({
          rootPath: this.attachmentRoot,
          filePath: candidatePath,
          claimedMime: 'image/webp',
          expectedSha256: preview.previewInspection.sha256,
          expectedBytes: preview.previewInspection.bytes,
          originalName: `${inspection.sha256}.webp`,
        });
        if (existingPreview.ok) previewRelativePath = candidateRelativePath;
        else {
          previewStatus = 'unavailable';
          previewReason = 'attachment_preview_publish_integrity_failed';
        }
      } else {
        previewStatus = 'unavailable';
        previewReason = previewPublished.reason;
      }
    }

    const registered = this.store.registerReadyAttachment({
      roomId: context.roomId,
      profileName: context.profileName,
      filePath: originalPath,
      claimedMime: inspection.mimeType,
      expectedBytes: inspection.bytes,
      expectedSha256: inspection.sha256,
      originalName: inspection.originalName,
      width: preview.width,
      height: preview.height,
      previewRelativePath,
      metadata: {
        preview: {
          status: previewStatus,
          reason: previewReason,
          mimeType: previewRelativePath ? 'image/webp' : null,
          bytes: previewRelativePath ? preview.previewInspection?.bytes || null : null,
          sha256: previewRelativePath ? preview.previewInspection?.sha256 || null : null,
          frames: preview.frames || null,
          metadataStripped: Boolean(previewRelativePath),
        },
        upload: {
          originalKey: inspection.sha256,
          atomicPublication: published.created ? 'created' : 'deduplicated',
        },
      },
    });

    const cleanupResults = await Promise.all([
      this._cleanupExactPath(staged.filePath),
      this._cleanupExactPath(preview.previewPath),
    ]);
    const cleanupFailure = cleanupResults.find((result) => !result.ok);
    if (cleanupFailure) {
      return { ok: false, reason: 'room_upload_temp_cleanup_pending', details: cleanupFailure.reason };
    }
    if (!registered.ok) return registered;
    const claimed = this.store.createAttachmentClaim(registered.attachment.attachmentId, {
      roomId: context.roomId,
      profileName: context.profileName,
      originalName: inspection.originalName,
    });
    if (!claimed.ok) return claimed;
    return {
      ok: true,
      status: claimed.status,
      attachment: claimed.attachment,
      previewStatus,
      previewReason,
    };
  }

  async ingestLocalFile(filePath, context = {}) {
    const pendingCleanup = await this._cleanupInactiveTemporaryPaths();
    if (!pendingCleanup.ok) return pendingCleanup;

    const safe = resolveSafeExistingFile(this.trustedRoot, filePath);
    if (!safe.ok) return safe;
    if (safe.stat.size <= 0) return { ok: false, reason: 'attachment_empty' };
    if (safe.stat.size > this.maxBytes) {
      return { ok: false, reason: 'attachment_too_large', bytes: safe.stat.size, maxBytes: this.maxBytes };
    }

    const uploadToken = Symbol('team-room-local-upload');
    this.activeUploadTokens.add(uploadToken);
    let sourceFd = null;
    let result = null;
    try {
      sourceFd = fs.openSync(safe.filePath, 'r');
      const openedStat = fs.fstatSync(sourceFd);
      if (!sameFileSnapshot(safe.stat, openedStat)) {
        result = { ok: false, reason: 'attachment_changed_before_read' };
      } else {
        const stagedPath = this._stagingPath('.upload', uploadToken);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        const meter = new Transform({
          transform: (chunk, encoding, callback) => {
            bytes += chunk.length;
            if (bytes > this.maxBytes) {
              callback(new Error('attachment_too_large'));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        const readStream = fs.createReadStream(safe.filePath, { fd: sourceFd, autoClose: false });
        const writeStream = fs.createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 });
        await pipeline(readStream, meter, writeStream);
        const closedStat = fs.fstatSync(sourceFd);
        if (!sameFileSnapshot(openedStat, closedStat) || bytes !== Number(openedStat.size)) {
          result = { ok: false, reason: 'attachment_changed_during_read' };
        } else {
          result = await this._finalizeStagedUpload({
            filePath: stagedPath,
            originalName: sanitizeAttachmentName(path.basename(safe.filePath)),
            claimedMime: '',
            bytes,
            sha256: hash.digest('hex'),
          }, { ...context, request: null, uploadToken }, { aborted: false, reason: null });
        }
      }
    } catch (error) {
      result = {
        ok: false,
        reason: errorReason(error) === 'attachment_too_large'
          ? 'attachment_too_large'
          : `room_upload_local_file_failed:${errorReason(error)}`,
      };
    } finally {
      if (sourceFd !== null) {
        try { fs.closeSync(sourceFd); } catch {}
      }
      const cleaned = await this._cleanupTemporaryPathsForToken(uploadToken);
      this.activeUploadTokens.delete(uploadToken);
      if (!cleaned.ok) {
        result = result?.ok
          ? { ok: false, reason: 'room_upload_temp_cleanup_pending', cleanupDetail: cleaned.reason }
          : { ...(result || { ok: false, reason: 'room_upload_local_file_failed' }), cleanupPending: true, cleanupDetail: cleaned.reason };
      }
    }
    return result || { ok: false, reason: 'room_upload_local_file_failed' };
  }

  async ingestMultipartRequest(request, context = {}) {
    const uploadToken = Symbol('team-room-upload');
    const preflightAbort = { reason: request.aborted ? 'room_upload_aborted' : null };
    const onPreflightAborted = () => { preflightAbort.reason = 'room_upload_aborted'; };
    const onPreflightError = (error) => {
      preflightAbort.reason = `room_upload_stream_error:${errorReason(error)}`;
    };
    const onPreflightClose = () => {
      if (request.complete !== true) preflightAbort.reason = 'room_upload_premature_close';
    };
    request.once('aborted', onPreflightAborted);
    request.once('error', onPreflightError);
    request.once('close', onPreflightClose);
    const pendingCleanup = await this._cleanupInactiveTemporaryPaths();
    request.off('aborted', onPreflightAborted);
    request.off('error', onPreflightError);
    request.off('close', onPreflightClose);
    if (preflightAbort.reason) return { ok: false, reason: preflightAbort.reason };
    if (!pendingCleanup.ok) return pendingCleanup;
    const contentLength = Number(request.headers?.['content-length']);
    if (Number.isFinite(contentLength) && contentLength > this.maxBytes + UPLOAD_OVERHEAD_BYTES) {
      return { ok: false, reason: 'attachment_too_large', maxBytes: this.maxBytes };
    }

    this.activeUploadTokens.add(uploadToken);
    return new Promise((resolve) => {
      let parser;
      let settled = false;
      let fileSeen = false;
      let fileStream = null;
      let writeStream = null;
      let filePromise = null;
      let stagedPath = null;
      let invalidReason = null;
      const abortState = { aborted: Boolean(request.aborted), reason: request.aborted ? 'room_upload_aborted' : null };

      const removeRequestListeners = () => {
        request.off('aborted', onAborted);
        request.off('error', onRequestError);
        request.off('close', onRequestClose);
      };
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        removeRequestListeners();
        try { request.unpipe(parser); } catch {}
        if (!result.ok) {
          const abortError = new Error(result.reason || 'room_upload_aborted');
          try { fileStream?.destroy(abortError); } catch {}
          try { writeStream?.destroy(abortError); } catch {}
          try { parser?.destroy(abortError); } catch {}
          if (filePromise) await settleWithin(filePromise, 2_000);
        }
        const cleaned = await this._cleanupTemporaryPathsForToken(uploadToken);
        if (!cleaned.ok) {
          result = result.ok
            ? { ...result, ok: false, reason: 'room_upload_temp_cleanup_pending', cleanupDetail: cleaned.reason }
            : { ...result, cleanupPending: true, cleanupDetail: cleaned.reason };
        }
        this.activeUploadTokens.delete(uploadToken);
        resolve(result);
      };
      const abort = (reason) => {
        if (abortState.aborted) return;
        abortState.aborted = true;
        abortState.reason = reason;
        void finish({ ok: false, reason });
      };
      const onAborted = () => abort('room_upload_aborted');
      const onRequestError = (error) => abort(`room_upload_stream_error:${errorReason(error)}`);
      const onRequestClose = () => {
        if (request.complete !== true) abort('room_upload_premature_close');
      };

      request.once('aborted', onAborted);
      request.once('error', onRequestError);
      request.once('close', onRequestClose);
      try {
        parser = this.busboyFactory({
          headers: request.headers,
          limits: {
            fieldNameSize: 64,
            fields: 0,
            files: 1,
            fileSize: this.maxBytes,
            headerPairs: 200,
          },
        });
      } catch (error) {
        void finish({ ok: false, reason: `room_multipart_invalid:${errorReason(error)}` });
        return;
      }

      parser.on('file', (fieldName, incoming, info = {}) => {
        if (fileSeen || fieldName !== 'file') {
          invalidReason = fileSeen ? 'room_upload_single_file_required' : 'room_upload_file_field_required';
          incoming.resume();
          return;
        }
        fileSeen = true;
        fileStream = incoming;
        try {
          stagedPath = this._stagingPath('.upload', uploadToken);
        } catch (error) {
          invalidReason = errorReason(error, 'room_upload_staging_unavailable');
          incoming.resume();
          return;
        }
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        let limited = false;
        incoming.once('limit', () => { limited = true; });
        const meter = new Transform({
          transform(chunk, encoding, callback) {
            bytes += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        writeStream = fs.createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 });
        filePromise = pipeline(incoming, meter, writeStream).then(() => ({
          filePath: stagedPath,
          originalName: sanitizeAttachmentName(info.filename),
          claimedMime: String(info.mimeType || '').trim().toLowerCase(),
          bytes,
          sha256: hash.digest('hex'),
          limited: limited || incoming.truncated === true,
        }));
      });
      parser.once('fieldsLimit', () => { invalidReason = 'room_upload_fields_forbidden'; });
      parser.once('filesLimit', () => { invalidReason = 'room_upload_single_file_required'; });
      parser.once('error', (error) => abort(`room_upload_stream_error:${errorReason(error)}`));
      parser.once('finish', () => {
        void (async () => {
          if (abortState.aborted) return finish({ ok: false, reason: abortState.reason });
          if (invalidReason) return finish({ ok: false, reason: invalidReason });
          if (!fileSeen || !filePromise) return finish({ ok: false, reason: 'room_upload_file_required' });
          let staged;
          try { staged = await filePromise; } catch (error) {
            return finish({ ok: false, reason: `room_upload_stream_error:${errorReason(error)}` });
          }
          if (staged.limited || staged.bytes > this.maxBytes) {
            return finish({ ok: false, reason: 'attachment_too_large', bytes: staged.bytes, maxBytes: this.maxBytes });
          }
          if (staged.bytes <= 0) return finish({ ok: false, reason: 'attachment_empty' });
          try {
            const result = await this._finalizeStagedUpload(staged, { ...context, request, uploadToken }, abortState);
            return finish(result);
          } catch (error) {
            return finish({ ok: false, reason: `room_upload_finalize_failed:${errorReason(error)}` });
          }
        })();
      });
      request.pipe(parser);
    });
  }
}

module.exports = {
  CLEANUP_RETRY_DELAYS_MS,
  DEFAULT_PREVIEW_EDGE,
  RECOVERABLE_TEMP_NAME_PATTERN,
  settleWithin,
  TeamRoomUploadManager,
  UPLOAD_OVERHEAD_BYTES,
};
