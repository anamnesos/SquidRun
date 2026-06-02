const fs = require('fs');
const os = require('os');
const path = require('path');

describe('live-task-audit preview server', () => {
  let tempRoot;
  let workItemRoot;
  let taskAuditItemsPath;
  let ledger;
  let sidecar;
  let previewServerModule;
  let runningServer;
  let baseUrl;

  function writeJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  }

  beforeEach(async () => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-task-audit-preview-'));
    workItemRoot = path.join(tempRoot, '.squidrun', 'runtime', 'work-items');
    taskAuditItemsPath = path.join(tempRoot, '.squidrun', 'runtime', 'live-task-audit-sidecar', 'task-audit-items.json');
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      WORKSPACE_PATH: path.join(tempRoot, '.squidrun'),
      PROJECT_ROOT: tempRoot,
      getActiveProfile: () => 'main',
      getProjectRoot: () => tempRoot,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        '.squidrun',
        String(relPath || '')
          .replace(/^[/\\]+/, '')
          .replace(/[/\\]+/g, path.sep),
      ),
    }));
    ledger = require('../modules/main/work-item-ledger');
    sidecar = require('../modules/main/live-task-audit-sidecar');
    previewServerModule = require('../scripts/hm-live-task-audit-preview');

    ledger.openWorkItem({
      id: 'wi-sidecar-preview-active',
      session: 'app-session-389',
      profile: 'main',
      window: 'main',
      projectName: 'squidrun',
      projectPath: tempRoot,
      sourceMessageIds: ['architect#154'],
      objective: 'Preview the task audit sidecar in a browser',
      ownerRoles: ['builder'],
      requiredProof: ['builder_code'],
    }, {
      workItemRoot,
      now: '2026-05-30T21:55:00.000Z',
    });
    writeJson(taskAuditItemsPath, {
      items: [{
        id: 'future-browser-proof',
        title: 'Run Codex browser proof after preview opens',
        kind: 'codex_browser',
        status: 'queued',
        sessionId: 'app-session-389',
        updatedAt: '2026-05-30T21:56:00.000Z',
      }],
    });

    const preview = previewServerModule.createLiveTaskAuditPreviewServer({
      port: 0,
      snapshotOptions: {
        workItemRoot,
        taskAuditItemsPath,
        now: '2026-05-30T21:57:00.000Z',
      },
    });
    runningServer = preview.server;
    await new Promise((resolve) => runningServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${runningServer.address().port}`;
  });

  afterEach(async () => {
    if (runningServer) {
      await new Promise((resolve) => runningServer.close(resolve));
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('serves a clearly labeled read-only preview page wired to the snapshot endpoint', async () => {
    const response = await fetch(`${baseUrl}${previewServerModule.PREVIEW_ROUTE}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('PREVIEW');
    expect(html).toContain('not the final Electron sidecar window');
    expect(html).toContain('data-snapshot-url="/snapshot.json"');
    expect(html).toContain('SquidRun Task Audit');
    expect(html).toContain('Needs Doing');
    expect(html).toContain('Audit / Cleanup Later');
    expect(html).toContain('History');
    expect(html).toContain('taskAuditLayouts');
    expect(html).toContain('taskAuditStage');
    expect(html).toContain('taskAuditHealth');
    expect(html).toContain('historyCount');
    expect(html).not.toContain('terminalHistoryCount');
    expect(html).not.toContain('terminalBlockerCount');
    expect(html).not.toContain('taskAuditAuthority');
    expect(html).not.toContain('taskAuditSchema');
    expect(html).not.toContain('taskAuditSource');
    expect(html).not.toMatch(/Terminal Cockpit|Command Center|Route Map|taskAuditConcepts/);
  });

  test('serves the same two-tab preview for selectable layout options', async () => {
    const tableResponse = await fetch(`${baseUrl}${previewServerModule.PREVIEW_ROUTE}?layout=table`);
    const timelineResponse = await fetch(`${baseUrl}${previewServerModule.PREVIEW_ROUTE}?layout=timeline`);
    const html = await tableResponse.text();
    const timelineHtml = await timelineResponse.text();

    expect(tableResponse.status).toBe(200);
    expect(timelineResponse.status).toBe(200);
    expect(html).toContain('Needs Doing');
    expect(html).toContain('Audit / Cleanup Later');
    expect(html).toContain('History');
    expect(html).toContain('taskAuditLayouts');
    expect(timelineHtml).toContain('Needs Doing');
    expect(timelineHtml).toContain('Audit / Cleanup Later');
    expect(timelineHtml).toContain('History');
    expect(html).not.toMatch(/Terminal Cockpit|Command Center|Route Map/);
  });

  test('renderer keeps required row fields and drops old concept labels', () => {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'live-task-audit-sidecar-renderer.js'), 'utf8');

    for (const label of ['Task Title', 'Why It Matters', 'Owner', 'Status', 'Last Updated', 'Source', 'Next Action']) {
      expect(renderer).toContain(label);
    }
    for (const label of ['What Happened', 'Verdict', 'Closed At', 'Why']) {
      expect(renderer).toContain(label);
    }
    expect(renderer).toContain("id: 'table'");
    expect(renderer).toContain("id: 'timeline'");
    expect(renderer).not.toMatch(/id: 'split'|label: 'Split'|task-audit-split-layout/);
    expect(renderer).not.toMatch(/Terminal Cockpit|Command Center|Route Map|taskAuditConcepts/);
  });

  test('renderer keeps every task-audit section heading including empty Other', () => {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'live-task-audit-sidecar-renderer.js'), 'utf8');

    expect(renderer).toContain("const SECTION_ORDER = ['Mira', 'TrustQuote', 'SquidRun', 'Other']");
    expect(renderer).toContain('.map((section) => ({ section, items: groups.get(section) || [] }))');
    expect(renderer).not.toContain('.filter((group) => group.items.length > 0)');
    expect(renderer).toContain("'No items'");
  });

  test('serves the same live-task-audit snapshot contract without accepting writes', async () => {
    const snapshotResponse = await fetch(`${baseUrl}${previewServerModule.SNAPSHOT_ROUTE}`);
    const snapshot = await snapshotResponse.json();
    const postResponse = await fetch(`${baseUrl}${previewServerModule.SNAPSHOT_ROUTE}`, { method: 'POST' });
    const postBody = await postResponse.json();

    expect(snapshotResponse.status).toBe(200);
    expect(snapshot.schema).toBe(sidecar.SNAPSHOT_SCHEMA);
    expect(snapshot.active.items).toEqual([
      expect.objectContaining({
        id: 'wi-sidecar-preview-active',
        title: 'Preview the task audit sidecar in a browser',
      }),
    ]);
    expect(snapshot.future.items).toEqual([
      expect.objectContaining({
        id: 'future-browser-proof',
        title: 'Run Codex browser proof after preview opens',
      }),
    ]);
    expect(postResponse.status).toBe(405);
    expect(postBody.reason).toBe('read_only_preview_get_head_only');
  });
});
