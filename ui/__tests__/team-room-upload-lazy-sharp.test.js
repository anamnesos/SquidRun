'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Team Room upload lazy Sharp boundary', () => {
  afterEach(() => {
    jest.dontMock('sharp');
    jest.resetModules();
  });

  test('boots without Sharp and degrades only image preview generation', async () => {
    jest.resetModules();
    jest.doMock('sharp', () => {
      throw new Error('simulated missing sharp dependency');
    });

    let TeamRoomUploadManager;
    expect(() => {
      jest.isolateModules(() => {
        ({ TeamRoomUploadManager } = require('../modules/main/team-room-upload'));
      });
    }).not.toThrow();

    const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-lazy-sharp-'));
    const attachmentRoot = path.join(trustedRoot, 'attachments');
    fs.mkdirSync(path.join(attachmentRoot, '.staging'), { recursive: true });
    const stagedPath = path.join(attachmentRoot, '.staging', 'source.upload');
    fs.writeFileSync(stagedPath, Buffer.from('not-a-real-image'));

    try {
      const manager = new TeamRoomUploadManager({
        store: { attachmentRoot, trustedRoot },
        attachmentRoot,
        trustedRoot,
      });
      const result = await manager._buildPreview(stagedPath, {
        mimeType: 'image/png',
        sha256: 'a'.repeat(64),
      }, 'test-owner');

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        status: 'unavailable',
        reason: expect.stringContaining('simulated missing sharp dependency'),
      }));
    } finally {
      fs.rmSync(trustedRoot, { recursive: true, force: true });
    }
  });
});
