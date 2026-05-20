'use strict';

const fs = require('fs');
const path = require('path');

const {
  classifyMiraOwnedPath,
  diffTouchesMiraSystemMapGuardWiring,
  diffTouchesMiraTelegramRoute,
  evaluateMiraSystemMapGuard,
  parseNameStatus,
} = require('../scripts/mira-system-map-guard');

describe('mira-system-map-guard', () => {
  test('requires the system map when core Mira files are staged', () => {
    const result = evaluateMiraSystemMapGuard({
      stagedChanges: [
        { status: 'M', path: 'ui/modules/mira-core/presence-runtime-read-path-v0.js' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'missing_map',
    }));
    expect(result.message).toContain('docs/mira-system-map.md');
    expect(result.message).toContain('ui/modules/mira-core/presence-runtime-read-path-v0.js');
  });

  test('passes when a Mira-owned change stages the system map too', () => {
    const result = evaluateMiraSystemMapGuard({
      stagedChanges: [
        { status: 'M', path: 'mira/runtime/src/status.ts' },
        { status: 'M', path: 'docs/mira-system-map.md' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'covered',
      mapStaged: true,
    }));
  });

  test('fails plainly when the system map itself is deleted', () => {
    const result = evaluateMiraSystemMapGuard({
      stagedChanges: [
        { status: 'D', path: 'docs/mira-system-map.md' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'map_deleted',
    }));
    expect(result.message).toContain('cannot be deleted');
  });

  test('fails when the canonical system map path is renamed away', () => {
    const result = evaluateMiraSystemMapGuard({
      stagedChanges: parseNameStatus('R100\tdocs/mira-system-map.md\tdocs/mira-system-map-old.md'),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'map_renamed',
    }));
    expect(result.message).toContain('renamed');
  });

  test('requires the map when the guard script itself changes', () => {
    const result = evaluateMiraSystemMapGuard({
      stagedChanges: [
        { status: 'M', path: 'ui/scripts/mira-system-map-guard.js' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'missing_map',
    }));
    expect(result.message).toContain('Mira source-of-truth enforcement');
  });

  test('requires the map when the guard script itself is deleted', () => {
    const result = evaluateMiraSystemMapGuard({
      stagedChanges: [
        { status: 'D', path: 'ui/scripts/mira-system-map-guard.js' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'missing_map',
    }));
    expect(result.message).toContain('Mira source-of-truth enforcement');
  });

  test('pre-commit hook fails instead of skipping when guard script is missing', () => {
    const hookPath = path.resolve(__dirname, '..', '..', 'scripts', 'pre-commit.sh');
    const hookText = fs.readFileSync(hookPath, 'utf8');

    expect(hookText).toContain('Mira system map guard cannot be skipped');
    expect(hookText).toContain('FAILED=1');
    expect(hookText).not.toContain('skipping Mira system map guard');
  });

  test('only requires the map for pre-commit changes that touch guard wiring', () => {
    const unrelated = evaluateMiraSystemMapGuard({
      stagedChanges: [
        { status: 'M', path: 'scripts/pre-commit.sh' },
      ],
      diffProvider: () => [
        '@@ -1 +1 @@',
        '+echo "Gate 1: Python type checking..."',
      ].join('\n'),
    });

    expect(unrelated).toEqual(expect.objectContaining({
      ok: true,
      status: 'skipped',
    }));

    const wiring = evaluateMiraSystemMapGuard({
      stagedChanges: [
        { status: 'M', path: 'scripts/pre-commit.sh' },
      ],
      diffProvider: () => [
        '@@ -239 +239 @@',
        '-    node ui/scripts/mira-system-map-guard.js --staged',
      ].join('\n'),
    });

    expect(wiring).toEqual(expect.objectContaining({
      ok: false,
      status: 'missing_map',
    }));
    expect(wiring.message).toContain('Pre-commit Mira system map guard wiring');
  });

  test('does not require the map for unrelated files', () => {
    const result = evaluateMiraSystemMapGuard({
      stagedChanges: [
        { status: 'M', path: 'README.md' },
        { status: 'M', path: 'ui/scripts/jest-staged.js' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'skipped',
    }));
  });

  test('classifies the explicit Mira-owned path families', () => {
    expect(classifyMiraOwnedPath('mira/runtime/src/server.ts')).toBe('New Mira product root');
    expect(classifyMiraOwnedPath('ui/modules/mira-lab-surface.js')).toBe('Mira Lab reply surface');
    expect(classifyMiraOwnedPath('ui/modules/mira-local-text-ui-surface.js')).toBe('Mira module surface');
    expect(classifyMiraOwnedPath('ui/modules/mira-work-evidence-gate.js')).toBe('Mira module surface');
    expect(classifyMiraOwnedPath('ui/modules/ipc/mira-local-text-ui-surface-handlers.js')).toBe('Mira IPC surface');
    expect(classifyMiraOwnedPath('ui/modules/ipc/mira-coordinator-snapshot-handlers.js')).toBe('Mira IPC surface');
    expect(classifyMiraOwnedPath('ui/modules/ipc/settings-handlers.js')).toBeNull();
    expect(classifyMiraOwnedPath('ui/modules/main/mira-lab-window.js')).toBe('Mira Lab window route');
    expect(classifyMiraOwnedPath('ui/modules/tabs/mira-local-text.js')).toBe('Mira local text tab');
    expect(classifyMiraOwnedPath('ui/mira-lab-renderer.js')).toBe('Mira Lab renderer surface');
    expect(classifyMiraOwnedPath('ui/styles/tabs/mira-local-text.css')).toBe('Mira local text style');
    expect(classifyMiraOwnedPath('ui/scripts/hm-mira-lab-prompt.js')).toBe('Mira script surface');
    expect(classifyMiraOwnedPath('ui/scripts/mira-system-map-guard.js')).toBe('Mira source-of-truth enforcement');
    expect(classifyMiraOwnedPath('ui/__tests__/mira-presence-runtime-state-v0.test.js')).toBe('Mira test coverage');
    expect(classifyMiraOwnedPath('ui/__tests__/fixtures/mira-presence-runtime-contract.json')).toBe('Mira fixture contract');
    expect(classifyMiraOwnedPath('docs/mira-presence-runtime-acceptance-v0.md')).toBe('Mira doc/contract');
  });

  test('classifies voice transport paths from the system map', () => {
    expect(classifyMiraOwnedPath('ui/modules/voice-broker.js')).toBe('Mira voice transport');
    expect(classifyMiraOwnedPath('ui/modules/phone-voice-client.js')).toBe('Mira phone voice transport');
    expect(classifyMiraOwnedPath('ui/modules/ipc/voice-broker-handlers.js')).toBe('Mira voice IPC route');
    expect(classifyMiraOwnedPath('ui/scripts/hm-voice-broker.js')).toBe('Mira voice script surface');
    expect(classifyMiraOwnedPath('ui/scripts/hm-phone-voice.js')).toBe('Mira voice script surface');
    expect(classifyMiraOwnedPath('ui/scripts/hm-voice-say.js')).toBe('Mira voice script surface');
  });

  test('only classifies Telegram scripts when the diff touches Mira route semantics', () => {
    expect(diffTouchesMiraTelegramRoute([
      '@@ -1 +1 @@',
      '+const retryDelayMs = 5000;',
    ].join('\n'))).toBe(false);

    expect(diffTouchesMiraTelegramRoute([
      '@@ -1 +1 @@',
      '+await sendMiraLivePrompt({ text });',
    ].join('\n'))).toBe(true);

    expect(classifyMiraOwnedPath(
      'ui/scripts/hm-telegram-send.js',
      () => '+const retryDelayMs = 5000;'
    )).toBeNull();

    expect(classifyMiraOwnedPath(
      'ui/scripts/hm-telegram-send.js',
      () => '+await routeMainTelegramInboundToMira(update);'
    )).toBe('Mixed route file change touches Mira route/voice semantics');
  });

  test('only classifies mixed main and poller files when the diff touches Mira route or voice semantics', () => {
    const unrelated = () => '+const genericWindowTitle = "SquidRun";';
    const miraRoute = () => '+await sendMiraLivePrompt({ text });';
    const voiceRoute = () => '+await voiceBroker.startSession({ mode: "mira" });';

    expect(classifyMiraOwnedPath('ui/modules/main/squidrun-app.js', unrelated)).toBeNull();
    expect(classifyMiraOwnedPath('ui/modules/main/squidrun-app.js', miraRoute)).toBe('Mixed route file change touches Mira route/voice semantics');
    expect(classifyMiraOwnedPath('ui/modules/telegram-poller.js', unrelated)).toBeNull();
    expect(classifyMiraOwnedPath('ui/modules/telegram-poller.js', miraRoute)).toBe('Mixed route file change touches Mira route/voice semantics');
    expect(classifyMiraOwnedPath('ui/modules/main/telegram-poller-worker.js', voiceRoute)).toBe('Mixed route file change touches Mira route/voice semantics');
  });

  test('detects pre-commit Mira guard wiring text only', () => {
    expect(diffTouchesMiraSystemMapGuardWiring('+echo "Gate 1"')).toBe(false);
    expect(diffTouchesMiraSystemMapGuardWiring('-node ui/scripts/mira-system-map-guard.js --staged')).toBe(true);
    expect(diffTouchesMiraSystemMapGuardWiring('+echo "Mira system map guard"')).toBe(true);
  });

  test('parses name-status output including renames', () => {
    expect(parseNameStatus([
      'M\tdocs/mira-system-map.md',
      'A\tmira/runtime/src/new-file.ts',
      'R100\tui/scripts/old.js\tui/scripts/hm-mira-new.js',
    ].join('\n'))).toEqual([
      { status: 'M', path: 'docs/mira-system-map.md', oldPath: '' },
      { status: 'A', path: 'mira/runtime/src/new-file.ts', oldPath: '' },
      { status: 'R100', path: 'ui/scripts/hm-mira-new.js', oldPath: 'ui/scripts/old.js' },
    ]);
  });
});
