/**
 * Scoped-profile trigger roots must FAIL CLOSED.
 *
 * THE LEAK: getProfileTelegramTriggerPaths fell back to `getProjectRoot()` —
 * MAIN's tree — when no profile root could be resolved, so an unresolvable
 * scoped profile's inbound message was written into main's trigger path.
 * Delivering nowhere is recoverable and visible; delivering into the wrong
 * profile is a privacy failure that looks like success.
 *
 * WHY THIS FILE WAS REWRITTEN. The first version was false-green and would have
 * passed with the bug present:
 *   - the outcome was driven by THIS machine's profile config, not by the
 *     branch under test, so neither branch was actually exercised on purpose;
 *   - the "positive" case set SQUIDRUN_PROFILE_ROOT_sideprofile, which the
 *     resolver does not support, so it asserted nothing about overrides;
 *   - its override literal 'D:\SquidRun\sideprofile' contained invalid escapes
 *     (\S, \E collapse silently) so the string was not even the path it looked
 *     like;
 *   - it asserted only that the filename contained 'triggers-sideprofile', which
 *     is true of a leaked main-root path too — the exact thing being prevented.
 * The resolver is now injectable so both branches are driven deterministically
 * and the positive case asserts the FULL exact path.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lane = require('../scripts/hm-telegram-poller-lane');
const { getProfileTelegramTriggerPaths, forwardToProfileTrigger } = lane;

describe('scoped-root resolution fails closed', () => {
  test('THE LEAK CASE: an unresolvable root yields NOTHING, never main root', () => {
    // Injected null => the exact branch that used to fall back to main.
    const paths = getProfileTelegramTriggerPaths('sideprofile', {}, {
      resolveProfileRoot: () => null,
    });
    expect(paths).toEqual([]);
  });

  test.each([null, undefined, '', false])('resolver returning %p also fails closed', (value) => {
    expect(
      getProfileTelegramTriggerPaths('sideprofile', {}, { resolveProfileRoot: () => value })
    ).toEqual([]);
  });

  test('a resolvable root yields the FULL EXACT path under that root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-root-'));
    try {
      const paths = getProfileTelegramTriggerPaths('sideprofile', {}, {
        resolveProfileRoot: () => root,
      });
      // Exact path, not a substring — a filename match would also pass for a
      // leaked main-root path, which is precisely the failure being guarded.
      expect(paths).toEqual([
        path.join(path.resolve(root), '.squidrun', 'triggers-sideprofile', 'architect.txt'),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('main and empty keys are not trigger-routed at all', () => {
    expect(getProfileTelegramTriggerPaths('main', {}, { resolveProfileRoot: () => '/anything' })).toEqual([]);
    expect(getProfileTelegramTriggerPaths('', {}, { resolveProfileRoot: () => '/anything' })).toEqual([]);
  });
});

describe('forwardToProfileTrigger refuses to write when the root is unresolvable', () => {
  test('returns missing_profile_trigger_path and performs ZERO writes', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync');
    try {
      // Unknown key so no machine profile config can resolve it.
      const res = forwardToProfileTrigger('definitely-not-a-registered-profile-xyz', 'inbound body', {});
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('missing_profile_trigger_path');
      // The load-bearing assertion: nothing was written ANYWHERE. A fail-closed
      // path that still touched the filesystem would be the leak in disguise.
      expect(writeSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      mkdirSpy.mockRestore();
    }
  });

  test('an empty message is refused before any path work', () => {
    const res = forwardToProfileTrigger('sideprofile', '   ', {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('empty_message');
  });
});
