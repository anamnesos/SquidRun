'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildTrustQuoteWorkRoomContract,
} = require('../modules/project-room-envelope');
const {
  PREREQUISITE_CONTRACT_VERSION,
  materializeTrustQuoteWorkRoomPrerequisites,
} = require('../modules/trustquote-work-room-prerequisites');

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

describe('TrustQuote work-room prerequisites materializer', () => {
  let squidrunRoot;
  let projectRoot;

  beforeEach(() => {
    squidrunRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-trustquote-root-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trustquote-work-room-'));
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# TrustQuote rules\n');
    fs.mkdirSync(path.join(squidrunRoot, 'ui', 'scripts'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(squidrunRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('dry run reports artifacts without writing profile/link/startup files', () => {
    const result = materializeTrustQuoteWorkRoomPrerequisites({
      squidrunRoot,
      projectPath: projectRoot,
      mainSessionScopeId: 'app-session-500',
      generatedAt: '2026-05-28T00:00:00.000Z',
    });

    expect(result.write).toBe(false);
    expect(result.artifacts.version).toBe(PREREQUISITE_CONTRACT_VERSION);
    expect(result.artifacts.sessionScopeId).toBe('app-session-500:trustquote');
    expect(result.results.every((entry) => entry.status === 'dry_run')).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.squidrun', 'link.json'))).toBe(false);
  });

  test('materialized profile contract and startup sources satisfy non-route TrustQuote blockers', () => {
    const result = materializeTrustQuoteWorkRoomPrerequisites({
      squidrunRoot,
      projectPath: projectRoot,
      mainSessionScopeId: 'app-session-500',
      generatedAt: '2026-05-28T00:00:00.000Z',
      write: true,
    });

    expect(result.results.map((entry) => entry.kind)).toEqual([
      'profile_root_contract',
      'profile_link',
      'startup_source_agents',
      'startup_source_roles',
      'startup_bundle',
      'workstream',
    ]);
    expect(result.results.every((entry) => ['created', 'updated', 'unchanged'].includes(entry.status))).toBe(true);

    const link = JSON.parse(fs.readFileSync(path.join(projectRoot, '.squidrun', 'link.json'), 'utf8'));
    expect(link).toEqual(expect.objectContaining({
      workspace: toPosix(projectRoot),
      profile: 'trustquote',
      session_id: 'app-session-500:trustquote',
    }));
    expect(link.room).toEqual(expect.objectContaining({
      id: 'trustquote',
      sessionScopeId: 'app-session-500:trustquote',
    }));

    const contract = buildTrustQuoteWorkRoomContract({
      squidrunRoot,
      projectPath: projectRoot,
      mainSessionScopeId: 'app-session-500',
    });

    expect(contract.status).toBe('blocked');
    expect(contract.canRenderTopTab).toBe(false);
    expect(contract.canRouteTask).toBe(false);
    expect(contract.readiness.projectRootBinding.status).toBe('configured');
    expect(contract.readiness.projectRootBinding.source).toBe('profile_root_contract');
    expect(contract.readiness.sourceFiles).toEqual([
      expect.objectContaining({ name: 'AGENTS.md', present: true, source: 'generated_room_startup' }),
      expect.objectContaining({ name: 'CLAUDE.md', present: true, source: 'project_root' }),
      expect.objectContaining({ name: 'ROLES.md', present: true, source: 'generated_room_startup' }),
    ]);
    expect(contract.readiness.link).toEqual(expect.objectContaining({
      status: 'current',
      issues: [],
    }));
    expect(contract.workstream).toEqual(expect.objectContaining({
      status: 'current',
      workstreamStatus: 'initialized_no_active_task',
      currentTask: null,
    }));
    expect(contract.blockers).toEqual([
      'route_unhealthy:builder:missing',
      'route_unhealthy:oracle:missing',
    ]);
  });

  test('does not overwrite a proven workstream while refreshing prerequisites', () => {
    materializeTrustQuoteWorkRoomPrerequisites({
      squidrunRoot,
      projectPath: projectRoot,
      mainSessionScopeId: 'app-session-500',
      generatedAt: '2026-05-28T00:00:00.000Z',
      write: true,
    });
    const workstreamPath = path.join(projectRoot, '.squidrun', 'work-rooms', 'trustquote', 'current-workstream.json');
    const provenWorkstream = {
      version: 'squidrun.work-room-workstream.v0',
      roomId: 'trustquote',
      profile: 'trustquote',
      projectRoot: toPosix(projectRoot),
      sessionScopeId: 'app-session-500:trustquote',
      status: 'route_proven',
      routeStatus: 'proven',
      currentTask: null,
      blockers: [],
      routeProof: {
        status: 'proven',
        generatedAt: '2026-05-28T00:01:00.000Z',
      },
      sourceRefs: ['proof'],
      generatedAt: '2026-05-28T00:01:00.000Z',
    };
    fs.writeFileSync(workstreamPath, `${JSON.stringify(provenWorkstream, null, 2)}\n`, 'utf8');

    const result = materializeTrustQuoteWorkRoomPrerequisites({
      squidrunRoot,
      projectPath: projectRoot,
      mainSessionScopeId: 'app-session-500',
      generatedAt: '2026-05-28T00:02:00.000Z',
      write: true,
    });

    expect(result.results.find((entry) => entry.kind === 'workstream')).toEqual(expect.objectContaining({
      status: 'preserved_proven',
    }));
    expect(JSON.parse(fs.readFileSync(workstreamPath, 'utf8'))).toEqual(provenWorkstream);
  });
});
