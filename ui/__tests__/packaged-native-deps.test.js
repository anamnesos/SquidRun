const fs = require('fs');
const path = require('path');

describe('packaged native dependency closure', () => {
  test('unpacks better-sqlite3 runtime dependencies for Electron-as-Node workers', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const asarUnpack = packageJson.build?.asarUnpack || [];

    expect(asarUnpack).toEqual(expect.arrayContaining([
      'node_modules/better-sqlite3/**',
      'node_modules/bindings/**',
      'node_modules/file-uri-to-path/**',
    ]));
  });
});
