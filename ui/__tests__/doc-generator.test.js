const fs = require('fs');
const path = require('path');
const { createDocGenerator } = require('../modules/analysis/doc-generator');

function dirent(name, type) {
  return {
    name,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file',
  };
}

describe('doc-generator findFiles', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('skips unreadable subdirectories without throwing', () => {
    const rootDir = path.join('workspace', 'docs-target');
    const blockedDir = path.join(rootDir, 'blocked');
    const nestedDir = path.join(rootDir, 'nested');

    jest.spyOn(fs, 'readdirSync').mockImplementation((dirPath) => {
      if (dirPath === rootDir) {
        return [
          dirent('module.js', 'file'),
          dirent('blocked', 'dir'),
          dirent('nested', 'dir'),
        ];
      }
      if (dirPath === blockedDir) {
        throw new Error('EACCES');
      }
      if (dirPath === nestedDir) {
        return [dirent('inner.ts', 'file')];
      }
      return [];
    });

    const generator = createDocGenerator();
    const files = generator.findFiles(rootDir, /\.(js|ts|mjs)$/, null, true);

    expect(files).toEqual([
      path.join(rootDir, 'module.js'),
      path.join(nestedDir, 'inner.ts'),
    ]);
  });
});
