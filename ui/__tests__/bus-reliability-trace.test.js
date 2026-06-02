const fs = require('fs');
const os = require('os');
const path = require('path');

describe('bus reliability trace', () => {
  let tempDir;
  let tracePath;
  let previousTracePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-bus-trace-'));
    tracePath = path.join(tempDir, 'bus-reliability-trace.jsonl');
    previousTracePath = process.env.SQUIDRUN_BUS_TRACE_PATH;
    process.env.SQUIDRUN_BUS_TRACE_PATH = tracePath;
    jest.resetModules();
  });

  afterEach(() => {
    if (previousTracePath === undefined) {
      delete process.env.SQUIDRUN_BUS_TRACE_PATH;
    } else {
      process.env.SQUIDRUN_BUS_TRACE_PATH = previousTracePath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.resetModules();
  });

  test('rotates oversized trace files and caps the rotated archive tail', () => {
    const {
      appendBusTraceEvent,
      listRotatedTraceFiles,
    } = require('../modules/bus-reliability-trace');

    fs.writeFileSync(tracePath, `${'x'.repeat(4096)}\n`, 'utf8');
    const ok = appendBusTraceEvent({
      eventType: 'trace_rotation_sentinel',
      payload: 'small event',
    }, {
      maxBytes: 1024,
      maxEventBytes: 512,
      rotatedFileLimit: 2,
      nowMs: Date.parse('2026-06-02T11:00:00.000Z'),
    });

    expect(ok).toBe(true);
    const activeText = fs.readFileSync(tracePath, 'utf8');
    const activeLines = activeText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(activeLines.map((entry) => entry.eventType)).toEqual([
      'bus_trace_rotated',
      'trace_rotation_sentinel',
    ]);
    expect(fs.statSync(tracePath).size).toBeLessThanOrEqual(1024);

    const rotatedFiles = listRotatedTraceFiles(tracePath);
    expect(rotatedFiles).toHaveLength(1);
    expect(rotatedFiles[0].size).toBeLessThanOrEqual(1024);
  });

  test('prunes older rotated archives to the configured file limit', () => {
    const {
      appendBusTraceEvent,
      listRotatedTraceFiles,
    } = require('../modules/bus-reliability-trace');

    for (let index = 0; index < 4; index += 1) {
      fs.writeFileSync(tracePath, `${String(index).repeat(2048)}\n`, 'utf8');
      appendBusTraceEvent({
        eventType: 'trace_rotation_sentinel',
        index,
      }, {
        maxBytes: 1024,
        maxEventBytes: 512,
        rotatedFileLimit: 2,
        nowMs: Date.parse(`2026-06-02T11:00:0${index}.000Z`),
      });
    }

    const rotatedFiles = listRotatedTraceFiles(tracePath);
    expect(rotatedFiles).toHaveLength(2);
    expect(rotatedFiles.every((file) => file.size <= 1024)).toBe(true);
  });

  test('summarizes oversized single events before appending', () => {
    const {
      appendBusTraceEvent,
    } = require('../modules/bus-reliability-trace');

    const ok = appendBusTraceEvent({
      eventType: 'huge_trace_payload',
      payload: 'x'.repeat(4096),
    }, {
      maxBytes: 2048,
      maxEventBytes: 512,
      rotatedFileLimit: 2,
    });

    expect(ok).toBe(true);
    const [entry] = fs.readFileSync(tracePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(entry).toEqual(expect.objectContaining({
      eventType: 'bus_trace_event_oversize',
      originalEventType: 'huge_trace_payload',
      omittedByteLength: expect.any(Number),
    }));
    expect(entry.originalPayloadFingerprint).toEqual(expect.objectContaining({
      sha256: expect.any(String),
    }));
  });
});
