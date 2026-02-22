const fs = require('fs');
const os = require('os');
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

  test('writeDocumentation preserves relative paths to avoid basename collisions', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-generator-collision-'));
    const sourceDir = path.join(tempRoot, 'source');
    const outputDir = path.join(tempRoot, 'docs');
    const firstFile = path.join(sourceDir, 'src', 'index.js');
    const secondFile = path.join(sourceDir, 'plugins', 'index.js');

    try {
      fs.mkdirSync(path.dirname(firstFile), { recursive: true });
      fs.mkdirSync(path.dirname(secondFile), { recursive: true });

      const generator = createDocGenerator({ format: 'markdown' });
      await generator.writeDocumentation({
        sourceDir,
        index: '# Test Index',
        results: [
          {
            filePath: firstFile,
            documentation: '# SRC INDEX',
            stats: { functions: 1, classes: 0, exports: 1 },
          },
          {
            filePath: secondFile,
            documentation: '# PLUGIN INDEX',
            stats: { functions: 2, classes: 0, exports: 1 },
          },
        ],
      }, outputDir);

      const firstOutPath = path.join(outputDir, 'src', 'index.md');
      const secondOutPath = path.join(outputDir, 'plugins', 'index.md');
      expect(fs.existsSync(firstOutPath)).toBe(true);
      expect(fs.existsSync(secondOutPath)).toBe(true);
      expect(fs.readFileSync(firstOutPath, 'utf-8')).toContain('SRC INDEX');
      expect(fs.readFileSync(secondOutPath, 'utf-8')).toContain('PLUGIN INDEX');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('writeDocumentation uses temp export and cleans up on write failure', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-generator-atomic-'));
    const sourceDir = path.join(tempRoot, 'source');
    const outputDir = path.join(tempRoot, 'docs');
    const firstFile = path.join(sourceDir, 'src', 'a.js');
    const secondFile = path.join(sourceDir, 'src', 'b.js');
    const previousDocPath = path.join(outputDir, 'README.md');

    const realWrite = fs.writeFileSync;
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    try {
      fs.mkdirSync(path.dirname(firstFile), { recursive: true });
      fs.mkdirSync(outputDir, { recursive: true });
      realWrite(previousDocPath, '# Old docs', 'utf-8');

      let failInjected = false;
      writeSpy.mockImplementation((targetPath, content, encoding) => {
        if (!failInjected && String(targetPath).includes(`${path.sep}src${path.sep}b.md`)) {
          failInjected = true;
          throw new Error('disk full');
        }
        return realWrite(targetPath, content, encoding);
      });

      const generator = createDocGenerator({ format: 'markdown' });
      await expect(generator.writeDocumentation({
        sourceDir,
        index: '# New Index',
        results: [
          { filePath: firstFile, documentation: '# A', stats: { functions: 1, classes: 0, exports: 1 } },
          { filePath: secondFile, documentation: '# B', stats: { functions: 1, classes: 0, exports: 1 } },
        ],
      }, outputDir)).rejects.toThrow('disk full');

      // Existing output remains intact because export happened in temp dir.
      expect(fs.readFileSync(previousDocPath, 'utf-8')).toBe('# Old docs');
      expect(fs.existsSync(path.join(outputDir, 'src', 'a.md'))).toBe(false);

      const tempArtifacts = fs.readdirSync(tempRoot).filter((name) => name.startsWith('.docs.tmp-'));
      expect(tempArtifacts).toHaveLength(0);
    } finally {
      writeSpy.mockRestore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
