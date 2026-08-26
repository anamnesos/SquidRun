'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const sharp = require('sharp');
const { TeamRoomStore } = require('../modules/main/team-room-store');
const { TeamRoomUploadManager } = require('../modules/main/team-room-upload');

function multipartBody(bytes, options = {}) {
  const boundary = options.boundary || `room-${crypto.randomBytes(8).toString('hex')}`;
  const filename = options.filename || 'photo.png';
  const mimeType = options.mimeType || 'image/png';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { boundary, body: Buffer.concat([head, bytes, tail]) };
}

function requestFromMultipart(payload) {
  const request = new PassThrough();
  request.headers = {
    'content-type': `multipart/form-data; boundary=${payload.boundary}`,
    'content-length': String(payload.body.length),
  };
  request.complete = false;
  request.aborted = false;
  setImmediate(() => {
    request.complete = true;
    request.end(payload.body);
  });
  return request;
}

describe('Team Room streamed upload publication', () => {
  let tempRoot;
  let attachmentRoot;
  let store;

  beforeEach(() => {
    sharp.cache(false);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-room-upload-'));
    attachmentRoot = path.join(tempRoot, 'attachments');
    store = new TeamRoomStore({
      dbPath: path.join(tempRoot, 'room.db'),
      attachmentRoot,
    });
    expect(store.init().ok).toBe(true);
  });

  afterEach(() => {
    sharp.cache(false);
    store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('publishes a literal SHA key and an EXIF-free bounded WebP preview', async () => {
    const bytes = await sharp({
      create: { width: 40, height: 24, channels: 3, background: '#2f81f7' },
    }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot });
    const result = await manager.ingestMultipartRequest(requestFromMultipart(multipartBody(bytes, {
      filename: '../iphone:photo?.jpg', mimeType: 'image/jpeg',
    })), { roomId: 'main', profileName: 'main', memberId: 'operator' });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'inserted' }));
    expect(result.attachment).toEqual(expect.objectContaining({
      sha256: digest,
      relativePath: digest,
      originalName: 'iphone_photo_.jpg',
      width: 40,
      height: 24,
    }));
    expect(result.attachment.localPath).toBe(path.join(attachmentRoot, digest));
    expect(fs.readFileSync(result.attachment.localPath)).toEqual(bytes);
    expect(result.attachment.previewRelativePath).toBe(`previews/${digest}.webp`);
    const previewMetadata = await sharp(result.attachment.previewLocalPath).metadata();
    expect(previewMetadata.format).toBe('webp');
    expect(previewMetadata.exif).toBeUndefined();
    expect(result.attachment.metadata.preview).toEqual(expect.objectContaining({
      status: 'ready', mimeType: 'image/webp', metadataStripped: true,
    }));
    expect(manager.ownedTemporaryPaths.size).toBe(0);
  });

  test('ingests a canonical local project file through the same verified store', async () => {
    const sourceRoot = path.join(tempRoot, 'mockups');
    fs.mkdirSync(sourceRoot, { recursive: true });
    const sourcePath = path.join(sourceRoot, 'main window.png');
    const bytes = await sharp({
      create: { width: 48, height: 32, channels: 3, background: '#7c3aed' },
    }).png().toBuffer();
    fs.writeFileSync(sourcePath, bytes);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot });

    const result = await manager.ingestLocalFile(sourcePath, {
      roomId: 'main', profileName: 'main', memberId: 'builder',
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'inserted' }));
    expect(result.attachment).toEqual(expect.objectContaining({
      sha256: digest,
      originalName: 'main window.png',
      mimeType: 'image/png',
      width: 48,
      height: 32,
    }));
    expect(fs.readFileSync(path.join(attachmentRoot, digest))).toEqual(bytes);
    expect(manager.ownedTemporaryPaths.size).toBe(0);
    expect(manager.activeUploadTokens.size).toBe(0);
  });

  test('rejects missing, non-file, unsupported, oversized, and out-of-scope local paths', async () => {
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot, maxBytes: 32 });
    const directoryPath = path.join(tempRoot, 'directory-only');
    const unsupportedPath = path.join(tempRoot, 'fake.png');
    const oversizedPath = path.join(tempRoot, 'oversized.png');
    fs.mkdirSync(directoryPath);
    fs.writeFileSync(unsupportedPath, 'this is not an image');
    fs.writeFileSync(oversizedPath, Buffer.alloc(33, 1));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-room-local-outside-'));
    const outsidePath = path.join(outsideRoot, 'outside.png');
    fs.writeFileSync(outsidePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    try {
      await expect(manager.ingestLocalFile(path.join(tempRoot, 'missing.png')))
        .resolves.toEqual(expect.objectContaining({ ok: false, reason: 'attachment_path_unreadable' }));
      await expect(manager.ingestLocalFile(directoryPath))
        .resolves.toEqual(expect.objectContaining({ ok: false, reason: 'attachment_not_regular_file' }));
      await expect(manager.ingestLocalFile(unsupportedPath))
        .resolves.toEqual(expect.objectContaining({ ok: false, reason: 'attachment_magic_unsupported' }));
      await expect(manager.ingestLocalFile(oversizedPath))
        .resolves.toEqual(expect.objectContaining({ ok: false, reason: 'attachment_too_large' }));
      await expect(manager.ingestLocalFile(outsidePath))
        .resolves.toEqual(expect.objectContaining({ ok: false, reason: 'attachment_path_outside_root' }));
      expect(store.db.prepare('SELECT COUNT(*) AS count FROM room_attachments').get().count).toBe(0);
      expect(manager.ownedTemporaryPaths.size).toBe(0);
      expect(manager.activeUploadTokens.size).toBe(0);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test('races identical uploads safely while an already-verified loser aborts', async () => {
    const bytes = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#f59e0b' },
    }).png().toBuffer();
    let verifiedLoser;
    let releaseLoser;
    const loserVerified = new Promise((resolve) => { verifiedLoser = resolve; });
    const loserRelease = new Promise((resolve) => { releaseLoser = resolve; });
    let loserRequest;
    const manager = new TeamRoomUploadManager({
      store,
      attachmentRoot,
      trustedRoot: tempRoot,
      hooks: {
        afterVerify: async ({ request }) => {
          if (request !== loserRequest) return;
          verifiedLoser();
          await loserRelease;
        },
      },
    });
    loserRequest = requestFromMultipart(multipartBody(bytes));
    const loserPromise = manager.ingestMultipartRequest(loserRequest, {
      roomId: 'main', profileName: 'main', memberId: 'operator',
    });
    await loserVerified;
    const winner = await manager.ingestMultipartRequest(requestFromMultipart(multipartBody(bytes)), {
      roomId: 'main', profileName: 'main', memberId: 'operator',
    });
    loserRequest.aborted = true;
    loserRequest.emit('aborted');
    releaseLoser();
    const loser = await loserPromise;

    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(winner.ok).toBe(true);
    expect(loser).toEqual(expect.objectContaining({ ok: false, reason: 'room_upload_aborted' }));
    expect(fs.readFileSync(path.join(attachmentRoot, digest))).toEqual(bytes);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM room_attachments').get().count).toBe(1);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM room_messages').get().count).toBe(0);
    const stagingRoot = path.join(attachmentRoot, '.staging');
    expect(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : []).toEqual([]);
    expect(manager.ownedTemporaryPaths.size).toBe(0);
    expect(manager.temporaryPathOwners.size).toBe(0);
    expect(manager.activeUploadTokens.size).toBe(0);
  });

  test('keeps an immutable original while refusing a pixel-bomb preview', async () => {
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#22c55e' },
    }).png().toBuffer();
    const manager = new TeamRoomUploadManager({
      store,
      attachmentRoot,
      trustedRoot: tempRoot,
      maxPreviewPixels: 1_000,
      sharpFactory: () => ({ metadata: async () => ({ width: 50_000, height: 50_000, pages: 1 }) }),
    });
    const result = await manager.ingestMultipartRequest(requestFromMultipart(multipartBody(bytes)), {
      roomId: 'main', profileName: 'main', memberId: 'operator',
    });
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');

    expect(result.ok).toBe(true);
    expect(result.attachment.relativePath).toBe(digest);
    expect(fs.readFileSync(path.join(attachmentRoot, digest))).toEqual(bytes);
    expect(result.attachment.previewRelativePath).toBeNull();
    expect(result.attachment.metadata.preview).toEqual(expect.objectContaining({
      status: 'blocked', reason: 'attachment_preview_dimension_limit',
    }));
  });

  test('capability-tests HEIC honestly and preserves the verified original when decode is unavailable', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypheic', 'ascii'),
      Buffer.from('unavailable-hevc-payload', 'ascii'),
    ]);
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot });
    const result = await manager.ingestMultipartRequest(requestFromMultipart(multipartBody(bytes, {
      filename: 'iphone.heic', mimeType: 'image/heic',
    })), { roomId: 'main', profileName: 'main', memberId: 'operator' });

    expect(result.ok).toBe(true);
    expect(result.attachment.mimeType).toBe('image/heic');
    expect(result.attachment.previewRelativePath).toBeNull();
    expect(result.attachment.metadata.preview).toEqual(expect.objectContaining({
      status: 'unavailable', reason: 'attachment_heic_preview_decoder_unavailable',
    }));
    expect(fs.readFileSync(result.attachment.localPath)).toEqual(bytes);
  });

  test('preserves a magic-verified original when preview decoding fails', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('not-a-decodable-png', 'ascii'),
    ]);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot });
    const result = await manager.ingestMultipartRequest(requestFromMultipart(multipartBody(bytes)), {
      roomId: 'main', profileName: 'main', memberId: 'operator',
    });

    expect(result.ok).toBe(true);
    expect(result.attachment.relativePath).toBe(digest);
    expect(fs.readFileSync(path.join(attachmentRoot, digest))).toEqual(bytes);
    expect(result.attachment.previewRelativePath).toBeNull();
    expect(result.attachment.metadata.preview).toEqual(expect.objectContaining({
      status: 'unavailable',
      reason: expect.stringContaining('attachment_preview_decode_failed'),
    }));
  });

  test('cleans only its exact temp on premature close and creates no row', async () => {
    const payload = multipartBody(Buffer.alloc(256, 7));
    const request = new PassThrough();
    request.headers = {
      'content-type': `multipart/form-data; boundary=${payload.boundary}`,
      'content-length': String(payload.body.length),
    };
    request.complete = false;
    request.aborted = false;
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot });
    const pending = manager.ingestMultipartRequest(request, {
      roomId: 'main', profileName: 'main', memberId: 'operator',
    });
    request.write(payload.body.subarray(0, Math.floor(payload.body.length / 2)));
    request.emit('close');
    const result = await pending;
    request.destroy();

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'room_upload_premature_close' }));
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM room_attachments').get().count).toBe(0);
    expect(manager.ownedTemporaryPaths.size).toBe(0);
    const stagingRoot = path.join(attachmentRoot, '.staging');
    expect(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : []).toEqual([]);
  });

  test('cleans an exact partial temp on request stream error and creates no row', async () => {
    const payload = multipartBody(Buffer.alloc(512, 5));
    const request = new PassThrough();
    request.headers = {
      'content-type': `multipart/form-data; boundary=${payload.boundary}`,
      'content-length': String(payload.body.length),
    };
    request.complete = false;
    request.aborted = false;
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot });
    const pending = manager.ingestMultipartRequest(request, {
      roomId: 'main', profileName: 'main', memberId: 'operator',
    });
    request.write(payload.body.subarray(0, Math.floor(payload.body.length / 2)));
    request.emit('error', new Error('injected_socket_failure'));
    const result = await pending;
    request.destroy();

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'room_upload_stream_error:injected_socket_failure',
    }));
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM room_attachments').get().count).toBe(0);
    expect(manager.ownedTemporaryPaths.size).toBe(0);
    expect(manager.temporaryPathOwners.size).toBe(0);
    const stagingRoot = path.join(attachmentRoot, '.staging');
    expect(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : []).toEqual([]);
  });

  test('recovers only strict manager temp names after restart and preserves unrelated staging files', async () => {
    const stagingRoot = path.join(attachmentRoot, '.staging');
    fs.mkdirSync(stagingRoot, { recursive: true });
    const uploadResidue = path.join(stagingRoot, '11111111-1111-4111-8111-111111111111.upload');
    const previewResidue = path.join(stagingRoot, '22222222-2222-4222-8222-222222222222.preview.webp');
    const unrelated = path.join(stagingRoot, 'keep-me.upload');
    fs.writeFileSync(uploadResidue, 'partial upload');
    fs.writeFileSync(previewResidue, 'partial preview');
    fs.writeFileSync(unrelated, 'not manager owned');
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot });

    await expect(manager.recoverStaleTemporaryPaths()).resolves.toEqual({ ok: true });
    expect(fs.existsSync(uploadResidue)).toBe(false);
    expect(fs.existsSync(previewResidue)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('not manager owned');
    expect(manager.ownedTemporaryPaths.size).toBe(0);
  });

  test('fails closed when staging is a junction and never deletes a foreign exact-name file', async () => {
    const stagingRoot = path.join(attachmentRoot, '.staging');
    const foreignRoot = path.join(tempRoot, 'foreign-staging');
    fs.mkdirSync(foreignRoot, { recursive: true });
    const foreignUpload = path.join(foreignRoot, '44444444-4444-4444-8444-444444444444.upload');
    const foreignSentinel = path.join(foreignRoot, 'foreign-sentinel.txt');
    fs.writeFileSync(foreignUpload, 'foreign upload');
    fs.writeFileSync(foreignSentinel, 'foreign sentinel');
    fs.symlinkSync(foreignRoot, stagingRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot });

    await expect(manager.recoverStaleTemporaryPaths()).resolves.toEqual({
      ok: false,
      reason: 'room_upload_staging_root_reparse_forbidden',
    });
    expect(fs.readFileSync(foreignUpload, 'utf8')).toBe('foreign upload');
    expect(fs.readFileSync(foreignSentinel, 'utf8')).toBe('foreign sentinel');
    expect(manager.ownedTemporaryPaths.size).toBe(0);
    fs.rmdirSync(stagingRoot);
  });

  test('fails closed when an attachment-root ancestor is a junction and preserves foreign files', async () => {
    const aliasRoot = path.join(tempRoot, 'alias');
    const foreignRoot = path.join(tempRoot, 'foreign-ancestor');
    const foreignAttachmentRoot = path.join(foreignRoot, 'attachments');
    const foreignStagingRoot = path.join(foreignAttachmentRoot, '.staging');
    fs.mkdirSync(foreignStagingRoot, { recursive: true });
    const foreignUpload = path.join(foreignStagingRoot, '77777777-7777-4777-8777-777777777777.upload');
    const foreignSentinel = path.join(foreignStagingRoot, 'foreign-ancestor-sentinel.txt');
    fs.writeFileSync(foreignUpload, 'foreign ancestor upload');
    fs.writeFileSync(foreignSentinel, 'foreign ancestor sentinel');
    fs.symlinkSync(foreignRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const manager = new TeamRoomUploadManager({
      store,
      attachmentRoot: path.join(aliasRoot, 'attachments'),
      trustedRoot: tempRoot,
    });

    await expect(manager.recoverStaleTemporaryPaths()).resolves.toEqual({
      ok: false,
      reason: 'room_upload_storage_path_reparse_forbidden',
    });
    expect(fs.lstatSync(aliasRoot).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(aliasRoot, 'attachments')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(foreignUpload, 'utf8')).toBe('foreign ancestor upload');
    expect(fs.readFileSync(foreignSentinel, 'utf8')).toBe('foreign ancestor sentinel');
    expect(manager.ownedTemporaryPaths.size).toBe(0);
    fs.rmdirSync(aliasRoot);
  });

  test('rejects a normal attachment root outside the explicit trusted root', async () => {
    const trustedRoot = path.join(tempRoot, 'trusted-room');
    const outsideAttachmentRoot = path.join(tempRoot, 'outside-room', 'attachments');
    const outsideStagingRoot = path.join(outsideAttachmentRoot, '.staging');
    fs.mkdirSync(trustedRoot, { recursive: true });
    fs.mkdirSync(outsideStagingRoot, { recursive: true });
    const outsideUpload = path.join(outsideStagingRoot, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.upload');
    fs.writeFileSync(outsideUpload, 'outside trusted root');
    const manager = new TeamRoomUploadManager({
      store,
      attachmentRoot: outsideAttachmentRoot,
      trustedRoot,
    });

    await expect(manager.recoverStaleTemporaryPaths()).resolves.toEqual({
      ok: false,
      reason: 'room_upload_attachment_root_outside_trusted_root',
    });
    expect(fs.readFileSync(outsideUpload, 'utf8')).toBe('outside trusted root');
    expect(manager.ownedTemporaryPaths.size).toBe(0);
  });

  test('rejects an exact-name cleanup target outside the canonical staging directory', async () => {
    const stagingRoot = path.join(attachmentRoot, '.staging');
    const foreignRoot = path.join(tempRoot, 'foreign-cleanup');
    fs.mkdirSync(stagingRoot, { recursive: true });
    fs.mkdirSync(foreignRoot, { recursive: true });
    const foreignUpload = path.join(foreignRoot, '66666666-6666-4666-8666-666666666666.upload');
    fs.writeFileSync(foreignUpload, 'must remain');
    const ownedTemporaryPaths = new Set([foreignUpload]);
    const manager = new TeamRoomUploadManager({
      store, attachmentRoot, trustedRoot: tempRoot, ownedTemporaryPaths,
    });

    await expect(manager.cleanupOwnedTemporaryPaths()).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: expect.stringContaining('room_upload_temp_target_outside_staging_root'),
    }));
    expect(fs.readFileSync(foreignUpload, 'utf8')).toBe('must remain');
    expect(manager.ownedTemporaryPaths.has(foreignUpload)).toBe(true);
  });

  test('preserves the primary stream error while parking exact cleanup for a later recovery pass', async () => {
    const payload = multipartBody(Buffer.alloc(512, 9));
    const request = new PassThrough();
    request.headers = {
      'content-type': `multipart/form-data; boundary=${payload.boundary}`,
      'content-length': String(payload.body.length),
    };
    request.complete = false;
    request.aborted = false;
    const manager = new TeamRoomUploadManager({ store, attachmentRoot, trustedRoot: tempRoot });
    const realUnlink = fs.unlinkSync;
    const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation((filePath) => {
      if (String(filePath).endsWith('.upload')) {
        const error = new Error('injected_temp_lock');
        error.code = 'EBUSY';
        throw error;
      }
      return realUnlink(filePath);
    });
    const pending = manager.ingestMultipartRequest(request, {
      roomId: 'main', profileName: 'main', memberId: 'operator',
    });
    request.write(payload.body.subarray(0, Math.floor(payload.body.length / 2)));
    for (let attempt = 0; attempt < 20 && manager.ownedTemporaryPaths.size === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(manager.ownedTemporaryPaths.size).toBe(1);
    request.emit('error', new Error('primary_socket_failure'));
    const result = await pending;
    request.destroy();

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'room_upload_stream_error:primary_socket_failure',
      cleanupPending: true,
      cleanupDetail: expect.stringContaining('injected_temp_lock'),
    }));
    expect(manager.ownedTemporaryPaths.size).toBe(1);
    const parkedPath = [...manager.ownedTemporaryPaths][0];
    expect(fs.existsSync(parkedPath)).toBe(true);
    unlinkSpy.mockRestore();
    await expect(manager.recoverStaleTemporaryPaths()).resolves.toEqual({ ok: true });
    expect(fs.existsSync(parkedPath)).toBe(false);
    expect(manager.ownedTemporaryPaths.size).toBe(0);
  });
});
