const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerUserProfileHandlers } = require('../modules/ipc/user-profile-handlers');

describe('User Profile IPC Handlers', () => {
  let harness;
  let tempRoot;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-user-profile-'));
    ctx = createDefaultContext({
      ipcMain: harness.ipcMain,
      PROJECT_ROOT: tempRoot,
    });
    registerUserProfileHandlers(ctx);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('get-user-profile returns empty editable fields when file is missing', async () => {
    const result = await harness.invoke('get-user-profile');

    expect(result.success).toBe(true);
    expect(result.profile.name).toBe('');
    expect(result.profile.experience_level).toBe('');
    expect(result.profile.communication_style).toBe('');
    expect(result.profile.domain_expertise).toBe('');
    expect(result.profile.notes).toBe('');
    expect(result.profile.schema).toBeTruthy();
    expect(result.path).toBe(path.join(tempRoot, 'user-profile.json'));
  });

  test('save-user-profile creates file and writes editable fields', async () => {
    const payload = {
      name: 'James',
      experience_level: 'tinkerer',
      communication_style: 'terse',
      domain_expertise: 'Strong JS/Electron',
      notes: 'Keep answers concise.',
      schema: {
        experience_level: {
          tinkerer: 'Custom text',
        },
        communication_style: {
          terse: 'Custom terse',
        },
      },
    };

    const result = await harness.invoke('save-user-profile', payload);
    const profilePath = path.join(tempRoot, 'user-profile.json');
    const saved = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const onboardingStatePath = path.join(tempRoot, '.squidrun', 'onboarding-state.json');
    const onboardingState = JSON.parse(fs.readFileSync(onboardingStatePath, 'utf8'));

    expect(result.success).toBe(true);
    expect(saved.name).toBe('James');
    expect(saved.experience_level).toBe('tinkerer');
    expect(saved.communication_style).toBe('terse');
    expect(saved.domain_expertise).toBe('Strong JS/Electron');
    expect(saved.notes).toBe('Keep answers concise.');
    expect(saved.schema).toEqual(payload.schema);
    expect(onboardingState.onboarding_complete).toBe(true);
    expect(onboardingState.user_name).toBe('James');
    expect(onboardingState.workspace_path).toBe(tempRoot);
  });

  test('save-user-profile preserves existing schema as-is', async () => {
    const profilePath = path.join(tempRoot, 'workspace', 'user-profile.json');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(
      profilePath,
      `${JSON.stringify({
        name: 'Before',
        experience_level: 'developer',
        communication_style: 'balanced',
        domain_expertise: 'Backend',
        notes: 'Original notes',
        schema: {
          experience_level: {
            developer: 'Existing schema text',
          },
          communication_style: {
            balanced: 'Existing comm schema text',
          },
        },
      }, null, 2)}\n`,
      'utf8'
    );

    const result = await harness.invoke('save-user-profile', {
      name: 'After',
      experience_level: 'expert',
      communication_style: 'terse',
      domain_expertise: 'Infra',
      notes: 'Updated notes',
      schema: {
        experience_level: { expert: 'New schema that should be ignored' },
      },
    });

    const saved = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

    expect(result.success).toBe(true);
    expect(saved.name).toBe('After');
    expect(saved.experience_level).toBe('expert');
    expect(saved.communication_style).toBe('terse');
    expect(saved.domain_expertise).toBe('Infra');
    expect(saved.notes).toBe('Updated notes');
    expect(saved.schema).toEqual({
      experience_level: {
        developer: 'Existing schema text',
      },
      communication_style: {
        balanced: 'Existing comm schema text',
      },
    });
  });

  test('unregister removes user profile handlers', () => {
    registerUserProfileHandlers.unregister({ ipcMain: harness.ipcMain });
    expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('get-user-profile');
    expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('save-user-profile');
  });
});
