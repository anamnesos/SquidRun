'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_VISUAL_ASSET_CURIOSITY_SCHEMA,
  readMiraVisualAssetCuriosity,
} = require('../modules/mira-visual-asset-curiosity');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-visual-asset-'));
}

function tinyPngBuffer(width = 2, height = 3) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('Mira visual asset curiosity', () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  test('reads compact screenshot and generated-image metadata with cheap dimensions', () => {
    projectRoot = tempProject();
    const screenshots = path.join(projectRoot, '.squidrun', 'screenshots');
    const generated = path.join(projectRoot, 'workspace', 'generated-images');
    fs.mkdirSync(screenshots, { recursive: true });
    fs.mkdirSync(generated, { recursive: true });
    fs.writeFileSync(path.join(screenshots, 'latest.png'), tinyPngBuffer(11, 7));
    fs.writeFileSync(path.join(generated, 'asset.svg'), '<svg width="32" height="16"></svg>', 'utf8');

    const result = readMiraVisualAssetCuriosity({}, { projectRoot, limit: 5 });

    expect(result.schema).toBe(MIRA_VISUAL_ASSET_CURIOSITY_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('visual_assets_read_only');
    expect(result.result_count).toBe(2);
    expect(result.buckets).toEqual(expect.objectContaining({
      screenshots: 1,
      generated_images: 1,
    }));
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '.squidrun/screenshots/latest.png',
        ext: '.png',
        width: 11,
        height: 7,
      }),
      expect.objectContaining({
        path: 'workspace/generated-images/asset.svg',
        ext: '.svg',
        width: 32,
        height: 16,
      }),
    ]));
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      internal_only: true,
      read_only: true,
      image_ocr_performed: false,
      image_model_performed: false,
      file_write_performed: false,
      external_send_performed: false,
    }));
  });

  test('reports unavailable when no visual assets exist', () => {
    projectRoot = tempProject();
    const result = readMiraVisualAssetCuriosity({}, { projectRoot });

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('unavailable_in_this_runtime');
    expect(result.reason).toBe('visual_assets_missing');
    expect(result.result_count).toBe(0);
    expect(result.no_mutation_performed).toBe(true);
  });
});
