'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildContentAddressedRelativePath,
  inspectAttachmentFile,
  sanitizeAttachmentName,
} = require('../modules/main/team-room-attachments');

describe('team-room attachment integrity', () => {
  let tempDir;
  let mediaRoot;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-room-media-'));
    mediaRoot = path.join(tempDir, 'media');
    fs.mkdirSync(mediaRoot);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('streams, sniffs, and hashes a file under the media root', () => {
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('room-photo'),
    ]);
    const filePath = path.join(mediaRoot, 'photo.png');
    fs.writeFileSync(filePath, bytes);
    const result = inspectAttachmentFile({
      rootPath: mediaRoot,
      filePath,
      claimedMime: 'image/png',
      expectedBytes: bytes.length,
      expectedSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      originalName: '../James:photo?.png',
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      mimeType: 'image/png',
      bytes: bytes.length,
      relativePath: 'photo.png',
      originalName: 'James_photo_.png',
    }));
  });

  test.each([
    [{ claimedMime: 'image/jpeg' }, 'attachment_mime_mismatch'],
    [{ expectedBytes: 999 }, 'attachment_byte_count_mismatch'],
    [{ expectedSha256: '0'.repeat(64) }, 'attachment_hash_mismatch'],
    [{ maxBytes: 2 }, 'attachment_too_large'],
  ])('fails closed on upload claim mismatch %#', (overrides, reason) => {
    const filePath = path.join(mediaRoot, 'photo.png');
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    expect(inspectAttachmentFile({ rootPath: mediaRoot, filePath, ...overrides }))
      .toEqual(expect.objectContaining({ ok: false, reason }));
  });

  test('rejects traversal and an in-root junction that escapes the media root', () => {
    const outside = path.join(tempDir, 'outside');
    fs.mkdirSync(outside);
    const outsideFile = path.join(outside, 'secret.png');
    fs.writeFileSync(outsideFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    expect(inspectAttachmentFile({ rootPath: mediaRoot, filePath: outsideFile }))
      .toEqual(expect.objectContaining({ ok: false, reason: 'attachment_path_outside_root' }));

    const junction = path.join(mediaRoot, 'escape');
    fs.symlinkSync(outside, junction, 'junction');
    expect(inspectAttachmentFile({ rootPath: mediaRoot, filePath: path.join(junction, 'secret.png') }))
      .toEqual(expect.objectContaining({ ok: false, reason: 'attachment_symlink_forbidden' }));
  });

  test('builds a sanitized content-addressed object path', () => {
    const digest = 'ab'.repeat(32);
    expect(buildContentAddressedRelativePath(digest, '..\\bad:name?.heic'))
      .toBe(`objects/ab/ab/${digest}-bad_name_.heic`);
    expect(sanitizeAttachmentName('...')).toBe('attachment');
  });
});
