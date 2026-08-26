'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseArgs,
  readRuntimeFiles,
  renderPostError,
  resolveRuntimeRole,
  usage,
} = require('../scripts/hm-room');

const BUILDER_LAUNCH_ID = `pl_${'2'.repeat(32)}`;
const BUILDER_BINDING_REVISION = `trb_${'b'.repeat(32)}`;

function boundBuilderEnv(overrides = {}) {
  return {
    SQUIDRUN_ROLE: 'builder',
    SQUIDRUN_PANE_ID: '2',
    SQUIDRUN_PROFILE: 'main',
    SQUIDRUN_PANE_LAUNCH_ID: BUILDER_LAUNCH_ID,
    SQUIDRUN_APP_GENERATION: 'app-session-512',
    ...overrides,
  };
}

describe('hm-room CLI identity and grammar', () => {
  test.each(['--author', '--role', '--member', '--member-id', '--profile', '--source', '--as'])(
    'rejects identity override flag %s',
    (flag) => expect(parseArgs(['post', flag, 'builder', 'hello']))
      .toEqual(expect.objectContaining({ ok: false, reason: 'room_cli_identity_override_forbidden' }))
  );

  test('requires the complete server-bound role, pane, profile, pane-launch, and generation tuple', () => {
    const bound = boundBuilderEnv();
    expect(resolveRuntimeRole(bound))
      .toEqual({
        ok: true, role: 'builder', paneId: '2', profileName: 'main',
        paneLaunchId: BUILDER_LAUNCH_ID, appGeneration: 'app-session-512',
      });
    expect(resolveRuntimeRole({ ...bound, SQUIDRUN_ROLE: 'oracle' }))
      .toEqual({ ok: false, reason: 'room_cli_runtime_identity_mismatch' });
    expect(resolveRuntimeRole({ SQUIDRUN_ROLE: 'builder' }))
      .toEqual({ ok: false, reason: 'room_cli_runtime_identity_incomplete' });
    expect(resolveRuntimeRole({ SQUIDRUN_PANE_ID: '2' }))
      .toEqual({ ok: false, reason: 'room_cli_runtime_identity_incomplete' });
    for (const key of Object.keys(bound)) {
      const partial = { ...bound };
      delete partial[key];
      expect(resolveRuntimeRole(partial)).toEqual({ ok: false, reason: 'room_cli_runtime_identity_incomplete' });
    }
    expect(resolveRuntimeRole({ ...bound, SQUIDRUN_PANE_LAUNCH_ID: `pl_${'f'.repeat(31)}` }))
      .toEqual({ ok: false, reason: 'room_cli_runtime_identity_unknown' });
    expect(resolveRuntimeRole({})).toEqual({ ok: false, reason: 'room_cli_runtime_identity_incomplete' });
  });

  test('binds credential selection to the same runtime generation and rejects DNS-prefix origins', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-hm-room-binding-'));
    const runtimeRoot = path.join(tempRoot, '.squidrun', 'runtime', 'team-room');
    const credentialsRoot = path.join(runtimeRoot, 'credentials');
    fs.mkdirSync(credentialsRoot, { recursive: true });
    const identity = resolveRuntimeRole(boundBuilderEnv());
    const credential = {
      role: 'builder', paneId: '2', profileName: 'main', paneLaunchId: BUILDER_LAUNCH_ID,
      appGeneration: 'app-session-512', bindingRevision: BUILDER_BINDING_REVISION,
      source: 'room_cli', token: 'a'.repeat(43),
    };
    fs.writeFileSync(path.join(credentialsRoot, 'builder.json'), JSON.stringify(credential));
    fs.writeFileSync(path.join(runtimeRoot, 'runtime.json'), JSON.stringify({
      origin: 'http://10.attacker.example:9910', appGeneration: 'app-session-512',
      cliBindings: { builder: { ...credential, token: undefined } },
    }));
    expect(readRuntimeFiles(tempRoot, identity)).toEqual({ ok: false, reason: 'room_cli_runtime_origin_invalid' });
    fs.writeFileSync(path.join(runtimeRoot, 'runtime.json'), JSON.stringify({
      origin: 'http://192.168.1.20:9910', appGeneration: 'app-session-511',
      cliBindings: { builder: { ...credential, token: undefined } },
    }));
    expect(readRuntimeFiles(tempRoot, identity)).toEqual({ ok: false, reason: 'room_cli_runtime_binding_mismatch' });
    fs.writeFileSync(path.join(runtimeRoot, 'runtime.json'), JSON.stringify({
      origin: 'http://192.168.1.20:9910', appGeneration: 'app-session-512',
      cliBindings: { builder: { ...credential, token: undefined } },
    }));
    expect(readRuntimeFiles(tempRoot, resolveRuntimeRole(boundBuilderEnv({
      SQUIDRUN_PANE_LAUNCH_ID: `pl_${'9'.repeat(32)}`,
    })))).toEqual({ ok: false, reason: 'room_cli_runtime_binding_mismatch' });
    fs.writeFileSync(path.join(runtimeRoot, 'runtime.json'), JSON.stringify({
      origin: 'http://192.168.1.20:9910', appGeneration: 'app-session-512',
      cliBindings: {
        builder: { ...credential, token: undefined, bindingRevision: `trb_${'c'.repeat(32)}` },
      },
    }));
    expect(readRuntimeFiles(tempRoot, identity)).toEqual({ ok: false, reason: 'room_cli_runtime_binding_mismatch' });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('parses activation-bound agent replies without author fields', () => {
    expect(parseArgs([
      'reply', '--activation', 'tra-1', '--reason', 'direct_answer', '--reentry', '--stdin',
    ])).toEqual(expect.objectContaining({
      ok: true,
      command: 'reply',
      activationId: 'tra-1',
      reason: 'direct_answer',
      reentry: true,
      stdin: true,
    }));
  });

  test('parses an explicit initiated post without activation or identity fields', () => {
    expect(parseArgs([
      'post', '--reason', 'new_evidence_or_action', '--stdin',
    ])).toEqual(expect.objectContaining({
      ok: true,
      command: 'post',
      activationId: null,
      reason: 'new_evidence_or_action',
      reentry: false,
      stdin: true,
    }));
  });

  test('parses repeatable local attachments and caps them at the room limit', () => {
    expect(parseArgs([
      'post', '--reason', 'new_evidence_or_action',
      '--attach', '.squidrun/coord/main.png',
      '--attach', '.squidrun/coord/settings.png',
      '--stdin',
    ])).toEqual(expect.objectContaining({
      ok: true,
      attachmentPaths: ['.squidrun/coord/main.png', '.squidrun/coord/settings.png'],
    }));
    expect(parseArgs(['post', '--reason', 'new_evidence_or_action', '--attach']))
      .toEqual({ ok: false, reason: 'room_cli_attachment_path_required' });
    expect(parseArgs([
      'post', '--reason', 'new_evidence_or_action',
      ...Array.from({ length: 13 }, (_, index) => ['--attach', `photo-${index}.png`]).flat(),
      'too many',
    ])).toEqual({ ok: false, reason: 'room_cli_attachment_count_exceeded' });
    expect(usage()).toContain('[--attach <path> ...]');
  });

  test('parses explicit notification classes and rejects missing values', () => {
    expect(parseArgs([
      'post', '--reason', 'new_evidence_or_action', '--notify', 'needs_operator', '--stdin',
    ])).toEqual(expect.objectContaining({
      ok: true,
      notificationClass: 'needs_operator',
    }));
    expect(parseArgs(['post', '--reason', 'new_evidence_or_action', '--notify']))
      .toEqual({ ok: false, reason: 'room_cli_notification_class_required' });
    expect(parseArgs(['post', '--reason', 'new_evidence_or_action', '--notify', '--stdin']))
      .toEqual({ ok: false, reason: 'room_cli_notification_class_required' });
  });

  test('makes the notification class and reason mapping visible where agents use the CLI', () => {
    expect(usage()).toContain(
      'question requires --reason real_question; needs_operator or failure requires --reason new_evidence_or_action or material_dissent_or_correction'
    );
    expect(usage()).toContain('Ordinary replies omit --notify.');
    expect(parseArgs([
      'reply', '--activation', 'tra-1', '--reason', 'real_question', '--notify', 'question', '--stdin',
    ])).toEqual(expect.objectContaining({
      ok: true,
      notificationClass: 'question',
      reason: 'real_question',
    }));
  });

  test('renders same-root coverage rejection with the covering agent', () => {
    expect(renderPostError({
      ok: false,
      reason: 'room_root_already_covered',
      details: { coveredByAgent: 'builder' },
    })).toBe('already covered on this root by builder');
    expect(renderPostError({ ok: false, reason: 'room_agent_root_duplicate' }))
      .toBe('that agent root was already posted moments ago');
    expect(renderPostError({ ok: false, reason: 'room_activation_not_found' }))
      .toBe('room_activation_not_found');
  });
});
