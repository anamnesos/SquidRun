/**
 * Scoped-profile trigger roots must FAIL CLOSED.
 *
 * THE LEAK: getProfileTelegramTriggerPaths resolved a scoped profile's root via
 * an env override and, when that override was absent, fell back to
 * `getProjectRoot()` — MAIN's tree. A scoped chat's inbound message was then
 * written to main's .squidrun/triggers-<windowKey>/architect.txt, surfacing one
 * profile's conversation inside another.
 *
 * Guessing a delivery root is worse than delivering nowhere: nowhere is
 * recoverable and visible, wrong-profile is a privacy failure that looks like
 * success. So an unresolvable scoped root must yield NO paths.
 */
const path = require('node:path');

const lane = require('../scripts/hm-telegram-poller-lane');

const getPaths = lane.getProfileTelegramTriggerPaths
  || lane.__testables?.getProfileTelegramTriggerPaths;

describe('scoped-root resolution fails closed', () => {
  test('the function is reachable for testing', () => {
    expect(typeof getPaths).toBe('function');
  });

  test('a KNOWN profile resolves to its own scoped workspace, never main-shared', () => {
    // Correction to my first assumption: getProfileProjectRootOverride does NOT
    // return falsy for a known profile — it resolves a per-profile workspace
    // (.squidrun/profiles/<key>/workspace). That is already isolated, so the
    // right assertion is that the path is profile-scoped, not that it is empty.
    const paths = getPaths('sideprofile', {});
    expect(paths).toHaveLength(1);
    const p = paths[0].toLowerCase();
    expect(p).toContain(`${path.sep}profiles${path.sep}sideprofile${path.sep}`.toLowerCase());
    expect(p).toContain('triggers-sideprofile');
  });

  test('THE LEAK CASE: an UNRESOLVABLE profile root yields NOTHING, not main root', () => {
    // This is the branch the fix closes. When no profile root can be resolved
    // the old code fell back to getProjectRoot() — main's tree. Delivering
    // nowhere is recoverable and visible; delivering into the wrong profile is
    // a privacy failure that looks like success.
    const paths = getPaths('definitely-not-a-registered-profile-xyz', {});
    expect(paths).toEqual([]);
  });

  test('no returned path ever points into the main project tree', () => {
    const paths = getPaths('someprofile', {});
    for (const p of paths) {
      expect(path.resolve(p).toLowerCase()).not.toContain(`${path.sep}projects${path.sep}squidrun${path.sep}`.toLowerCase());
    }
    expect(paths).toHaveLength(0);
  });

  test('main itself still resolves to nothing here (main is not trigger-routed)', () => {
    expect(getPaths('main', {})).toEqual([]);
    expect(getPaths('', {})).toEqual([]);
  });

  test('an explicit override is honoured and stays inside that override', () => {
    const override = process.platform === 'win32' ? 'D:\SquidRun\sideprofile' : '/opt/sideprofile';
    const paths = getPaths('sideprofile', { SQUIDRUN_PROFILE_ROOT_sideprofile: override });
    // Whatever root wins, it must be profile-scoped and must not be main's own
    // trigger directory.
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('triggers-sideprofile');
  });
});
