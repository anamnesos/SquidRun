const fs = require('fs');
const os = require('os');
const path = require('path');

const { SupervisorStore, loadSqliteDriver } = require('../modules/supervisor');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('supervisor store', () => {
  let tempDir;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-supervisor-'));
    store = new SupervisorStore({
      dbPath: path.join(tempDir, 'supervisor.sqlite'),
    });
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('initializes migrations and core tables', () => {
    const result = store.init();
    expect(result.ok).toBe(true);
    expect(store.isAvailable()).toBe(true);

    const migration = store.db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
    expect(migration.map((row) => row.version)).toEqual([1]);

    const tasksTable = store.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'supervisor_tasks'
    `).get();
    const eventsTable = store.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'supervisor_task_events'
    `).get();

    expect(tasksTable?.name).toBe('supervisor_tasks');
    expect(eventsTable?.name).toBe('supervisor_task_events');
  });

  test('enqueues, claims, heartbeats, and completes a task', () => {
    expect(store.init().ok).toBe(true);

    const enqueue = store.enqueueTask({
      objective: 'Echo hello from supervisor',
      priority: 200,
      ownerPane: 'builder-bg-1',
      contextSnapshot: {
        kind: 'shell',
        shellCommand: 'echo hello',
      },
    });
    expect(enqueue.ok).toBe(true);
    expect(enqueue.task.status).toBe('pending');

    const claim = store.claimNextTask({
      leaseOwner: 'supervisor-test',
      leaseMs: 5000,
      nowMs: 1000,
    });
    expect(claim.ok).toBe(true);
    expect(claim.task.taskId).toBe(enqueue.taskId);
    expect(claim.task.status).toBe('running');
    expect(claim.task.attemptCount).toBe(1);
    expect(claim.task.leaseOwner).toBe('supervisor-test');

    const heartbeat = store.heartbeatTask(enqueue.taskId, {
      leaseOwner: 'supervisor-test',
      leaseMs: 5000,
      nowMs: 2000,
    });
    expect(heartbeat.ok).toBe(true);
    expect(heartbeat.leaseExpiresAtMs).toBe(7000);

    const completion = store.completeTask(enqueue.taskId, {
      leaseOwner: 'supervisor-test',
      nowMs: 3000,
      resultPayload: { exitCode: 0 },
    });
    expect(completion.ok).toBe(true);
    expect(completion.task.status).toBe('complete');
    expect(completion.task.resultPayload).toEqual({ exitCode: 0 });

    const events = store.db.prepare(`
      SELECT event_type
      FROM supervisor_task_events
      WHERE task_id = ?
      ORDER BY created_at_ms ASC
    `).all(enqueue.taskId);
    const eventTypes = events.map((row) => row.event_type);
    expect(eventTypes).toHaveLength(4);
    expect(eventTypes).toEqual(expect.arrayContaining([
      'enqueued',
      'claimed',
      'heartbeat',
      'completed',
    ]));
  });

  test('requeues expired running tasks', () => {
    expect(store.init().ok).toBe(true);

    const enqueue = store.enqueueTask({
      objective: 'Stale task',
      contextSnapshot: {
        kind: 'shell',
        shellCommand: 'echo stale',
      },
    });
    expect(enqueue.ok).toBe(true);

    const claim = store.claimNextTask({
      leaseOwner: 'supervisor-test',
      leaseMs: 2000,
      nowMs: 1000,
    });
    expect(claim.ok).toBe(true);
    expect(claim.task.status).toBe('running');

    const requeue = store.requeueExpiredTasks({ nowMs: 4000 });
    expect(requeue.ok).toBe(true);
    expect(requeue.requeued).toBe(1);
    expect(requeue.taskIds).toEqual([enqueue.taskId]);

    const task = store.getTask(enqueue.taskId);
    expect(task.status).toBe('pending');
    expect(task.leaseOwner).toBeNull();
    expect(task.workerPid).toBeNull();
  });
});
