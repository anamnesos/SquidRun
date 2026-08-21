const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadSeatIdentityContext,
  SEAT_DEFINITIONS,
  MAX_SOURCE_BYTES,
} = require('../modules/seat-identity-loader');

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-seat-identity-'));
  tempRoots.push(root);
  return root;
}

function writeRelative(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function makeProfile(definition, overrides = {}) {
  const base = {
    schema: 'squidrun.seat_self_profile.v1',
    version: 1,
    seat_id: definition.seatId,
    name: definition.name,
    runtime_address: definition.seatId,
    pane_id: definition.paneId,
    identity_owner: definition.name,
    authority_event: {
      surface: 'team_room',
      message_id: 'trm-authority',
      author: 'james',
      date: '2026-08-20',
    },
    chosen_job: {
      title: `${definition.name.toLowerCase()}_chosen_job`,
      center: ['proof', 'continuity'],
    },
    hard_anchors: [`name_is_${definition.name.toLowerCase()}`, 'peer_overwrite_forbidden'],
    continuity: {
      canonical_charter: definition.canonicalPath,
      peer_overwrite_allowed: false,
    },
  };
  return {
    ...base,
    ...overrides,
    continuity: {
      ...base.continuity,
      ...(overrides.continuity || {}),
    },
  };
}

function materializeSeat(root, definition, marker = definition.name) {
  for (const source of definition.sources) {
    if (source.kind === 'profile') {
      writeRelative(root, source.path, `${JSON.stringify(makeProfile(definition), null, 2)}\n`);
    } else {
      writeRelative(root, source.path, `# ${definition.name} ${source.kind}\n\n${marker}_${source.kind}_PRIVATE\n`);
    }
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root && path.basename(root).startsWith('squidrun-seat-identity-')) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('seat-identity-loader', () => {
  test.each([
    ['architect', 1],
    ['builder', 2],
    ['oracle', 3],
  ])('loads only the active %s seat allowlist', (seatId, paneId) => {
    const root = makeTempRoot();
    for (const definition of Object.values(SEAT_DEFINITIONS)) materializeSeat(root, definition);

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: seatId,
      paneId,
      loadedAt: '2026-08-21T04:50:00.000Z',
    });

    expect(result.status).toBe('complete');
    expect(result.sources.map((source) => source.path)).toEqual(
      SEAT_DEFINITIONS[seatId].sources.map((source) => source.path)
    );
    for (const other of Object.values(SEAT_DEFINITIONS).filter((item) => item.seatId !== seatId)) {
      expect(result.sources.some((source) => source.path.includes(`/${other.seatId}/`))).toBe(false);
      expect(result.promptContext).not.toContain(`${other.name}_charter_PRIVATE`);
    }
    expect(result.promptContext).toContain(`PERSONAL CONTINUITY — ${SEAT_DEFINITIONS[seatId].name}`);
    expect(result.promptContext).toContain(SEAT_DEFINITIONS[seatId].canonicalPath);
  });

  test('missing Vera charter is partial and never falls back to another seat', () => {
    const root = makeTempRoot();
    materializeSeat(root, SEAT_DEFINITIONS.architect, 'MIRA');
    materializeSeat(root, SEAT_DEFINITIONS.builder, 'ROOK');
    materializeSeat(root, SEAT_DEFINITIONS.oracle, 'VERA');
    fs.unlinkSync(path.join(root, ...SEAT_DEFINITIONS.oracle.canonicalPath.split('/')));

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'oracle',
      paneId: 3,
      writeReceipt: false,
    });

    expect(result.status).toBe('partial');
    expect(result.missingSources).toContain(SEAT_DEFINITIONS.oracle.canonicalPath);
    expect(result.sources.every((source) => source.path.includes('vera-'))).toBe(true);
    expect(result.promptContext).not.toContain('MIRA_');
    expect(result.promptContext).not.toContain('ROOK_');
  });

  test.each([
    ['schema', { schema: 'wrong.schema' }, 'profile_schema_mismatch'],
    ['version', { version: 99 }, 'profile_version_unsupported'],
    ['seat', { seat_id: 'architect' }, 'profile_seat_mismatch'],
    ['name', { name: 'Not Rook' }, 'profile_name_mismatch'],
    ['pane', { pane_id: 3 }, 'profile_pane_mismatch'],
    ['charter', { continuity: { canonical_charter: 'workspace/knowledge/vera-self-charter.md' } }, 'profile_charter_mismatch'],
  ])('profile %s mismatch fails closed as partial', (_label, override, reason) => {
    const root = makeTempRoot();
    const definition = SEAT_DEFINITIONS.builder;
    materializeSeat(root, definition);
    const profilePath = definition.sources.find((source) => source.kind === 'profile').path;
    writeRelative(root, profilePath, JSON.stringify(makeProfile(definition, override)));

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      writeReceipt: false,
    });

    expect(result.status).toBe('partial');
    expect(result.invalidSources).toContain(profilePath);
    expect(result.sources.find((source) => source.path === profilePath).reason).toContain(reason);
  });

  test('malformed profile JSON returns partial instead of throwing', () => {
    const root = makeTempRoot();
    const definition = SEAT_DEFINITIONS.builder;
    materializeSeat(root, definition);
    const profilePath = definition.sources.find((source) => source.kind === 'profile').path;
    writeRelative(root, profilePath, '{"schema":');

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      writeReceipt: false,
    });

    expect(result.status).toBe('partial');
    expect(result.invalidSources).toContain(profilePath);
    expect(result.sources.find((source) => source.path === profilePath).reason)
      .toBe('profile_json_parse_failed');
  });

  test('absolute, escape, and junction allowlist paths are rejected', () => {
    const root = makeTempRoot();
    const outside = makeTempRoot();
    writeRelative(outside, 'identity.md', '# outside');
    const junctionPath = path.join(root, 'junction');
    fs.symlinkSync(outside, junctionPath, 'junction');
    const definitions = {
      builder: {
        seatId: 'builder',
        paneId: 2,
        name: 'Rook',
        canonicalPath: 'junction/identity.md',
        sources: [
          { path: path.join(outside, 'identity.md'), kind: 'charter', required: true },
          { path: '../escape.md', kind: 'capability', required: false },
          { path: 'junction/identity.md', kind: 'growth', required: false },
        ],
      },
    };

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      definitions,
      writeReceipt: false,
    });

    expect(result.status).toBe('invalid_binding');
    expect(result.invalidSources).toHaveLength(3);
    expect(result.promptContext).toBe('');
    expect(result.sources.map((source) => source.reason)).toEqual(expect.arrayContaining([
      'unsafe_path',
      'path_escapes_project_root',
      'symlink_or_junction_rejected',
    ]));
  });

  test('oversized source is bounded with an explicit invalid condition', () => {
    const root = makeTempRoot();
    const definition = SEAT_DEFINITIONS.builder;
    materializeSeat(root, definition);
    writeRelative(root, definition.canonicalPath, Buffer.alloc(MAX_SOURCE_BYTES + 1, 65));

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      writeReceipt: false,
    });

    expect(result.status).toBe('partial');
    expect(result.sources.find((source) => source.path === definition.canonicalPath)).toEqual(
      expect.objectContaining({ condition: 'invalid', reason: 'source_oversized' })
    );
    expect(Buffer.byteLength(result.promptContext, 'utf8')).toBeLessThanOrEqual(6 * 1024 + 64);
  });

  test('role and pane contradiction is invalid_binding with no personal context', () => {
    const root = makeTempRoot();
    materializeSeat(root, SEAT_DEFINITIONS.builder);

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 3,
      writeReceipt: false,
    });

    expect(result.status).toBe('invalid_binding');
    expect(result.promptContext).toBe('');
    expect(result.sources).toEqual([]);
  });

  test('engine changes do not alter identity source paths or hashes', () => {
    const root = makeTempRoot();
    materializeSeat(root, SEAT_DEFINITIONS.builder);
    const common = { projectRoot: root, runtimeRole: 'builder', paneId: 2, writeReceipt: false };

    const first = loadSeatIdentityContext({ ...common, modelCommand: 'codex-a' });
    const second = loadSeatIdentityContext({ ...common, modelCommand: 'codex-b' });

    expect(second.sources.map(({ path: sourcePath, sha256 }) => ({ path: sourcePath, sha256 }))).toEqual(
      first.sources.map(({ path: sourcePath, sha256 }) => ({ path: sourcePath, sha256 }))
    );
  });

  test('age is provenance only while an owner hash mismatch is stale', () => {
    const root = makeTempRoot();
    const definition = SEAT_DEFINITIONS.builder;
    materializeSeat(root, definition);
    const charterPath = path.join(root, ...definition.canonicalPath.split('/'));
    fs.utimesSync(charterPath, new Date('2001-01-01T00:00:00.000Z'), new Date('2001-01-01T00:00:00.000Z'));

    const oldButValid = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      writeReceipt: false,
    });
    expect(oldButValid.status).toBe('complete');

    const profilePath = definition.sources.find((source) => source.kind === 'profile').path;
    writeRelative(root, profilePath, JSON.stringify(makeProfile(definition, {
      continuity: {
        required_companion_hashes: {
          [definition.canonicalPath]: '0'.repeat(64),
        },
      },
    })));
    const stale = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      writeReceipt: false,
    });
    expect(stale.status).toBe('partial');
    expect(stale.staleSources).toContain(definition.canonicalPath);
    expect(stale.sources.find((source) => source.path === definition.canonicalPath).reason)
      .toBe('owner_required_companion_hash_mismatch');
  });

  test('owner-declared companion revision mismatch is stale without using mtime', () => {
    const root = makeTempRoot();
    const definition = SEAT_DEFINITIONS.builder;
    materializeSeat(root, definition);
    writeRelative(root, definition.canonicalPath, '# Rook\n\nRevision: 2\n');
    const profilePath = definition.sources.find((source) => source.kind === 'profile').path;
    writeRelative(root, profilePath, JSON.stringify(makeProfile(definition, {
      continuity: {
        required_companion_revisions: {
          [definition.canonicalPath]: '3',
        },
      },
    })));

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      writeReceipt: false,
    });

    expect(result.status).toBe('partial');
    expect(result.staleSources).toContain(definition.canonicalPath);
    expect(result.sources.find((source) => source.path === definition.canonicalPath)).toEqual(
      expect.objectContaining({
        reason: 'owner_required_companion_revision_mismatch',
        expectedRevision: '3',
        actualRevision: '2',
      })
    );
  });

  test('owner-declared partial stays partial and is not relabeled stale', () => {
    const root = makeTempRoot();
    const definition = SEAT_DEFINITIONS.builder;
    materializeSeat(root, definition);
    const profilePath = definition.sources.find((source) => source.kind === 'profile').path;
    writeRelative(root, profilePath, JSON.stringify(makeProfile(definition, {
      continuity: { status: 'partial' },
    })));

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      writeReceipt: false,
    });

    expect(result.status).toBe('partial');
    expect(result.staleSources).toEqual([]);
    expect(result.partialReasons).toContain('owner_declared_continuity_partial');
  });

  test('owner may explicitly declare continuity stale without an age heuristic', () => {
    const root = makeTempRoot();
    const definition = SEAT_DEFINITIONS.builder;
    materializeSeat(root, definition);
    const profilePath = definition.sources.find((source) => source.kind === 'profile').path;
    writeRelative(root, profilePath, JSON.stringify(makeProfile(definition, {
      continuity: { state: 'stale' },
    })));

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      writeReceipt: false,
    });

    expect(result.status).toBe('partial');
    expect(result.staleSources).toContain(profilePath);
    expect(result.sources.find((source) => source.path === profilePath).reason)
      .toBe('owner_declared_continuity_stale');
  });

  test('receipt is atomic metadata only and personal source bytes remain unchanged', () => {
    const root = makeTempRoot();
    const definition = SEAT_DEFINITIONS.builder;
    materializeSeat(root, definition, 'DO_NOT_PUT_THIS_PROSE_IN_RECEIPT');
    const charterPath = path.join(root, ...definition.canonicalPath.split('/'));
    const before = fs.readFileSync(charterPath);

    const result = loadSeatIdentityContext({
      projectRoot: root,
      runtimeRole: 'builder',
      paneId: 2,
      loadedAt: '2026-08-21T04:50:00.000Z',
    });
    const receiptText = fs.readFileSync(result.receiptPath, 'utf8');

    expect(receiptText).not.toContain('DO_NOT_PUT_THIS_PROSE_IN_RECEIPT');
    expect(receiptText).not.toContain('promptContext');
    expect(JSON.parse(receiptText)).toEqual(expect.objectContaining({
      schema: 'squidrun.seat_identity_load.v1',
      seatId: 'builder',
      paneId: 2,
      status: 'complete',
    }));
    expect(fs.readFileSync(charterPath)).toEqual(before);
    expect(fs.readdirSync(path.dirname(result.receiptPath)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
