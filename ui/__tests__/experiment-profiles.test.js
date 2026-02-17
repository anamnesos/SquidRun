const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadExperimentProfiles,
  resolveProfileAndCommand,
  buildExperimentEnv,
  fingerprintEnv,
} = require('../modules/experiment/profiles');
const { setProjectRoot, resetProjectRoot } = require('../config');

describe('experiment profiles', () => {
  let tempDir;
  let profilesPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-experiment-profiles-'));
    profilesPath = path.join(tempDir, 'experiment-profiles.json');
  });

  afterEach(() => {
    resetProjectRoot();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('creates default profile file when missing', () => {
    const result = loadExperimentProfiles({ profilesPath });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(fs.existsSync(profilesPath)).toBe(true);
    expect(result.profileIds).toEqual(expect.arrayContaining(['jest-suite', 'jest-file', 'lint']));
  });

  test('resolves command using profileId mapper and sanitized params', () => {
    const loaded = loadExperimentProfiles({ profilesPath });
    expect(loaded.ok).toBe(true);

    const resolved = resolveProfileAndCommand({
      profile_id: 'jest-file',
      input: {
        args: {
          file: '__tests__/team-memory-store.test.js',
        },
      },
    }, loaded.profiles);

    expect(resolved.ok).toBe(true);
    expect(resolved.profileId).toBe('jest-file');
    expect(resolved.command).toContain('__tests__/team-memory-store.test.js');
  });

  test('rejects invalid profile param values', () => {
    const loaded = loadExperimentProfiles({ profilesPath });
    expect(loaded.ok).toBe(true);

    const resolved = resolveProfileAndCommand({
      profileId: 'lint',
      input: {
        args: {
          file: '__tests__/x.test.js;rm -rf /',
        },
      },
    }, loaded.profiles);

    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toBe('invalid_or_missing_param');
  });

  test('rejects unknown profiles', () => {
    const loaded = loadExperimentProfiles({ profilesPath });
    expect(loaded.ok).toBe(true);

    const resolved = resolveProfileAndCommand({
      profileId: 'does-not-exist',
      input: { args: {} },
    }, loaded.profiles);

    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toBe('profile_not_found');
  });

  test('rejects missing required params', () => {
    const loaded = loadExperimentProfiles({ profilesPath });
    expect(loaded.ok).toBe(true);

    const resolved = resolveProfileAndCommand({
      profileId: 'jest-file',
      input: {
        args: {},
      },
    }, loaded.profiles);

    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toBe('invalid_or_missing_param');
    expect(resolved.param).toBe('file');
  });

  test('builds deterministic env fingerprint for allowlisted vars', () => {
    process.env.HIVEMIND_TEST_ENV_ALLOW = '1';
    const env = buildExperimentEnv(['HIVEMIND_TEST_ENV_ALLOW']);
    expect(env.HIVEMIND_TEST_ENV_ALLOW).toBe('1');

    const fpA = fingerprintEnv(env);
    const fpB = fingerprintEnv({ ...env });
    expect(fpA).toBe(fpB);
    expect(typeof fpA).toBe('string');
    expect(fpA.length).toBeGreaterThan(10);
  });

  test('default profiles path follows project root changes after import', () => {
    const projectA = path.join(tempDir, 'project-a');
    const projectB = path.join(tempDir, 'project-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    setProjectRoot(projectA);
    const first = loadExperimentProfiles({});
    expect(first.ok).toBe(true);
    expect(first.profilesPath).toBe(path.join(projectA, '.hivemind', 'runtime', 'experiment-profiles.json'));

    setProjectRoot(projectB);
    const second = loadExperimentProfiles({});
    expect(second.ok).toBe(true);
    expect(second.profilesPath).toBe(path.join(projectB, '.hivemind', 'runtime', 'experiment-profiles.json'));
  });
});
