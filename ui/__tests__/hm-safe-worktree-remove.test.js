'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  inspectTreeForReparsePoints,
  parseWorktreeList,
  removeWorktreeSafely,
} = require('../scripts/hm-safe-worktree-remove');

describe('safe worktree removal', () => {
  let root;
  let target;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-safe-worktree-'));
    target = path.join(path.dirname(root), `${path.basename(root)}-child`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'tracked.txt'), 'fixture');
  });

  afterEach(() => {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  function fakeGit() {
    return jest.fn((args) => {
      if (args.includes('rev-parse')) return { status: 0, stdout: `${root}\n`, stderr: '' };
      if (args.includes('list')) {
        return { status: 0, stdout: `worktree ${root}\n\nworktree ${target}\n\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
  }

  test('parses registered worktree paths with spaces without shell tokenization', () => {
    expect(parseWorktreeList('worktree D:/projects/main\n\nworktree D:/projects/a gate\n'))
      .toEqual([path.resolve('D:/projects/main'), path.resolve('D:/projects/a gate')]);
  });

  test('scans twice and invokes exact non-shell Git removal for a clean registered worktree', () => {
    const runGit = fakeGit();

    const result = removeWorktreeSafely({ target, cwd: root, force: true, runGit });

    expect(result).toEqual(expect.objectContaining({ ok: true, removed: true, target }));
    expect(runGit).toHaveBeenLastCalledWith(
      ['-C', root, 'worktree', 'remove', '--force', target],
      { cwd: root }
    );
  });

  test('refuses a descendant junction before Git receives removal authority', () => {
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-safe-worktree-foreign-'));
    const link = path.join(target, 'ui', 'node_modules');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(foreign, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM') {
        fs.rmSync(foreign, { recursive: true, force: true });
        return;
      }
      throw error;
    }
    const runGit = fakeGit();

    try {
      expect(inspectTreeForReparsePoints(target)).toEqual(expect.objectContaining({
        ok: false,
        reason: 'worktree_reparse_point_forbidden',
        reparsePoints: [link],
      }));
      const result = removeWorktreeSafely({ target, cwd: root, force: true, runGit });
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        reason: 'worktree_reparse_point_forbidden',
      }));
      expect(runGit.mock.calls.some(([args]) => args.includes('remove'))).toBe(false);
      expect(fs.existsSync(foreign)).toBe(true);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });

  test('never permits the current worktree root as a removal target', () => {
    const runGit = fakeGit();

    const result = removeWorktreeSafely({ target: root, cwd: root, force: true, runGit });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'current_worktree_removal_forbidden',
    }));
    expect(runGit.mock.calls.some(([args]) => args.includes('remove'))).toBe(false);
  });
});
