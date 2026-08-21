'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const sharp = require('sharp');
const {
  resolveTeamRoomNetworkOptions,
  TeamRoomPairingRegistry,
  TeamRoomRuntime,
} = require('../modules/main/team-room-runtime');
const { TeamRoomStore } = require('../modules/main/team-room-store');
const { main: runRoomCli } = require('../scripts/hm-room');

function request(origin, route, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const req = http.request(new URL(route, origin), {
      method: options.method || 'GET',
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        headers: response.headers,
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function rawRequest(origin, route, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined || options.body === null
      ? null
      : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    const req = http.request(new URL(route, origin), {
      method: options.method || 'GET',
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(body ? { 'Content-Length': body.length } : {}),
        ...(options.headers || {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        let payload = null;
        try { payload = JSON.parse(responseBody.toString('utf8')); } catch {}
        resolve({ statusCode: response.statusCode, body: responseBody, payload, headers: response.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipartPayload(bytes, options = {}) {
  const boundary = options.boundary || `room-${crypto.randomBytes(8).toString('hex')}`;
  const filename = options.filename || 'photo.png';
  const mimeType = options.mimeType || 'image/png';
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
          + `Content-Type: ${mimeType}\r\n\r\n`,
        'utf8'
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]),
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('wait_for_timeout');
}

function runtimeOptions(tempRoot, deliverToPane) {
  const resolveCliBindings = ({ appGeneration }) => bindingResult(appGeneration);
  return {
    appGeneration: 'app-session-512',
    projectRoot: tempRoot,
    runtimeRoot: path.join(tempRoot, '.squidrun', 'runtime', 'team-room'),
    publicRoot: path.resolve(__dirname, '..'),
    storeOptions: {
      dbPath: path.join(tempRoot, '.squidrun', 'room', 'room.db'),
      attachmentRoot: path.join(tempRoot, '.squidrun', 'room', 'attachments'),
    },
    deliverToPane,
    resolveCliBindings,
  };
}

function bindingResult(appGeneration, launchOverrides = {}) {
  return {
    ok: true,
    profileName: 'main',
    bindings: {
      architect: {
        role: 'architect', paneId: '1', profileName: 'main',
        paneLaunchId: launchOverrides.architect || `pl_${'1'.repeat(32)}`, appGeneration,
      },
      builder: {
        role: 'builder', paneId: '2', profileName: 'main',
        paneLaunchId: launchOverrides.builder || `pl_${'2'.repeat(32)}`, appGeneration,
      },
      oracle: {
        role: 'oracle', paneId: '3', profileName: 'main',
        paneLaunchId: launchOverrides.oracle || `pl_${'3'.repeat(32)}`, appGeneration,
      },
    },
  };
}

function cliEnv(role, paneId, paneLaunchId, appGeneration = 'app-session-512') {
  return {
    SQUIDRUN_ROLE: role,
    SQUIDRUN_PANE_ID: paneId,
    SQUIDRUN_PROFILE: 'main',
    SQUIDRUN_PANE_LAUNCH_ID: paneLaunchId,
    SQUIDRUN_APP_GENERATION: appGeneration,
  };
}

function atomicTemporaryFiles(filePath) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) return [];
  const prefix = `${path.basename(filePath)}.${process.pid}.`;
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'));
}

describe('Team Room network configuration', () => {
  const lanEnv = {
    SQUIDRUN_TEAM_ROOM_LAN: '1',
    SQUIDRUN_TEAM_ROOM_HOST: '192.168.1.200',
    SQUIDRUN_TEAM_ROOM_PORT: '9910',
    SQUIDRUN_TEAM_ROOM_ORIGINS: 'http://192.168.1.200:9910',
  };

  test('accepts an exact LAN bind host present on a local interface', () => {
    expect(resolveTeamRoomNetworkOptions(lanEnv, {
      localAddresses: ['127.0.0.1', '192.168.1.200'],
    })).toEqual({
      ok: true,
      host: '192.168.1.200',
      port: 9910,
      lanEnabled: true,
      allowedOrigins: ['http://192.168.1.200:9910'],
    });
  });

  test('rejects a stale LAN bind host with the current interface addresses', () => {
    expect(resolveTeamRoomNetworkOptions({
      ...lanEnv,
      SQUIDRUN_TEAM_ROOM_HOST: '192.168.0.200',
      SQUIDRUN_TEAM_ROOM_ORIGINS: 'http://192.168.0.200:9910',
    }, {
      localAddresses: ['127.0.0.1', '192.168.1.200'],
    })).toEqual({
      ok: false,
      reason: 'room_lan_bind_host_not_local',
      host: '192.168.0.200',
      localAddresses: ['127.0.0.1', '192.168.1.200'],
    });
  });
});

describe('Team Room HTTP/WebSocket runtime', () => {
  let tempRoot;
  let runtime;

  beforeAll(() => sharp.cache(false));
  afterAll(() => sharp.cache(false));
  beforeEach(() => { tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-runtime-')); });
  afterEach(async () => {
    if (runtime) await runtime.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    runtime = null;
  });

  test('refuses to mint CLI credentials without a valid app-generation binding', async () => {
    runtime = new TeamRoomRuntime({ ...runtimeOptions(tempRoot, async () => ({ ok: true })), appGeneration: 'caller-selected' });
    await expect(runtime.start()).resolves.toEqual({ ok: false, reason: 'team_room_app_generation_required' });
    expect(fs.existsSync(path.join(tempRoot, '.squidrun', 'runtime', 'team-room', 'credentials', 'builder.json'))).toBe(false);
  });

  test('refuses to mint CLI credentials when the server registry binding is unavailable', async () => {
    runtime = new TeamRoomRuntime({
      ...runtimeOptions(tempRoot, async () => ({ ok: true })),
      resolveCliBindings: () => ({ ok: false, reason: 'team_room_cli_launch_binding_unavailable' }),
    });
    await expect(runtime.start()).resolves.toEqual({ ok: false, reason: 'team_room_cli_launch_binding_unavailable' });
    expect(fs.existsSync(path.join(tempRoot, '.squidrun', 'runtime', 'team-room', 'credentials', 'builder.json'))).toBe(false);
  });

  test('fails closed on locked crash residue, then recovers only the exact upload temp on a later start', async () => {
    const attachmentRoot = path.join(tempRoot, '.squidrun', 'room', 'attachments');
    const stagingRoot = path.join(attachmentRoot, '.staging');
    fs.mkdirSync(stagingRoot, { recursive: true });
    const residue = path.join(stagingRoot, '33333333-3333-4333-8333-333333333333.upload');
    const unrelated = path.join(stagingRoot, 'keep-me.upload');
    fs.writeFileSync(residue, 'crash residue');
    fs.writeFileSync(unrelated, 'unrelated sentinel');
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const realUnlink = fs.unlinkSync;
    const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation((filePath) => {
      if (path.resolve(String(filePath)) === path.resolve(residue)) {
        const error = new Error('injected_recovery_lock');
        error.code = 'EBUSY';
        throw error;
      }
      return realUnlink(filePath);
    });

    await expect(runtime.start()).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: expect.stringContaining('room_upload_temp_cleanup_pending'),
    }));
    expect(runtime.server).toBeNull();
    expect(runtime.store.db).toBeNull();
    expect(fs.existsSync(residue)).toBe(true);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated sentinel');
    unlinkSpy.mockRestore();

    await expect(runtime.start()).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(fs.existsSync(residue)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated sentinel');
    expect(runtime.uploadManager.ownedTemporaryPaths.size).toBe(0);
  });

  test('refuses startup when attachment staging is a junction and preserves foreign files', async () => {
    const attachmentRoot = path.join(tempRoot, '.squidrun', 'room', 'attachments');
    const stagingRoot = path.join(attachmentRoot, '.staging');
    const foreignRoot = path.join(tempRoot, 'foreign-staging');
    fs.mkdirSync(attachmentRoot, { recursive: true });
    fs.mkdirSync(foreignRoot, { recursive: true });
    const foreignUpload = path.join(foreignRoot, '55555555-5555-4555-8555-555555555555.upload');
    const foreignSentinel = path.join(foreignRoot, 'sentinel.txt');
    fs.writeFileSync(foreignUpload, 'foreign residue');
    fs.writeFileSync(foreignSentinel, 'foreign sentinel');
    fs.symlinkSync(foreignRoot, stagingRoot, process.platform === 'win32' ? 'junction' : 'dir');
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));

    await expect(runtime.start()).resolves.toEqual({
      ok: false,
      reason: 'room_upload_staging_root_reparse_forbidden',
    });
    expect(runtime.server).toBeNull();
    expect(runtime.store.db).toBeNull();
    expect(fs.readFileSync(foreignUpload, 'utf8')).toBe('foreign residue');
    expect(fs.readFileSync(foreignSentinel, 'utf8')).toBe('foreign sentinel');
    fs.rmdirSync(stagingRoot);
  });

  test('refuses startup when an attachment-root ancestor is a junction and preserves foreign files', async () => {
    const aliasRoot = path.join(tempRoot, 'alias');
    const foreignRoot = path.join(tempRoot, 'foreign-ancestor');
    const foreignAttachmentRoot = path.join(foreignRoot, 'attachments');
    const foreignStagingRoot = path.join(foreignAttachmentRoot, '.staging');
    fs.mkdirSync(foreignStagingRoot, { recursive: true });
    const foreignUpload = path.join(foreignStagingRoot, '88888888-8888-4888-8888-888888888888.upload');
    const foreignSentinel = path.join(foreignStagingRoot, 'foreign-ancestor-sentinel.txt');
    fs.writeFileSync(foreignUpload, 'foreign ancestor residue');
    fs.writeFileSync(foreignSentinel, 'foreign ancestor sentinel');
    fs.symlinkSync(foreignRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const options = runtimeOptions(tempRoot, async () => ({ ok: true }));
    options.storeOptions = {
      ...options.storeOptions,
      attachmentRoot: path.join(aliasRoot, 'attachments'),
    };
    runtime = new TeamRoomRuntime(options);

    await expect(runtime.start()).resolves.toEqual({
      ok: false,
      reason: 'room_upload_storage_path_reparse_forbidden',
    });
    expect(runtime.server).toBeNull();
    expect(runtime.store.db).toBeNull();
    expect(fs.lstatSync(aliasRoot).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(aliasRoot, 'attachments')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(foreignUpload, 'utf8')).toBe('foreign ancestor residue');
    expect(fs.readFileSync(foreignSentinel, 'utf8')).toBe('foreign ancestor sentinel');
    fs.rmdirSync(aliasRoot);
  });

  test('separates constant room_web and room_cli endpoints and authenticates WebSocket cookies', async () => {
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const started = await runtime.start();
    expect(started.ok).toBe(true);
    const cli = JSON.parse(fs.readFileSync(path.join(tempRoot, '.squidrun', 'runtime', 'team-room', 'credentials', 'builder.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(tempRoot, '.squidrun', 'runtime', 'team-room', 'runtime.json'), 'utf8'));
    expect(manifest.cliBindings.builder).toEqual(expect.objectContaining({
      role: 'builder', paneId: '2', profileName: 'main',
      paneLaunchId: `pl_${'2'.repeat(32)}`, appGeneration: 'app-session-512',
    }));
    const electron = runtime.issueElectronCredential();
    expect(electron.ok).toBe(true);
    const cookie = `squidrun_team_room=${electron.token}`;

    await expect(request(started.origin, '/api/snapshot', { token: cli.token }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 403, payload: expect.objectContaining({ reason: 'room_source_mismatch' }) }));
    await expect(request(started.origin, '/api/cli/snapshot', { token: electron.token }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 403, payload: expect.objectContaining({ reason: 'room_source_mismatch' }) }));
    await expect(request(started.origin, '/api/snapshot', { cookie }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 200, payload: expect.objectContaining({ ok: true }) }));

    const wsMessage = await new Promise((resolve, reject) => {
      const socket = new WebSocket(started.origin.replace(/^http/u, 'ws') + '/ws', {
        headers: { Cookie: cookie, Origin: started.origin },
      });
      socket.once('message', (data) => { resolve(JSON.parse(String(data))); socket.close(); });
      socket.once('error', reject);
    });
    expect(wsMessage).toEqual(expect.objectContaining({ type: 'snapshot' }));
  });

  test('lets the bound CLI initiate a peer-only root post with no Telegram relay', async () => {
    const paneDeliveries = [];
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async (delivery) => {
      paneDeliveries.push(delivery);
      return { ok: true };
    }));
    const started = await runtime.start();
    expect(started.ok).toBe(true);

    let stdout = '';
    let stderr = '';
    expect(await runRoomCli([
      'post', '--reason', 'new_evidence_or_action', 'The immutable room gate is green.',
    ], {
      projectRoot: tempRoot,
      env: cliEnv('builder', '2', `pl_${'2'.repeat(32)}`),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    })).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toMatch(/^Posted to Team Room/u);

    const message = runtime.snapshot().messages.find((candidate) => (
      candidate.body === 'The immutable room gate is green.'
    ));
    expect(message).toEqual(expect.objectContaining({
      authorId: 'builder',
      rootMessageId: expect.stringMatching(/^trm_/u),
      replyToMessageId: null,
      causalActivationId: null,
      author: expect.objectContaining({ displayName: 'Rook', role: 'builder' }),
    }));
    expect(message.rootMessageId).toBe(message.messageId);
    expect(runtime.store.listActivations(message.messageId).map((item) => item.targetMemberId))
      .toEqual(['architect', 'oracle']);
    await waitFor(() => paneDeliveries.length === 2);
    expect(paneDeliveries.map((item) => item.member.memberId).sort()).toEqual(['architect', 'oracle']);
    expect(paneDeliveries.some((item) => item.member.memberId === 'builder')).toBe(false);

    const invalidCases = [
      ['post', 'Missing reason.'],
      ['post', '--reason', 'direct_answer', '--activation', 'tra_forbidden', 'No causal root.'],
      ['post', '--reason', 'new_evidence_or_action', '--reentry', 'No root reentry.'],
    ];
    for (const args of invalidCases) {
      let invalidStderr = '';
      expect(await runRoomCli(args, {
        projectRoot: tempRoot,
        env: cliEnv('builder', '2', `pl_${'2'.repeat(32)}`),
        stdout: { write: () => {} },
        stderr: { write: (value) => { invalidStderr += value; } },
      })).toBe(1);
      expect(invalidStderr).toMatch(/^room_cli_/u);
    }
    expect(runtime.snapshot().messages.filter((candidate) => candidate.authorId === 'builder')).toHaveLength(1);

    const builderCredential = JSON.parse(fs.readFileSync(
      path.join(tempRoot, '.squidrun', 'runtime', 'team-room', 'credentials', 'builder.json'),
      'utf8'
    ));
    const spoofedName = await request(started.origin, '/api/cli/messages', {
      method: 'POST',
      token: builderCredential.token,
      body: {
        agentInitiatedRoot: true,
        body: 'Client-selected display name must not persist.',
        clientNonce: 'agent-root-display-spoof',
        displayName: 'Mira',
        participationReason: 'new_evidence_or_action',
      },
    });
    expect(spoofedName).toEqual(expect.objectContaining({
      statusCode: 403,
      payload: expect.objectContaining({
        ok: false,
        reason: 'client_identity_field_forbidden',
        details: { field: 'displayName' },
      }),
    }));
  });

  test('renders an offline fragment QR over the existing one-use pairing claim', async () => {
    runtime = new TeamRoomRuntime({
      ...runtimeOptions(tempRoot, async () => ({ ok: true })),
      host: '127.0.0.1',
      port: 0,
      lanEnabled: true,
      allowedOrigins: ['http://127.0.0.1:41321'],
    });
    const started = await runtime.start();
    expect(started.ok).toBe(true);
    const electron = runtime.issueElectronCredential();
    expect(electron.ok).toBe(true);
    const pairingStart = await request(started.origin, '/api/pairing/start', {
      method: 'POST',
      cookie: `squidrun_team_room=${electron.token}`,
      origin: started.origin,
      body: {},
    });

    expect(pairingStart).toEqual(expect.objectContaining({
      statusCode: 201,
      payload: expect.objectContaining({
        ok: true,
        pairing: expect.objectContaining({
          code: expect.stringMatching(/^\d{6}$/u),
          claimUrl: `${started.origin}/`,
          qrDataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
        }),
      }),
    }));
    const pairingUrl = new URL(pairingStart.payload.pairing.pairingUrl);
    expect(pairingUrl.origin).toBe(started.origin);
    expect(pairingUrl.search).toBe('');
    expect(pairingUrl.hash).toBe(`#pair=${pairingStart.payload.pairing.code}`);

    const firstClaim = await request(started.origin, '/api/pairing/claim', {
      method: 'POST',
      origin: started.origin,
      body: { code: pairingStart.payload.pairing.code },
    });
    expect(firstClaim.statusCode).toBe(200);
    expect(firstClaim.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(firstClaim.headers['set-cookie']?.[0]).toContain('SameSite=Strict');

    const replay = await request(started.origin, '/api/pairing/claim', {
      method: 'POST',
      origin: started.origin,
      body: { code: pairingStart.payload.pairing.code },
    });
    expect(replay.statusCode).not.toBe(200);
  });

  test('serves a complete installable shell with exact raster icons and no API cache surface', async () => {
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const started = await runtime.start();
    expect(started.ok).toBe(true);

    const root = await rawRequest(started.origin, '/');
    expect(root.statusCode).toBe(200);
    expect(root.body.toString('utf8')).toContain('<link rel="manifest" href="/team-room.webmanifest">');
    expect(root.body.toString('utf8')).toContain('rel="apple-touch-icon"');

    const manifestResponse = await rawRequest(started.origin, '/team-room.webmanifest');
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    const manifest = JSON.parse(manifestResponse.body.toString('utf8'));
    expect(manifest).toEqual(expect.objectContaining({
      id: '/', start_url: '/', scope: '/', display: 'standalone', prefer_related_applications: false,
    }));
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/team-room-icon-192.png', sizes: '192x192', type: 'image/png' }),
      expect.objectContaining({ src: '/team-room-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }),
    ]));

    for (const size of [192, 512, 180]) {
      const icon = await rawRequest(started.origin, `/team-room-icon-${size}.png`);
      expect(icon.statusCode).toBe(200);
      expect(icon.headers['content-type']).toBe('image/png');
      await expect(sharp(icon.body).metadata()).resolves.toEqual(expect.objectContaining({ width: size, height: size }));
    }

    const worker = await rawRequest(started.origin, '/team-room-sw.js');
    expect(worker.statusCode).toBe(200);
    expect(worker.body.toString('utf8')).toContain("'/team-room.webmanifest'");
    expect(worker.body.toString('utf8')).not.toContain("'/api/");
  });

  test('keeps paired web authority and message history across a fixed-port server restart', async () => {
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const firstStart = await runtime.start();
    expect(firstStart.ok).toBe(true);
    const fixedPort = runtime.server.address().port;
    const paired = runtime._issueCredential('james', 'room_web', 'paired_device', { ttlMs: 30 * 24 * 60 * 60 * 1000 });
    expect(paired.ok).toBe(true);
    const cookie = `squidrun_team_room=${paired.token}`;
    const firstPost = await request(firstStart.origin, '/api/messages', {
      method: 'POST', cookie, origin: firstStart.origin,
      body: { body: 'Persist through the server restart.', clientNonce: 'restart-before-1' },
    });
    expect(firstPost.statusCode).toBe(201);

    const firstSocket = new WebSocket(firstStart.origin.replace(/^http/u, 'ws') + '/ws', {
      headers: { Cookie: cookie, Origin: firstStart.origin },
    });
    await new Promise((resolve, reject) => {
      firstSocket.once('message', resolve);
      firstSocket.once('error', reject);
    });
    const closed = new Promise((resolve) => firstSocket.once('close', resolve));
    await runtime.stop();
    await closed;

    runtime = new TeamRoomRuntime({
      ...runtimeOptions(tempRoot, async () => ({ ok: true })),
      host: '127.0.0.1',
      port: fixedPort,
    });
    const secondStart = await runtime.start();
    expect(secondStart).toEqual(expect.objectContaining({ ok: true, origin: firstStart.origin }));
    const restored = await request(secondStart.origin, '/api/snapshot', { cookie });
    expect(restored).toEqual(expect.objectContaining({
      statusCode: 200,
      payload: expect.objectContaining({
        snapshot: expect.objectContaining({
          messages: expect.arrayContaining([expect.objectContaining({ clientNonce: 'restart-before-1' })]),
        }),
      }),
    }));
  });

  test('catches up from the authoritative snapshot after a WebSocket drop', async () => {
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const started = await runtime.start();
    const paired = runtime._issueCredential('james', 'room_web', 'paired_device', { ttlMs: 30 * 24 * 60 * 60 * 1000 });
    const cookie = `squidrun_team_room=${paired.token}`;
    const firstSocket = new WebSocket(started.origin.replace(/^http/u, 'ws') + '/ws', {
      headers: { Cookie: cookie, Origin: started.origin },
    });
    await new Promise((resolve, reject) => {
      firstSocket.once('message', resolve);
      firstSocket.once('error', reject);
    });
    const dropped = new Promise((resolve) => firstSocket.once('close', resolve));
    firstSocket.terminate();
    await dropped;

    const missed = await request(started.origin, '/api/messages', {
      method: 'POST', cookie, origin: started.origin,
      body: { body: 'Catch this after the socket resumes.', clientNonce: 'ws-catch-up-1' },
    });
    expect(missed.statusCode).toBe(201);
    const resumedSnapshot = await new Promise((resolve, reject) => {
      const socket = new WebSocket(started.origin.replace(/^http/u, 'ws') + '/ws', {
        headers: { Cookie: cookie, Origin: started.origin },
      });
      socket.once('message', (data) => { resolve(JSON.parse(String(data))); socket.close(); });
      socket.once('error', reject);
    });
    expect(resumedSnapshot).toEqual(expect.objectContaining({
      type: 'snapshot',
      snapshot: expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ clientNonce: 'ws-catch-up-1' })]),
      }),
    }));
  });

  test('persists zero messages for missing, partial, mismatched, stale-generation, and stale-launch CLI bindings', async () => {
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    expect((await runtime.start()).ok).toBe(true);
    const complete = {
      SQUIDRUN_ROLE: 'builder',
      SQUIDRUN_PANE_ID: '2',
      SQUIDRUN_PROFILE: 'main',
      SQUIDRUN_PANE_LAUNCH_ID: `pl_${'2'.repeat(32)}`,
      SQUIDRUN_APP_GENERATION: 'app-session-512',
    };
    const cases = [
      {},
      { SQUIDRUN_ROLE: 'builder' },
      { SQUIDRUN_PANE_ID: '2' },
      { ...complete, SQUIDRUN_PROFILE: undefined },
      { ...complete, SQUIDRUN_PANE_LAUNCH_ID: undefined },
      { ...complete, SQUIDRUN_ROLE: 'oracle' },
      { ...complete, SQUIDRUN_APP_GENERATION: 'app-session-511' },
      { ...complete, SQUIDRUN_PANE_LAUNCH_ID: `pl_${'9'.repeat(32)}` },
    ];
    for (const env of cases) {
      let stderr = '';
      const exitCode = await runRoomCli([
        'reply', '--activation', 'tra_untrusted', '--reason', 'direct_answer', 'must not persist',
      ], {
        projectRoot: tempRoot,
        env,
        stdout: { write: () => {} },
        stderr: { write: (value) => { stderr += value; } },
      });
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/^room_cli_/u);
    }
    expect(runtime.snapshot().messages).toHaveLength(0);
  });

  test('rotates one respawned pane binding without restarting, revokes old authority, and preserves unrelated roles', async () => {
    let builderLaunchId = `pl_${'2'.repeat(32)}`;
    let resolverCalls = 0;
    runtime = new TeamRoomRuntime({
      ...runtimeOptions(tempRoot, async () => ({ ok: true })),
      resolveCliBindings: ({ appGeneration }) => {
        resolverCalls += 1;
        return bindingResult(appGeneration, { builder: builderLaunchId });
      },
    });
    const started = await runtime.start();
    expect(started.ok).toBe(true);
    const credentialsRoot = path.join(tempRoot, '.squidrun', 'runtime', 'team-room', 'credentials');
    const runtimePath = path.join(tempRoot, '.squidrun', 'runtime', 'team-room', 'runtime.json');
    const before = Object.fromEntries(['architect', 'builder', 'oracle'].map((role) => [
      role,
      JSON.parse(fs.readFileSync(path.join(credentialsRoot, `${role}.json`), 'utf8')),
    ]));

    builderLaunchId = `pl_${'9'.repeat(32)}`;
    await expect(runtime.start()).resolves.toEqual(expect.objectContaining({
      ok: true,
      alreadyRunning: true,
      cliBindingsRotated: ['builder'],
    }));
    expect(resolverCalls).toBe(2);
    const after = Object.fromEntries(['architect', 'builder', 'oracle'].map((role) => [
      role,
      JSON.parse(fs.readFileSync(path.join(credentialsRoot, `${role}.json`), 'utf8')),
    ]));
    const manifest = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    expect(after.builder).toEqual(expect.objectContaining({
      paneLaunchId: builderLaunchId,
      bindingRevision: manifest.cliBindings.builder.bindingRevision,
    }));
    expect(after.builder.token).not.toBe(before.builder.token);
    expect(after.builder.bindingRevision).not.toBe(before.builder.bindingRevision);
    expect(after.architect).toEqual(before.architect);
    expect(after.oracle).toEqual(before.oracle);
    expect(await request(started.origin, '/api/cli/snapshot', { token: before.builder.token }))
      .toEqual(expect.objectContaining({ statusCode: 401, payload: expect.objectContaining({ reason: 'room_credential_revoked' }) }));

    const oldMessages = runtime.snapshot().messages.length;
    let oldStderr = '';
    expect(await runRoomCli([
      'reply', '--activation', 'tra_stale_launch', '--reason', 'direct_answer', 'stale must not persist',
    ], {
      projectRoot: tempRoot,
      env: cliEnv('builder', '2', `pl_${'2'.repeat(32)}`),
      stdout: { write: () => {} },
      stderr: { write: (value) => { oldStderr += value; } },
    })).toBe(1);
    expect(oldStderr).toMatch(/^room_cli_runtime_binding_mismatch/u);
    expect(runtime.snapshot().messages).toHaveLength(oldMessages);

    let newStatus = '';
    expect(await runRoomCli(['status', '--json'], {
      projectRoot: tempRoot,
      env: cliEnv('builder', '2', builderLaunchId),
      stdout: { write: (value) => { newStatus += value; } },
      stderr: { write: () => {} },
    })).toBe(0);
    expect(JSON.parse(newStatus)).toEqual(expect.objectContaining({ ok: true, role: 'builder' }));
    expect(await runRoomCli(['status', '--json'], {
      projectRoot: tempRoot,
      env: cliEnv('architect', '1', `pl_${'1'.repeat(32)}`),
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    })).toBe(0);

    const electron = runtime.issueElectronCredential();
    const posted = await request(started.origin, '/api/messages', {
      method: 'POST',
      cookie: `squidrun_team_room=${electron.token}`,
      origin: started.origin,
      body: { body: 'Reply after the pane respawn.', clientNonce: 'rotation-root-1' },
    });
    expect(posted.statusCode).toBe(201);
    const activation = await waitFor(() => runtime.store.listActivations(posted.payload.message.messageId)
      .find((candidate) => candidate.targetMemberId === 'builder' && candidate.status === 'delivered'));
    let replyStdout = '';
    expect(await runRoomCli([
      'reply', '--activation', activation.activationId, '--reason', 'direct_answer', 'New launch is bound.',
    ], {
      projectRoot: tempRoot,
      env: cliEnv('builder', '2', builderLaunchId),
      stdout: { write: (value) => { replyStdout += value; } },
      stderr: { write: () => {} },
    })).toBe(0);
    expect(replyStdout).toMatch(/^Posted to Team Room/u);
    expect(runtime.snapshot().messages.filter((message) => message.body === 'New launch is bound.')).toHaveLength(1);
  });

  test('serializes a start from the server listening event before any binding refresh can touch half-mounted state', async () => {
    let builderLaunchId = `pl_${'2'.repeat(32)}`;
    let concurrentStart;
    runtime = new TeamRoomRuntime({
      ...runtimeOptions(tempRoot, async () => ({ ok: true })),
      resolveCliBindings: ({ appGeneration }) => bindingResult(appGeneration, { builder: builderLaunchId }),
    });
    const realCreateServer = http.createServer;
    const createServerSpy = jest.spyOn(http, 'createServer').mockImplementation((handler) => {
      const server = realCreateServer(handler);
      server.once('listening', () => {
        builderLaunchId = `pl_${'9'.repeat(32)}`;
        concurrentStart = runtime.start();
      });
      return server;
    });

    const firstStart = runtime.start();
    const firstResult = await firstStart;
    const secondResult = await concurrentStart;
    createServerSpy.mockRestore();
    expect(firstResult).toEqual(expect.objectContaining({ ok: true }));
    expect(secondResult).toEqual(firstResult);

    const runtimeRoot = path.join(tempRoot, '.squidrun', 'runtime', 'team-room');
    const manifestPath = path.join(runtimeRoot, 'runtime.json');
    const credentialPath = path.join(runtimeRoot, 'credentials', 'builder.json');
    const mountedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const mountedCredential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    expect(mountedManifest.cliBindings.builder.paneLaunchId).toBe(`pl_${'2'.repeat(32)}`);
    expect(mountedCredential.paneLaunchId).toBe(`pl_${'2'.repeat(32)}`);
    expect(mountedCredential.bindingRevision).toBe(mountedManifest.cliBindings.builder.bindingRevision);
    await expect(request(firstResult.origin, '/api/cli/snapshot', { token: mountedCredential.token }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 200 }));

    await expect(runtime.start()).resolves.toEqual(expect.objectContaining({
      ok: true,
      alreadyRunning: true,
      cliBindingsRotated: ['builder'],
    }));
    const convergedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const convergedCredential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    expect(convergedManifest.cliBindings.builder.paneLaunchId).toBe(builderLaunchId);
    expect(convergedCredential.paneLaunchId).toBe(builderLaunchId);
    expect(convergedCredential.bindingRevision).toBe(convergedManifest.cliBindings.builder.bindingRevision);
    await expect(request(firstResult.origin, '/api/cli/snapshot', { token: mountedCredential.token }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 401 }));
    await expect(request(firstResult.origin, '/api/cli/snapshot', { token: convergedCredential.token }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 200 }));
  });

  test('rolls back an initial manifest-publication failure and retries without a ghost listener or credential', async () => {
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const runtimeRoot = path.join(tempRoot, '.squidrun', 'runtime', 'team-room');
    const manifestPath = path.join(runtimeRoot, 'runtime.json');
    const credentialPath = path.join(runtimeRoot, 'credentials', 'builder.json');
    const realRename = fs.renameSync;
    let failedToken;
    let failedPort;
    let injected = false;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (!injected && path.resolve(destination) === path.resolve(manifestPath)) {
        injected = true;
        failedToken = JSON.parse(fs.readFileSync(credentialPath, 'utf8')).token;
        failedPort = Number(runtime.server.address().port);
        throw new Error('injected_initial_manifest_publish_failure');
      }
      return realRename(source, destination);
    });

    await expect(runtime.start()).resolves.toEqual({
      ok: false,
      reason: 'team_room_start_failed:injected_initial_manifest_publish_failure',
    });
    renameSpy.mockRestore();
    expect(failedToken).toMatch(/^[A-Za-z0-9_-]{40,256}$/u);
    expect(runtime.server).toBeNull();
    expect(runtime.webSocketServer).toBeNull();
    expect(runtime.runtimePublished).toBe(false);
    expect(runtime.claimRecoveryTimer).toBeNull();
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(credentialPath)).toBe(false);
    expect(atomicTemporaryFiles(manifestPath)).toEqual([]);
    expect(atomicTemporaryFiles(credentialPath)).toEqual([]);
    await expect(new Promise((resolve) => {
      const probe = http.get(`http://127.0.0.1:${failedPort}/api/cli/snapshot`, () => resolve('connected'));
      probe.once('error', () => resolve('closed'));
    })).resolves.toBe('closed');

    const retried = await runtime.start();
    expect(retried).toEqual(expect.objectContaining({ ok: true }));
    const retryCredential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    expect(retryCredential.token).not.toBe(failedToken);
    await expect(request(retried.origin, '/api/cli/snapshot', { token: failedToken }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 401 }));
    await expect(request(retried.origin, '/api/cli/snapshot', { token: retryCredential.token }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 200 }));
    const retryTimer = runtime.claimRecoveryTimer;
    expect(retryTimer).not.toBeNull();
    expect(retryTimer?.hasRef?.()).toBe(false);
    await expect(runtime.start()).resolves.toEqual(expect.objectContaining({ ok: true, alreadyRunning: true }));
    expect(runtime.claimRecoveryTimer).toBe(retryTimer);

    const retryPort = Number(new URL(retried.origin).port);
    await expect(runtime.stop()).resolves.toEqual({ ok: true });
    expect(runtime.server).toBeNull();
    expect(runtime.webSocketServer).toBeNull();
    expect(runtime.claimRecoveryTimer).toBeNull();
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(credentialPath)).toBe(false);
    expect(atomicTemporaryFiles(manifestPath)).toEqual([]);
    expect(atomicTemporaryFiles(credentialPath)).toEqual([]);
    await expect(new Promise((resolve) => {
      const probe = http.get(`http://127.0.0.1:${retryPort}/api/cli/snapshot`, () => resolve('connected'));
      probe.once('error', () => resolve('closed'));
    })).resolves.toBe('closed');
  });

  test('removes the exact bearer-bearing staging file after a credential rename fault and clean retry', async () => {
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const runtimeRoot = path.join(tempRoot, '.squidrun', 'runtime', 'team-room');
    const manifestPath = path.join(runtimeRoot, 'runtime.json');
    const credentialPath = path.join(runtimeRoot, 'credentials', 'builder.json');
    const realRename = fs.renameSync;
    let failedToken;
    let injected = false;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (!injected && path.resolve(destination) === path.resolve(credentialPath)) {
        injected = true;
        failedToken = JSON.parse(fs.readFileSync(source, 'utf8')).token;
        throw new Error('injected_builder_credential_publish_failure');
      }
      return realRename(source, destination);
    });

    await expect(runtime.start()).resolves.toEqual({
      ok: false,
      reason: 'team_room_start_failed:injected_builder_credential_publish_failure',
    });
    renameSpy.mockRestore();
    expect(failedToken).toMatch(/^[A-Za-z0-9_-]{40,256}$/u);
    expect(runtime.server).toBeNull();
    expect(runtime.claimRecoveryTimer).toBeNull();
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(credentialPath)).toBe(false);
    expect(atomicTemporaryFiles(manifestPath)).toEqual([]);
    expect(atomicTemporaryFiles(credentialPath)).toEqual([]);

    const retried = await runtime.start();
    expect(retried).toEqual(expect.objectContaining({ ok: true }));
    const retryCredential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    await expect(request(retried.origin, '/api/cli/snapshot', { token: failedToken }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 401 }));
    await expect(request(retried.origin, '/api/cli/snapshot', { token: retryCredential.token }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 200 }));
    await expect(runtime.stop()).resolves.toEqual({ ok: true });
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(credentialPath)).toBe(false);
    expect(atomicTemporaryFiles(manifestPath)).toEqual([]);
    expect(atomicTemporaryFiles(credentialPath)).toEqual([]);
  });

  test('retains the exact staging path through a transient unlink fault and rollback retries cleanup without masking rename failure', async () => {
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const runtimeRoot = path.join(tempRoot, '.squidrun', 'runtime', 'team-room');
    const manifestPath = path.join(runtimeRoot, 'runtime.json');
    const credentialPath = path.join(runtimeRoot, 'credentials', 'builder.json');
    const realRename = fs.renameSync;
    const realUnlink = fs.unlinkSync;
    let failedToken;
    let ownedTemporaryPath;
    let renameInjected = false;
    let unlinkInjected = false;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (!renameInjected && path.resolve(destination) === path.resolve(credentialPath)) {
        renameInjected = true;
        ownedTemporaryPath = path.resolve(source);
        failedToken = JSON.parse(fs.readFileSync(source, 'utf8')).token;
        throw new Error('injected_builder_credential_rename_failure');
      }
      return realRename(source, destination);
    });
    const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (!unlinkInjected && ownedTemporaryPath && path.resolve(target) === ownedTemporaryPath) {
        unlinkInjected = true;
        const error = new Error('injected_exact_temp_unlink_busy');
        error.code = 'EBUSY';
        throw error;
      }
      return realUnlink(target);
    });

    await expect(runtime.start()).resolves.toEqual({
      ok: false,
      reason: 'team_room_start_failed:injected_builder_credential_rename_failure',
      cleanupDetail: 'team_room_atomic_temp_cleanup_retried:injected_exact_temp_unlink_busy',
    });
    renameSpy.mockRestore();
    unlinkSpy.mockRestore();
    expect(renameInjected).toBe(true);
    expect(unlinkInjected).toBe(true);
    expect(failedToken).toMatch(/^[A-Za-z0-9_-]{40,256}$/u);
    expect(runtime.ownedAtomicTemporaryPaths.size).toBe(0);
    expect(fs.existsSync(ownedTemporaryPath)).toBe(false);
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(credentialPath)).toBe(false);
    expect(atomicTemporaryFiles(manifestPath)).toEqual([]);
    expect(atomicTemporaryFiles(credentialPath)).toEqual([]);

    const retried = await runtime.start();
    expect(retried).toEqual(expect.objectContaining({ ok: true }));
    const retryCredential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    await expect(request(retried.origin, '/api/cli/snapshot', { token: failedToken }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 401 }));
    await expect(request(retried.origin, '/api/cli/snapshot', { token: retryCredential.token }))
      .resolves.toEqual(expect.objectContaining({ statusCode: 200 }));
    await expect(runtime.stop()).resolves.toEqual({ ok: true });
    expect(runtime.ownedAtomicTemporaryPaths.size).toBe(0);
    expect(fs.existsSync(ownedTemporaryPath)).toBe(false);
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(credentialPath)).toBe(false);
    expect(atomicTemporaryFiles(manifestPath)).toEqual([]);
    expect(atomicTemporaryFiles(credentialPath)).toEqual([]);
  });

  test('detects a pane-launch rotation on the mounted recovery interval without a room-window open', async () => {
    let builderLaunchId = `pl_${'2'.repeat(32)}`;
    runtime = new TeamRoomRuntime({
      ...runtimeOptions(tempRoot, async () => ({ ok: true })),
      claimRecoveryIntervalMs: 250,
      resolveCliBindings: ({ appGeneration }) => bindingResult(appGeneration, { builder: builderLaunchId }),
    });
    expect((await runtime.start()).ok).toBe(true);
    builderLaunchId = `pl_${'8'.repeat(32)}`;
    const manifestPath = path.join(tempRoot, '.squidrun', 'runtime', 'team-room', 'runtime.json');
    await waitFor(() => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return manifest.cliBindings.builder.paneLaunchId === builderLaunchId;
    });
    let statusOutput = '';
    expect(await runRoomCli(['status', '--json'], {
      projectRoot: tempRoot,
      env: cliEnv('builder', '2', builderLaunchId),
      stdout: { write: (value) => { statusOutput += value; } },
      stderr: { write: () => {} },
    })).toBe(0);
    expect(JSON.parse(statusOutput).ok).toBe(true);
  });

  test('fails closed across an interrupted credential-to-manifest rotation and recovers on retry', async () => {
    let builderLaunchId = `pl_${'2'.repeat(32)}`;
    runtime = new TeamRoomRuntime({
      ...runtimeOptions(tempRoot, async () => ({ ok: true })),
      resolveCliBindings: ({ appGeneration }) => bindingResult(appGeneration, { builder: builderLaunchId }),
    });
    const started = await runtime.start();
    expect(started.ok).toBe(true);
    const runtimeRoot = path.join(tempRoot, '.squidrun', 'runtime', 'team-room');
    const manifestPath = path.join(runtimeRoot, 'runtime.json');
    const oldCredential = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'credentials', 'builder.json'), 'utf8'));
    builderLaunchId = `pl_${'7'.repeat(32)}`;

    const realRename = fs.renameSync;
    let injected = false;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (!injected && path.resolve(destination) === path.resolve(manifestPath)) {
        injected = true;
        throw new Error('injected_manifest_publish_failure');
      }
      return realRename(source, destination);
    });
    await expect(runtime.start()).resolves.toEqual(expect.objectContaining({
      ok: false,
      alreadyRunning: true,
      reason: expect.stringContaining('team_room_cli_binding_rotation_failed'),
    }));
    renameSpy.mockRestore();
    const mixedCredential = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'credentials', 'builder.json'), 'utf8'));
    const oldManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(mixedCredential.paneLaunchId).toBe(builderLaunchId);
    expect(oldManifest.cliBindings.builder.paneLaunchId).toBe(`pl_${'2'.repeat(32)}`);
    expect(await request(started.origin, '/api/cli/snapshot', { token: oldCredential.token }))
      .toEqual(expect.objectContaining({ statusCode: 401, payload: expect.objectContaining({ reason: 'room_credential_revoked' }) }));
    expect(await request(started.origin, '/api/cli/snapshot', { token: mixedCredential.token }))
      .toEqual(expect.objectContaining({ statusCode: 401, payload: expect.objectContaining({ reason: 'room_credential_revoked' }) }));
    for (const launchId of [`pl_${'2'.repeat(32)}`, builderLaunchId]) {
      expect(await runRoomCli(['status', '--json'], {
        projectRoot: tempRoot,
        env: cliEnv('builder', '2', launchId),
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      })).toBe(1);
    }
    await expect(runtime.start()).resolves.toEqual(expect.objectContaining({
      ok: true,
      alreadyRunning: true,
      cliBindingsRotated: ['builder'],
    }));
    let recoveredStatus = '';
    expect(await runRoomCli(['status', '--json'], {
      projectRoot: tempRoot,
      env: cliEnv('builder', '2', builderLaunchId),
      stdout: { write: (value) => { recoveredStatus += value; } },
      stderr: { write: () => {} },
    })).toBe(0);
    expect(JSON.parse(recoveredStatus).ok).toBe(true);
  });

  test('requires cookie Origin on writes, posts optimistically-addressable messages, and dispatches all targets', async () => {
    const deliveries = [];
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async (delivery) => {
      deliveries.push(delivery);
      return { ok: true };
    }));
    const started = await runtime.start();
    const electron = runtime.issueElectronCredential();
    const cookie = `squidrun_team_room=${electron.token}`;
    const body = { body: 'The real room is awake.', clientNonce: 'web-runtime-1' };
    const blocked = await request(started.origin, '/api/messages', { method: 'POST', cookie, body });
    expect(blocked).toEqual(expect.objectContaining({ statusCode: 403, payload: expect.objectContaining({ reason: 'room_origin_forbidden' }) }));
    const posted = await request(started.origin, '/api/messages', {
      method: 'POST', cookie, origin: started.origin, body,
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.payload).toEqual(expect.objectContaining({
      ok: true,
      message: expect.objectContaining({ authorId: 'james', clientNonce: 'web-runtime-1' }),
    }));
    await waitFor(() => deliveries.length === 3);
    expect(deliveries.map((delivery) => delivery.member.memberId).sort())
      .toEqual(['architect', 'builder', 'oracle']);
    expect(deliveries.every((delivery) => delivery.prompt.includes('Activation: tra_'))).toBe(true);
    await waitFor(() => runtime.store.listActivations(posted.payload.message.messageId)
      .every((activation) => activation.status === 'delivered'));
  });

  test('streams verified media, serves only authenticated integrity-checked objects, and activates with the absolute path', async () => {
    const deliveries = [];
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async (delivery) => {
      deliveries.push(delivery);
      return { ok: true };
    }));
    const started = await runtime.start();
    const electron = runtime.issueElectronCredential();
    const cookie = `squidrun_team_room=${electron.token}`;
    const source = await sharp({
      create: { width: 96, height: 64, channels: 3, background: { r: 19, g: 137, b: 94 } },
    }).png().toBuffer();
    const digest = crypto.createHash('sha256').update(source).digest('hex');
    const multipart = multipartPayload(source, { filename: 'garden photo.png' });
    const uploadHeaders = { 'Content-Type': `multipart/form-data; boundary=${multipart.boundary}` };

    const noOrigin = await rawRequest(started.origin, '/api/attachments', {
      method: 'POST', cookie, body: multipart.body, headers: uploadHeaders,
    });
    expect(noOrigin).toEqual(expect.objectContaining({
      statusCode: 403,
      payload: expect.objectContaining({ reason: 'room_origin_forbidden' }),
    }));

    const uploaded = await rawRequest(started.origin, '/api/attachments', {
      method: 'POST', cookie, origin: started.origin, body: multipart.body, headers: uploadHeaders,
    });
    expect(uploaded).toEqual(expect.objectContaining({
      statusCode: 201,
      payload: expect.objectContaining({
        ok: true,
        attachment: expect.objectContaining({
          sha256: digest,
          originalName: 'garden photo.png',
          previewStatus: 'ready',
        }),
      }),
    }));
    const attachment = uploaded.payload.attachment;
    const objectPath = path.join(tempRoot, '.squidrun', 'room', 'attachments', digest);
    expect(fs.readFileSync(objectPath)).toEqual(source);
    expect(fs.readdirSync(path.dirname(objectPath)).filter((name) => name === digest)).toEqual([digest]);

    const unauthorized = await rawRequest(started.origin, attachment.originalUrl);
    expect(unauthorized).toEqual(expect.objectContaining({
      statusCode: 401,
      payload: expect.objectContaining({ reason: 'room_bearer_required' }),
    }));
    const original = await rawRequest(started.origin, attachment.originalUrl, { cookie });
    expect(original.statusCode).toBe(200);
    expect(original.body).toEqual(source);
    expect(original.headers['content-type']).toBe('image/png');
    const range = await rawRequest(started.origin, attachment.originalUrl, {
      cookie, headers: { Range: 'bytes=0-7' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.body).toEqual(source.subarray(0, 8));
    expect(range.headers['content-range']).toBe(`bytes 0-7/${source.length}`);
    const multiRange = await rawRequest(started.origin, attachment.originalUrl, {
      cookie, headers: { Range: 'bytes=0-1,4-7' },
    });
    expect(multiRange).toEqual(expect.objectContaining({
      statusCode: 416,
      payload: expect.objectContaining({ reason: 'room_media_multi_range_forbidden' }),
    }));
    const invalidRange = await rawRequest(started.origin, attachment.originalUrl, {
      cookie, headers: { Range: 'items=0-7' },
    });
    expect(invalidRange.statusCode).toBe(416);

    const preview = await rawRequest(started.origin, attachment.previewUrl, { cookie });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/webp');
    expect(preview.body.subarray(0, 4).toString('ascii')).toBe('RIFF');

    const posted = await request(started.origin, '/api/messages', {
      method: 'POST', cookie, origin: started.origin,
      body: {
        body: 'Open the attached room photo.',
        clientNonce: 'web-media-runtime-1',
        attachmentIds: [attachment.attachmentId],
      },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.payload.message.attachments).toEqual([
      expect.objectContaining({ attachmentId: attachment.attachmentId, sha256: digest }),
    ]);
    await waitFor(() => deliveries.length === 3);
    expect(deliveries.every((delivery) => (
      delivery.prompt.includes(`sha256=${digest}`) && delivery.prompt.includes(`path=${objectPath}`)
    ))).toBe(true);
    const snapshot = await request(started.origin, '/api/snapshot', { cookie });
    expect(snapshot.payload.snapshot.messages.at(-1).attachments).toEqual([
      expect.objectContaining({
        attachmentId: attachment.attachmentId,
        originalUrl: attachment.originalUrl,
        previewUrl: attachment.previewUrl,
      }),
    ]);

    const replayedHandle = await request(started.origin, '/api/messages', {
      method: 'POST', cookie, origin: started.origin,
      body: {
        body: 'This must not claim the same upload twice.',
        clientNonce: 'web-media-runtime-replay',
        attachmentIds: [attachment.attachmentId],
      },
    });
    expect(replayedHandle).toEqual(expect.objectContaining({
      statusCode: 409,
      payload: expect.objectContaining({ ok: false, reason: 'room_attachment_already_claimed' }),
    }));

    const secondMultipart = multipartPayload(source, { filename: 'garden photo again.png' });
    const reuploaded = await rawRequest(started.origin, '/api/attachments', {
      method: 'POST', cookie, origin: started.origin, body: secondMultipart.body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${secondMultipart.boundary}` },
    });
    expect(reuploaded).toEqual(expect.objectContaining({
      statusCode: 201,
      payload: expect.objectContaining({
        attachment: expect.objectContaining({ sha256: digest, originalName: 'garden photo again.png' }),
      }),
    }));
    const secondHandle = reuploaded.payload.attachment;
    expect(secondHandle.attachmentId).not.toBe(attachment.attachmentId);
    const repostedBytes = await request(started.origin, '/api/messages', {
      method: 'POST', cookie, origin: started.origin,
      body: {
        body: 'A deliberate re-upload of the same photo is valid.',
        clientNonce: 'web-media-runtime-reupload',
        attachmentIds: [secondHandle.attachmentId],
      },
    });
    expect(repostedBytes.statusCode).toBe(201);
    await waitFor(() => deliveries.length === 6);
    expect(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM room_attachments').get().count).toBe(1);
    expect(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM room_attachment_claims').get().count).toBe(2);
    expect(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM room_message_attachments').get().count).toBe(2);
    const firstContentId = runtime.store.db.prepare(`
      SELECT attachment_id FROM room_attachment_claims WHERE claim_id = ?
    `).get(attachment.attachmentId).attachment_id;
    expect(() => runtime.store.db.prepare(`
      INSERT INTO room_message_attachments (message_id, claim_id, attachment_id, ordinal)
      VALUES (?, ?, ?, 1)
    `).run(repostedBytes.payload.message.messageId, attachment.attachmentId, firstContentId))
      .toThrow(/UNIQUE constraint failed: room_message_attachments\.claim_id/u);

    const previewPath = path.join(tempRoot, '.squidrun', 'room', 'attachments', 'previews', `${digest}.webp`);
    fs.appendFileSync(previewPath, Buffer.from('tampered'));
    const tamperedPreview = await rawRequest(started.origin, attachment.previewUrl, { cookie });
    expect(tamperedPreview).toEqual(expect.objectContaining({
      statusCode: 404,
      payload: expect.objectContaining({ reason: 'room_attachment_preview_integrity_failed' }),
    }));
  });

  test('recovers and dispatches queued persisted work at boot without opening a room window', async () => {
    const storeOptions = runtimeOptions(tempRoot, null).storeOptions;
    const seedStore = new TeamRoomStore(storeOptions);
    expect(seedStore.init().ok).toBe(true);
    const seeded = seedStore.postMessage({
      identity: {
        memberId: 'james', roomId: 'main', profileName: 'main', memberKind: 'human',
        role: 'james', paneId: null, source: 'room_web',
      },
      payload: { body: 'Recover me at boot.', clientNonce: 'boot-recovery-1' },
    });
    expect(seeded.ok).toBe(true);
    seedStore.close();
    const deliveries = [];
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async (delivery) => {
      deliveries.push(delivery);
      return { ok: true };
    }));
    expect((await runtime.start()).ok).toBe(true);
    expect(runtime.claimRecoveryTimer?.hasRef?.()).toBe(false);
    await waitFor(() => deliveries.length === 3);
    await waitFor(() => runtime.store.listActivations(seeded.message.messageId)
      .every((activation) => activation.status === 'delivered'));
  });

  test('recovers a claim that is young at restart after it later crosses the stale boundary', async () => {
    let nowMs = 1_000_000;
    const baseOptions = runtimeOptions(tempRoot, null);
    const storeOptions = { ...baseOptions.storeOptions, now: () => nowMs };
    const seedStore = new TeamRoomStore(storeOptions);
    expect(seedStore.init().ok).toBe(true);
    const seeded = seedStore.postMessage({
      identity: {
        memberId: 'james', roomId: 'main', profileName: 'main', memberKind: 'human',
        role: 'james', paneId: null, source: 'room_web',
      },
      payload: { body: 'Recover the young claim too.', clientNonce: 'boot-young-claim-1' },
    });
    const preclaimed = seedStore.claimActivationBatch('builder', { limit: 1 });
    expect(preclaimed.activations).toHaveLength(1);
    expect(preclaimed.activations[0].activation.status).toBe('claimed');
    seedStore.close();

    nowMs += 1_000;
    const deliveries = [];
    runtime = new TeamRoomRuntime({
      ...baseOptions,
      now: () => nowMs,
      store: new TeamRoomStore(storeOptions),
      staleClaimMs: 30_000,
      claimRecoveryIntervalMs: 25,
      deliverToPane: async (delivery) => { deliveries.push(delivery); return { ok: true }; },
    });
    expect((await runtime.start()).ok).toBe(true);
    await waitFor(() => deliveries.length === 2);
    expect(deliveries.map((delivery) => delivery.member.memberId).sort()).toEqual(['architect', 'oracle']);

    nowMs = 1_032_001;
    await waitFor(() => deliveries.some((delivery) => delivery.member.memberId === 'builder'));
    await waitFor(() => runtime.store.listActivations(seeded.message.messageId)
      .every((activation) => activation.status === 'delivered'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deliveries.filter((delivery) => delivery.member.memberId === 'builder')).toHaveLength(1);
  });

  test('replaces runtime CLI credentials on restart and revokes the prior generation', async () => {
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const firstStart = await runtime.start();
    const firstCredential = JSON.parse(fs.readFileSync(path.join(
      tempRoot, '.squidrun', 'runtime', 'team-room', 'credentials', 'builder.json'
    ), 'utf8'));
    await runtime.stop();
    runtime = new TeamRoomRuntime(runtimeOptions(tempRoot, async () => ({ ok: true })));
    const secondStart = await runtime.start();
    const secondCredential = JSON.parse(fs.readFileSync(path.join(
      tempRoot, '.squidrun', 'runtime', 'team-room', 'credentials', 'builder.json'
    ), 'utf8'));
    expect(secondCredential.token).not.toBe(firstCredential.token);
    expect(secondCredential).toEqual(expect.objectContaining({
      role: 'builder', paneId: '2', profileName: 'main', paneLaunchId: `pl_${'2'.repeat(32)}`,
      appGeneration: 'app-session-512', source: 'room_cli',
    }));
    expect(fs.existsSync(path.join(tempRoot, '.squidrun', 'runtime', 'team-room', 'credentials', 'james.json'))).toBe(false);
    expect(await request(secondStart.origin, '/api/cli/snapshot', { token: firstCredential.token }))
      .toEqual(expect.objectContaining({ statusCode: 401, payload: expect.objectContaining({ reason: 'room_credential_revoked' }) }));
    expect(await request(secondStart.origin, '/api/cli/snapshot', { token: secondCredential.token }))
      .toEqual(expect.objectContaining({ statusCode: 200, payload: expect.objectContaining({ ok: true }) }));
    expect(firstStart.origin).toMatch(/^http:\/\/127\.0\.0\.1:/u);
  });
});

describe('Team Room pairing registry', () => {
  test('enforces TTL, atomic one-use claims, and bounded attempts', () => {
    let nowMs = 1_000;
    const pairing = new TeamRoomPairingRegistry({ now: () => nowMs, randomInt: () => 123456, ttlMs: 300_000 });
    const first = pairing.create();
    expect(first.code).toBe('123456');
    expect(pairing.claim(first.code, '192.168.1.20')).toEqual(expect.objectContaining({ ok: true }));
    expect(pairing.claim(first.code, '192.168.1.20')).toEqual(expect.objectContaining({ ok: false }));
    const expired = pairing.create();
    nowMs = expired.expiresAtMs + 1;
    expect(pairing.claim(expired.code, '192.168.1.21')).toEqual(expect.objectContaining({ ok: false }));
    for (let index = 0; index < 8; index += 1) pairing.claim('999999', '192.168.1.22');
    expect(pairing.claim('999999', '192.168.1.22'))
      .toEqual({ ok: false, reason: 'room_pairing_rate_limited' });
  });
});
