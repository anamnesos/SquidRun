'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const proof = require('../modules/main/codex-computer-use-proof');

const PROJECT_ROOT = 'D:\\projects\\squidrun';
const HOOK_SCRIPT = path.join(
  PROJECT_ROOT,
  'ui',
  'scripts',
  'codex-computer-use-post-tool-proof.js'
);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readyGeneration() {
  return {
    schema: 'squidrun.codex_computer_use_pipe_generation.v1',
    pipePath: '\\\\.\\pipe\\codex-computer-use-f214874c-b61b-4d31-ba3a-e2618aa80e34',
    configPath: 'C:\\Users\\Example User\\.codex\\config.toml',
    projectRoot: PROJECT_ROOT,
    paneId: '3',
    profile: 'main',
  };
}

async function armedClaim(options = {}) {
  const root = makeTempDir('squidrun-cua-proof-test-');
  const clientPath = path.join(root, 'computer-use-client.mjs');
  fs.writeFileSync(clientPath, 'export const setupComputerUseRuntime = () => {};\n');
  const codexExecutablePath = path.join(root, 'OpenAI Codex', 'codex.exe');
  fs.mkdirSync(path.dirname(codexExecutablePath), { recursive: true });
  fs.writeFileSync(codexExecutablePath, 'approved Codex executable fixture\n');
  const codexExecutableSha256 = proof.sha256File(codexExecutablePath);
  const integrity = [
    { name: 'verifier', path: path.join(root, 'verifier.js'), sha256: 'a'.repeat(64) },
    { name: 'hookScript', path: HOOK_SCRIPT, sha256: proof.sha256File(HOOK_SCRIPT) },
    { name: 'trustManifest', path: path.join(root, 'manifest.json'), sha256: 'b'.repeat(64) },
  ];
  const claim = {
    claimId: options.claimId || 'claim-1',
    paneId: options.paneId || '3',
    projectRoot: PROJECT_ROOT,
    workspace: PROJECT_ROOT,
    platform: 'win32',
    generation: readyGeneration(),
  };
  const result = await proof.armCodexComputerUseProofClaim({
    claim,
    projectRoot: PROJECT_ROOT,
    clientPath,
    auditHookTrust: async () => ({
      ok: true,
      digest: 'c'.repeat(64),
      manifestPath: integrity[2].path,
    }),
    captureIntegrity: async () => integrity,
    makeProofDirectory: () => root,
    randomBytes: () => Buffer.alloc(32, 7),
    resolveCodexExecutable: options.resolveCodexExecutable || (async () => ({
      ok: true,
      path: codexExecutablePath,
      sha256: codexExecutableSha256,
      packageVersion: '0.146.0',
      platformPackageVersion: '0.146.0-win32-x64',
      targetTriple: 'x86_64-pc-windows-msvc',
    })),
  });
  expect(result.ok).toBe(true);
  claim.proof.state = 'pending';
  claim.proof.deadlineAtMs = Date.now() + 60000;
  const codexHome = path.join(root, '.codex');
  const transcriptPath = path.join(codexHome, 'sessions', 'rollout.jsonl');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  return {
    root,
    claim,
    clientPath,
    codexExecutablePath,
    codexExecutableSha256,
    integrity,
    codexHome,
    transcriptPath,
    auditHookTrust: async () => ({ ok: true, digest: 'c'.repeat(64) }),
    captureIntegrity: async () => integrity,
  };
}

function canonicalHookPayload(state, overrides = {}) {
  return {
    session_id: 'session-1',
    turn_id: 'turn-1',
    tool_use_id: 'tool-1',
    transcript_path: state.transcriptPath,
    cwd: PROJECT_ROOT,
    tool_name: proof.CANONICAL_NODE_REPL_TOOL_NAME,
    tool_input: state.claim.proof.canonicalPlan.toolInput,
    tool_response: {
      _meta: {
        'codex/toolSurface': {
          kind: 'computerUse',
        },
      },
      structuredContent: {
        schema: proof.LIST_WINDOWS_PROOF_SCHEMA,
        operation: 'list_windows',
        ok: true,
        workingDirectory: PROJECT_ROOT,
        windowCount: 4,
      },
    },
    ...overrides,
  };
}

function runProofHook(state, payload) {
  return spawnSync(process.execPath, [HOOK_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...state.claim.proofSpawnEnv,
    },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
}

async function verifyJournal(state, overrides = {}) {
  return proof.verifyCodexComputerUseProofJournal(state.claim, {
    codexHome: state.codexHome,
    auditHookTrust: state.auditHookTrust,
    captureIntegrity: state.captureIntegrity,
    consumedIds: state.consumedIds || (state.consumedIds = new Set()),
    ...overrides,
  });
}

describe('Codex Computer Use PostToolUse attestation', () => {
  test('binds the exact official wrapper path and exact one-field canonical tool input', async () => {
    const state = await armedClaim();
    const plan = state.claim.proof.canonicalPlan;

    expect(state.claim.proof.codexExecutable).toEqual(expect.objectContaining({
      path: state.codexExecutablePath,
      sha256: state.codexExecutableSha256,
      packageVersion: '0.146.0',
      platformPackageVersion: '0.146.0-win32-x64',
    }));
    expect(plan.toolInput).toEqual({ code: plan.snippet });
    expect(plan.snippet).toContain(`import(${JSON.stringify(
      require('url').pathToFileURL(state.clientPath).href
    )})`);
    expect(plan.snippet).toContain("await globalThis.sky.documentation('guidance');");
    expect(plan.snippet).toContain('await globalThis.sky.list_windows()');
    expect(plan.toolInputSha256).toBe(proof.sha256(JSON.stringify({ code: plan.snippet })));
  });

  test('accepts one signed exact call and consumes its session, turn, and tool IDs once', async () => {
    const state = await armedClaim();
    const hook = runProofHook(state, canonicalHookPayload(state));
    expect(hook.status).toBe(0);

    await expect(verifyJournal(state)).resolves.toEqual(expect.objectContaining({
      ok: true,
      authoritativeComputerUseReady: true,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      windowCount: 4,
    }));
    await expect(verifyJournal(state)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_proof_replay',
    }));
  });

  test('permanently poisons a generation when an earlier node_repl call precedes the exact call', async () => {
    const state = await armedClaim();
    runProofHook(state, canonicalHookPayload(state, {
      tool_use_id: 'tool-prior',
      tool_input: { code: '2 + 2' },
    }));
    runProofHook(state, canonicalHookPayload(state));

    await expect(verifyJournal(state)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_proof_duplicate_event',
    }));
  });

  test('rejects a direct setResponseMeta spoof even when it fabricates the expected metadata', async () => {
    const state = await armedClaim();
    runProofHook(state, canonicalHookPayload(state, {
      tool_input: {
        code: "globalThis.nodeRepl.setResponseMeta({'codex/toolSurface':{kind:'computerUse'}});",
      },
    }));

    await expect(verifyJournal(state)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'unexpected_node_repl_tool_input',
    }));
  });

  test('rejects refused official calls and missing Computer Use tool-surface metadata', async () => {
    const refused = await armedClaim({ claimId: 'claim-refused' });
    runProofHook(refused, canonicalHookPayload(refused, {
      tool_response: {
        isError: true,
        _meta: { 'codex/toolSurface': { kind: 'computerUse' } },
      },
    }));
    await expect(verifyJournal(refused)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'node_repl_tool_refused',
    }));

    const spoofed = await armedClaim({ claimId: 'claim-no-meta' });
    const payload = canonicalHookPayload(spoofed);
    delete payload.tool_response._meta;
    runProofHook(spoofed, payload);
    await expect(verifyJournal(spoofed)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'computer_use_tool_surface_missing',
    }));
  });

  test('rejects cross-pane and hand-authored attestations', async () => {
    const crossPane = await armedClaim({ claimId: 'claim-cross-pane' });
    runProofHook(crossPane, canonicalHookPayload(crossPane));
    crossPane.claim.paneId = '2';
    await expect(verifyJournal(crossPane)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'attestation_pane_mismatch',
    }));

    const handAuthored = await armedClaim({ claimId: 'claim-hand-authored' });
    fs.writeFileSync(handAuthored.claim.proof.journalPath, `${JSON.stringify({
      schema: proof.PROOF_ATTESTATION_SCHEMA,
      claimId: handAuthored.claim.claimId,
      signature: '0'.repeat(64),
    })}\n`);
    await expect(verifyJournal(handAuthored)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_proof_signature_invalid',
    }));
  });

  test('fails closed on timeout, official-wrapper drift, and tracked verifier drift', async () => {
    const timedOut = await armedClaim({ claimId: 'claim-timeout' });
    timedOut.claim.proof.deadlineAtMs = Date.now() - 1;
    await expect(verifyJournal(timedOut)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_proof_timeout',
    }));

    const wrapperDrift = await armedClaim({ claimId: 'claim-wrapper-drift' });
    runProofHook(wrapperDrift, canonicalHookPayload(wrapperDrift));
    fs.appendFileSync(wrapperDrift.clientPath, '// drift\n');
    await expect(verifyJournal(wrapperDrift)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'official_computer_use_client_drift',
    }));

    const verifierDrift = await armedClaim({ claimId: 'claim-verifier-drift' });
    runProofHook(verifierDrift, canonicalHookPayload(verifierDrift));
    verifierDrift.captureIntegrity = async () => [
      { ...verifierDrift.integrity[0], sha256: 'd'.repeat(64) },
      ...verifierDrift.integrity.slice(1),
    ];
    await expect(verifyJournal(verifierDrift)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_proof_integrity_drift',
    }));

    const executableDrift = await armedClaim({ claimId: 'claim-executable-drift' });
    runProofHook(executableDrift, canonicalHookPayload(executableDrift));
    fs.appendFileSync(executableDrift.codexExecutablePath, 'drift\n');
    await expect(verifyJournal(executableDrift)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_executable_drift',
    }));
  });

  test('requires the exact hook definition and target digest at arm and consume', async () => {
    const root = makeTempDir('squidrun-cua-arm-hook-drift-');
    const clientPath = path.join(root, 'computer-use-client.mjs');
    fs.writeFileSync(clientPath, 'export const setupComputerUseRuntime = () => {};\n');
    const claim = {
      claimId: 'claim-arm-hook-drift',
      paneId: '3',
      projectRoot: PROJECT_ROOT,
      workspace: PROJECT_ROOT,
      platform: 'win32',
      generation: readyGeneration(),
    };
    await expect(proof.armCodexComputerUseProofClaim({
      claim,
      projectRoot: PROJECT_ROOT,
      clientPath,
      auditHookTrust: async () => ({
        ok: false,
        reason: 'codex_hook_trust_manifest_drift',
      }),
      captureIntegrity: jest.fn(),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_hook_trust_manifest_drift',
    }));
    expect(claim.proof).toBeUndefined();

    const consumeDrift = await armedClaim({ claimId: 'claim-consume-hook-drift' });
    runProofHook(consumeDrift, canonicalHookPayload(consumeDrift));
    consumeDrift.auditHookTrust = async () => ({
      ok: true,
      digest: 'd'.repeat(64),
    });
    await expect(verifyJournal(consumeDrift)).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_hook_trust_manifest_drift',
    }));
  });
});

describe('Codex Computer Use full hook trust audit', () => {
  test.each([
    ['dotted', 'hooks.PostToolUse = [{ matcher = "Write" }]\n'],
    ['inline', 'hooks = { PostToolUse = [] }\n'],
    ['dotted in a similarly named section', '[hooksLegacy]\nhooks.PostToolUse = []\n'],
  ])('rejects %s top-level hook assignments outside recognized sections', (_label, content) => {
    expect(() => proof.extractTomlHookSnapshot(content, 'user:config.toml'))
      .toThrow('hook-like assignment outside recognized hook section grammar');
  });

  test('keeps the ordinary hooks feature toggle distinct from hook definitions', () => {
    expect(proof.extractTomlHookSnapshot(
      '[features]\nhooks = true\n',
      'user:config.toml'
    )).toEqual(expect.objectContaining({
      definitionsCount: 0,
      enabledStateCount: 0,
      commandHooks: [],
    }));
  });

  test('extracts literal TOML command targets and refuses inline command tables', () => {
    const root = makeTempDir('squidrun-cua-toml-hook-target-');
    const targetPath = path.join(root, 'hook.ps1');
    fs.writeFileSync(targetPath, 'Write-Output "trusted"\n');
    const snapshot = proof.extractTomlHookSnapshot([
      '[[hooks.PostToolUse]]',
      'type = "command"',
      `command = 'pwsh -NoProfile -File "${targetPath}"'`,
      '',
    ].join('\n'), 'user:config.toml');
    expect(proof.snapshotCommandHookTargets(snapshot.commandHooks, {
      platform: 'win32',
    })).toEqual([{
      path: targetPath,
      sha256: proof.sha256File(targetPath),
    }]);
    expect(() => proof.extractTomlHookSnapshot(
      '[hooks]\nPostToolUse = [{ type = "command", command = "node hook.js" }]\n',
      'user:config.toml'
    )).toThrow('inline TOML command hook target is unresolved');
  });

  test('enumerates every enabled plugin manifest and fails on active hook definition drift', async () => {
    const root = makeTempDir('squidrun-cua-hook-audit-');
    const projectRoot = path.join(root, 'project');
    const codexHome = path.join(root, '.codex');
    const programData = path.join(root, 'ProgramData');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeJson(path.join(codexHome, 'hooks.json'), { hooks: {} });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[hooks.state]\n');
    const pluginRoot = path.join(
      codexHome,
      'plugins',
      'cache',
      'test-market',
      'guard',
      '1.0.0'
    );
    const guardScriptPath = path.join(pluginRoot, 'scripts', 'guard.sh');
    fs.mkdirSync(path.dirname(guardScriptPath), { recursive: true });
    fs.writeFileSync(guardScriptPath, '#!/usr/bin/env bash\nexit 0\n');
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
      name: 'guard',
      version: '1.0.0',
      hooks: './hooks.json',
    });
    writeJson(path.join(pluginRoot, 'hooks.json'), {
      hooks: {
        PostToolUse: [{
          matcher: 'Write',
          hooks: [{
            type: 'command',
            command: './scripts/guard.sh',
          }],
        }],
      },
    });
    const pluginList = {
      installed: [{
        pluginId: 'guard@test-market',
        name: 'guard',
        marketplaceName: 'test-market',
        version: '1.0.0',
        enabled: true,
      }],
    };
    const manifest = {
      schema: proof.HOOK_TRUST_MANIFEST_SCHEMA,
      projectRoot,
      codexVersion: '0.146.0',
      layers: proof.snapshotHookLayers({ projectRoot, codexHome, programData }),
      plugins: proof.snapshotEnabledPlugins(pluginList, { codexHome }),
    };
    expect(manifest.plugins[0].hookSources[0].commandTargets).toEqual([{
      path: guardScriptPath,
      sha256: proof.sha256File(guardScriptPath),
    }]);
    const pass = await proof.auditCodexHookTrust({
      projectRoot,
      codexHome,
      programData,
      codexVersion: '0.146.0',
      pluginList,
      manifest,
    });
    expect(pass.ok).toBe(true);

    writeJson(path.join(pluginRoot, 'hooks.json'), {
      hooks: {
        PostToolUse: [{
          matcher: 'Write|Edit',
          hooks: [{
            type: 'command',
            command: './scripts/guard.sh',
          }],
        }],
      },
    });
    const drift = await proof.auditCodexHookTrust({
      projectRoot,
      codexHome,
      programData,
      codexVersion: '0.146.0',
      pluginList,
      manifest,
    });
    expect(drift).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_hook_trust_manifest_drift',
    }));
  });

  test('pins user command-hook target bytes and detects script-only drift', async () => {
    const root = makeTempDir('squidrun-cua-user-hook-target-');
    const projectRoot = path.join(root, 'project');
    const codexHome = path.join(root, '.codex');
    const programData = path.join(root, 'ProgramData');
    const targetPath = path.join(codexHome, 'hooks', 'session-start.ps1');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, 'Write-Output "trusted"\n');
    writeJson(path.join(codexHome, 'hooks.json'), {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command:
              `pwsh -NoProfile -ExecutionPolicy Bypass -File "${targetPath}"`,
          }],
        }],
      },
    });
    const pluginList = { installed: [] };
    const manifest = {
      schema: proof.HOOK_TRUST_MANIFEST_SCHEMA,
      projectRoot,
      codexVersion: '0.146.0',
      layers: proof.snapshotHookLayers({ projectRoot, codexHome, programData }),
      plugins: [],
    };
    expect(manifest.layers.find((layer) => layer.id === 'user:hooks.json'))
      .toEqual(expect.objectContaining({
        commandTargets: [{
          path: targetPath,
          sha256: proof.sha256File(targetPath),
        }],
      }));
    await expect(proof.auditCodexHookTrust({
      projectRoot,
      codexHome,
      programData,
      codexVersion: '0.146.0',
      pluginList,
      manifest,
    })).resolves.toEqual(expect.objectContaining({ ok: true }));

    fs.appendFileSync(targetPath, 'Write-Output "drift"\n');
    await expect(proof.auditCodexHookTrust({
      projectRoot,
      codexHome,
      programData,
      codexVersion: '0.146.0',
      pluginList,
      manifest,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_hook_trust_manifest_drift',
    }));
  });

  test('activates only the documented default plugin hook path and roots relatives there', () => {
    const root = makeTempDir('squidrun-cua-default-plugin-hook-');
    const codexHome = path.join(root, '.codex');
    const pluginRoot = path.join(
      codexHome,
      'plugins',
      'cache',
      'test-market',
      'guard',
      '1.0.0'
    );
    const activeTarget = path.join(pluginRoot, 'scripts', 'active.sh');
    fs.mkdirSync(path.dirname(activeTarget), { recursive: true });
    fs.writeFileSync(activeTarget, '#!/usr/bin/env bash\nexit 0\n');
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
      name: 'guard',
      version: '1.0.0',
    });
    writeJson(path.join(pluginRoot, 'hooks', 'hooks.json'), {
      hooks: {
        PostToolUse: [{
          hooks: [{
            type: 'command',
            command: './scripts/active.sh',
          }],
        }],
      },
    });
    writeJson(path.join(pluginRoot, 'hooks.json'), {
      hooks: {
        PostToolUse: [{
          hooks: [{
            type: 'command',
            command: './scripts/inactive.sh',
          }],
        }],
      },
    });
    const snapshots = proof.snapshotEnabledPlugins({
      installed: [{
        pluginId: 'guard@test-market',
        name: 'guard',
        marketplaceName: 'test-market',
        version: '1.0.0',
        enabled: true,
      }],
    }, { codexHome });

    expect(snapshots[0].hookSources).toEqual([{
      relativePath: 'hooks/hooks.json',
      sha256: proof.sha256File(path.join(pluginRoot, 'hooks', 'hooks.json')),
      commandTargets: [{
        path: activeTarget,
        sha256: proof.sha256File(activeTarget),
      }],
    }]);
    expect(snapshots[0].extraHookLikeFiles).toEqual([{
      relativePath: 'hooks.json',
      sha256: proof.sha256File(path.join(pluginRoot, 'hooks.json')),
    }]);
  });

  test('fails closed on dynamic, relative, and compound command-hook targets', () => {
    const hooksFile = (command) => ({
      hooks: {
        PostToolUse: [{
          hooks: [{ type: 'command', command }],
        }],
      },
    });
    for (const command of [
      'node "${PLUGIN_ROOT}/guard.js"',
      'node guard.js',
      './scripts/guard.sh',
      'node "C:\\trusted\\guard.js" && node "C:\\other\\guard.js"',
    ]) {
      const commandHooks = proof.validateHooksFile(
        hooksFile(command),
        'guard@test-market:hooks.json'
      );
      expect(() => proof.snapshotCommandHookTargets(commandHooks, {
        platform: 'win32',
      })).toThrow(/command hook/u);
    }

    const root = makeTempDir('squidrun-cua-plugin-root-escape-');
    const pluginRoot = path.join(root, 'plugin');
    const outsideTarget = path.join(root, 'outside.sh');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(outsideTarget, '#!/usr/bin/env bash\n');
    expect(() => proof.resolveLiteralCommandHookTarget('./../outside.sh', {
      sourceId: 'guard@test-market:hooks.json',
      trustedRoot: pluginRoot,
      platform: 'win32',
    })).toThrow('escapes its trusted source root');
  });

  test('fails closed when an unapproved managed or unknown hook layer appears', async () => {
    const root = makeTempDir('squidrun-cua-managed-hook-');
    const projectRoot = path.join(root, 'project');
    const codexHome = path.join(root, '.codex');
    const programData = path.join(root, 'ProgramData');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[hooks.state]\n');
    const pluginList = { installed: [] };
    const manifest = {
      schema: proof.HOOK_TRUST_MANIFEST_SCHEMA,
      projectRoot,
      codexVersion: '0.146.0',
      layers: proof.snapshotHookLayers({ projectRoot, codexHome, programData }),
      plugins: [],
    };
    fs.writeFileSync(path.join(codexHome, 'managed_config.toml'), '[hooks]\n');

    const result = await proof.auditCodexHookTrust({
      projectRoot,
      codexHome,
      programData,
      codexVersion: '0.146.0',
      pluginList,
      manifest,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_hook_trust_audit_failed',
    }));
  });
});

describe('fresh target-only Codex invocation', () => {
  test('resolves and hashes the official platform binary from the Codex package layout', () => {
    const root = makeTempDir('squidrun-cua-codex-package-');
    const packageRoot = path.join(root, 'node_modules', '@openai', 'codex');
    const platformRoot = path.join(
      packageRoot,
      'node_modules',
      '@openai',
      'codex-win32-x64'
    );
    const executablePath = path.join(
      platformRoot,
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    );
    writeJson(path.join(packageRoot, 'package.json'), {
      name: '@openai/codex',
      version: '0.146.0',
    });
    writeJson(path.join(platformRoot, 'package.json'), {
      name: '@openai/codex',
      version: '0.146.0-win32-x64',
    });
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'official vendor binary fixture\n');

    expect(proof.resolveTrustedCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      codexPackageRoot: packageRoot,
      env: {},
    })).toEqual(expect.objectContaining({
      ok: true,
      path: fs.realpathSync(executablePath),
      sha256: proof.sha256File(executablePath),
      packageVersion: '0.146.0',
      platformPackageVersion: '0.146.0-win32-x64',
      targetTriple: 'x86_64-pc-windows-msvc',
    }));
  });

  test('adds the exact hook trust bypass and quoting only to an armed fresh command', async () => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';
    const invocation = proof.buildCodexComputerUseProofInvocation(
      'codex --yolo',
      state.claim
    );

    expect(invocation.ok).toBe(true);
    expect(invocation.command).toContain('--dangerously-bypass-hook-trust');
    expect(invocation.command).toContain('hooks.PostToolUse=[');
    expect(invocation.command).toContain("matcher=''^mcp__node_repl__js$''");
    expect(invocation.command).toContain(
      "shell_environment_policy.exclude=[''SQUIDRUN_CUA_*'']"
    );
    expect(invocation.environmentOverrideType).toBe('array');
    expect(proof.parseShellEnvironmentPolicyExcludeOverride(
      invocation.environmentOverride
    )).toEqual({
      ok: true,
      reason: 'shell_environment_policy_exclude_toml_sequence_parsed',
      type: 'array',
      exclude: ['SQUIDRUN_CUA_*'],
    });
    expect(invocation.command).not.toContain(state.claim.proof.secret);
    expect(invocation.command).not.toContain('codex-computer-use.exe');
    expect(invocation.command).toContain(
      `& '${state.codexExecutablePath.replace(/'/gu, "''")}'`
    );
  });

  const windowsNativeArgvTest = process.platform === 'win32' ? test : test.skip;
  windowsNativeArgvTest(
    'preserves the TOML exclude sequence through PowerShell Windows-native argv',
    async () => {
      const state = await armedClaim();
      state.claim.proof.state = 'armed';
      const invocation = proof.buildCodexComputerUseProofInvocation(
        'codex --yolo',
        state.claim,
        { platform: 'win32' }
      );
      const root = makeTempDir('squidrun-cua-native-argv-');
      const capturePath = path.join(root, 'capture-native-argv.js');
      fs.writeFileSync(
        capturePath,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
      );
      const quotePowerShellLiteral = (value) =>
        `'${String(value).replace(/'/gu, "''")}'`;
      const nativeProbeCommand = [
        `& ${quotePowerShellLiteral(process.execPath)}`,
        quotePowerShellLiteral(capturePath),
        invocation.addedArguments,
      ].join(' ');

      const captured = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', nativeProbeCommand],
        {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        }
      );

      expect(captured.status).toBe(0);
      expect(captured.stderr).toBe('');
      const nativeArgv = JSON.parse(captured.stdout);
      expect(nativeArgv).toEqual([
        '--dangerously-bypass-hook-trust',
        '-c',
        invocation.hookOverride,
        '-c',
        "shell_environment_policy.exclude=['SQUIDRUN_CUA_*']",
      ]);
      expect(proof.parseShellEnvironmentPolicyExcludeOverride(
        nativeArgv[nativeArgv.length - 1]
      )).toEqual(expect.objectContaining({
        ok: true,
        type: 'array',
        exclude: ['SQUIDRUN_CUA_*'],
      }));
    }
  );

  test.each([
    ['statement separator', 'codex --yolo; node forge.js'],
    ['pipeline', 'codex --yolo | node forge.js'],
    ['newline', 'codex --yolo\nnode forge.js'],
    ['background operator', 'codex --yolo & node forge.js'],
  ])('refuses sibling-command injection through %s', async (_label, command) => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';

    expect(proof.buildCodexComputerUseProofInvocation(
      command,
      state.claim
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_command_syntax_refused',
    }));
  });

  test.each([
    ['output redirection', 'codex --yolo > proof.txt'],
    ['stream redirection', 'codex --yolo 2> proof.txt'],
    ['subexpression', 'codex --yolo $(node forge.js)'],
    ['environment expansion', 'codex --yolo "$env:SQUIDRUN_CUA_PROOF_SECRET"'],
    ['splatting', 'codex --yolo @args'],
    ['comment', 'codex --yolo # ignored'],
    ['escape expression', 'codex --yolo "`nnode forge.js"'],
  ])('refuses PowerShell %s syntax', async (_label, command) => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';

    expect(proof.buildCodexComputerUseProofInvocation(
      command,
      state.claim
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_command_syntax_refused',
    }));
  });

  test('accepts an absolute quoted Codex executable and ordinary literal argv', async () => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';
    const invocation = proof.buildCodexComputerUseProofInvocation(
      `"${state.codexExecutablePath}" --model "gpt-5.6-sol" --search `
        + '--sandbox workspace-write --ask-for-approval never --no-alt-screen',
      state.claim,
      { platform: 'win32' }
    );

    expect(invocation).toEqual(expect.objectContaining({
      ok: true,
      argv: [
        state.codexExecutablePath,
        '--model',
        'gpt-5.6-sol',
        '--search',
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'never',
        '--no-alt-screen',
      ],
    }));
    expect(invocation.command).toContain(
      `& '${state.codexExecutablePath.replace(/'/gu, "''")}' `
        + "'--model' 'gpt-5.6-sol'"
    );
    expect(invocation.command).toContain("'--ask-for-approval' 'never'");
    expect(invocation.command).toContain('--dangerously-bypass-hook-trust');
  });

  test.each([
    ['codex.exe', 'codex.exe'],
    ['codex.cmd', 'codex.cmd'],
  ])('refuses an arbitrary absolute %s even with safe argv', async (_label, fileName) => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';
    const attackerPath = path.join(state.root, 'attacker', fileName);
    fs.mkdirSync(path.dirname(attackerPath), { recursive: true });
    fs.writeFileSync(attackerPath, 'forge the proof\n');

    expect(proof.buildCodexComputerUseProofInvocation(
      `"${attackerPath}" --yolo`,
      state.claim,
      { platform: 'win32' }
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_executable_not_approved',
    }));
  });

  test('rechecks the approved executable hash before building the command', async () => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';
    fs.appendFileSync(state.codexExecutablePath, 'drift\n');

    expect(proof.buildCodexComputerUseProofInvocation(
      'codex --yolo',
      state.claim
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_executable_drift',
    }));
  });

  test.each([
    ['bare terminator', 'codex --'],
    ['terminator after a safe flag', 'codex --yolo -- forge-proof'],
  ])('refuses a Codex %s before appended proof controls', async (_label, command) => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';

    expect(proof.buildCodexComputerUseProofInvocation(
      command,
      state.claim
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_command_argument_terminator_refused',
    }));
  });

  test.each([
    ['runtime config', "codex -c 'hooks.PostToolUse=[]'"],
    ['named runtime config', "codex '--config=hooks.PostToolUse=[]'"],
    ['profile overlay', 'codex --profile forged'],
    ['working-directory config source', 'codex -C D:\\other-project'],
    ['feature disable', 'codex --disable hooks'],
    ['feature disable with prompt', 'codex --disable hooks forge-proof'],
    ['feature enable', 'codex --enable hooks'],
  ])('refuses an unaudited %s override', async (_label, command) => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';

    expect(proof.buildCodexComputerUseProofInvocation(
      command,
      state.claim,
      { platform: 'win32' }
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_command_configuration_refused',
    }));
  });

  test.each([
    ['startup prompt', 'codex forge-proof'],
    ['startup subcommand', 'codex exec forge-proof'],
  ])('refuses a %s so the controller owns the first prompt', async (_label, command) => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';

    expect(proof.buildCodexComputerUseProofInvocation(
      command,
      state.claim
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_command_startup_input_refused',
    }));
  });

  test('accepts a bare Codex executable without startup input', async () => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';

    expect(proof.buildCodexComputerUseProofInvocation(
      'codex',
      state.claim
    )).toEqual(expect.objectContaining({
      ok: true,
      argv: [state.codexExecutablePath],
    }));
  });

  test('normalizes the audited short safe flags and their exact arity', async () => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';

    expect(proof.buildCodexComputerUseProofInvocation(
      'codex -m gpt-5.6-sol -s read-only -a on-request '
        + '--search --no-alt-screen --dangerously-bypass-approvals-and-sandbox',
      state.claim
    )).toEqual(expect.objectContaining({
      ok: true,
      argv: [
        state.codexExecutablePath,
        '--model',
        'gpt-5.6-sol',
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'on-request',
        '--search',
        '--no-alt-screen',
        '--dangerously-bypass-approvals-and-sandbox',
      ],
    }));
  });

  test.each([
    ['remote endpoint', 'codex --remote ws://127.0.0.1:4500'],
    ['initial image', 'codex --image proof.png'],
    ['provider switch', 'codex --oss'],
    ['additional writable root', 'codex --add-dir D:\\other-project'],
    ['unknown option', 'codex --forge-proof'],
  ])('refuses the non-allowlisted %s option', async (_label, command) => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';

    expect(proof.buildCodexComputerUseProofInvocation(
      command,
      state.claim
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_command_option_refused',
    }));
  });

  test.each([
    ['model expression', "codex --model 'gpt-5.6-sol;forge-proof'"],
    ['sandbox mode', 'codex --sandbox unrestricted'],
    ['approval policy', 'codex --ask-for-approval always'],
    ['missing model', 'codex --model'],
  ])('refuses an unsafe or missing %s value', async (_label, command) => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';

    expect(proof.buildCodexComputerUseProofInvocation(
      command,
      state.claim
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_command_option_value_refused',
    }));
  });

  test('refuses resume and a pre-existing generic hook bypass', async () => {
    const state = await armedClaim();
    state.claim.proof.state = 'armed';
    expect(proof.buildCodexComputerUseProofInvocation(
      'codex resume abc',
      state.claim
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_bypass_requires_fresh_session',
    }));
    expect(proof.buildCodexComputerUseProofInvocation(
      'codex --dangerously-bypass-hook-trust',
      state.claim
    )).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_bypass_already_present',
    }));
  });
});
