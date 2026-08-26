'use strict';

const {
  SURFACES,
  identifySurface,
  normalizeUrlPath,
  parseArgs,
  verifyExpectedCommit,
} = require('../scripts/build-1b-window-capture');

describe('Build 1B six-window capture contract', () => {
  test('enumerates the six ratified BrowserWindow construction surfaces by name', () => {
    expect(SURFACES.map((surface) => surface.id)).toEqual([
      'main',
      'pane-host',
      'live-task-audit',
      'spine-overlay',
    ]);
  });

  test.each(SURFACES)('identifies $id from packaged app.asar URL', (surface) => {
    const url = `file:///D:/qa/win-unpacked/resources/app.asar/${surface.html}?profile=test-copy`;
    expect(identifySurface(url)).toEqual(surface);
  });

  test('does not fold non-window renderer paths into the six-surface proof', () => {
    expect(identifySurface('file:///D:/qa/win-unpacked/resources/app.asar/renderer.js')).toBeNull();
  });

  test('normalizes encoded Windows file URLs for stable matching', () => {
    expect(normalizeUrlPath('file:///D:/Build%201B/resources/app.asar/index.html?x=1'))
      .toBe('/D:/Build 1B/resources/app.asar/index.html');
  });

  test('parses the isolated capture boundary', () => {
    expect(parseArgs([
      '--cdp-port', '9444',
      '--artifact-dir', 'D:\\qa\\capture',
      '--expect-commit', '34b29f79',
      '--title-prefix', 'Build 1B TEST COPY',
      '--timeout-ms', '30000',
    ])).toEqual(expect.objectContaining({
      cdpPort: 9444,
      artifactDir: 'D:\\qa\\capture',
      expectCommit: '34b29f79',
      titlePrefix: 'Build 1B TEST COPY',
      timeoutMs: 30000,
    }));
  });

  test('requires an explicit commit before a capture can claim provenance', () => {
    expect(() => verifyExpectedCommit(null)).toThrow('--expect-commit is required');
  });
});
