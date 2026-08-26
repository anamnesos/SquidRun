'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_CALENDAR_MESSAGE_CURIOSITY_SCHEMA,
  readMiraCalendarMessageCuriosity,
} = require('../modules/mira-calendar-message-curiosity');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-calendar-message-'));
}

describe('Mira calendar/message curiosity', () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  test('reads compact calendar and message metadata without exporting bodies or sending', () => {
    projectRoot = tempProject();
    const calendarDir = path.join(projectRoot, 'workspace', 'calendar');
    const messagesDir = path.join(projectRoot, '.squidrun', 'messages');
    fs.mkdirSync(calendarDir, { recursive: true });
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(path.join(calendarDir, 'team-calendar.ics'), [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'DTSTART:20260513T090000Z',
      'SUMMARY:Secret customer meeting body should not leak',
      'DESCRIPTION:raw calendar body',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(messagesDir, 'builder.txt'), 'private message body\nsecond line', 'utf8');

    const result = readMiraCalendarMessageCuriosity({}, {
      projectRoot,
      commsHistoryReader: () => ({
        ok: true,
        limit: 50,
        scope: 'main',
        rows: [
          {
            rowId: 10,
            messageId: 'hm-test-10',
            sessionId: 'app-session-test',
            sender: 'mira',
            target: 'builder',
            status: 'routed',
            scope: 'main',
            timestampMs: 1778628300000,
            timestamp: '2026-05-12 23:25:00.000',
            excerpt: 'private comms excerpt should not leak',
            rawBody: 'private comms raw body should not leak',
          },
          {
            rowId: 9,
            messageId: 'hm-test-9',
            sessionId: 'app-session-test',
            sender: 'architect',
            target: 'builder',
            status: 'recorded',
            scope: 'main',
            timestampMs: 1778628200000,
            timestamp: '2026-05-12 23:23:20.000',
            excerpt: 'second private comms excerpt',
            rawBody: 'second private comms raw body',
          },
        ],
      }),
    });

    expect(result.schema).toBe(MIRA_CALENDAR_MESSAGE_CURIOSITY_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('calendar_message_metadata_read_only');
    expect(result.calendar_artifact_count).toBe(1);
    expect(result.message_artifact_count).toBe(1);
    expect(result.calendar_first_start).toBe('2026-05-13T09:00:00.000Z');
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'calendar',
        path: 'workspace/calendar/team-calendar.ics',
        record_count: 1,
      }),
      expect.objectContaining({
        kind: 'message',
        path: '.squidrun/messages/builder.txt',
        record_count: 2,
      }),
    ]));
    expect(result.connector_candidates.map((entry) => entry.candidate)).toEqual(expect.arrayContaining([
      'native_squidrun_comms',
      'calendar_connector',
      'message_connector',
    ]));
    expect(result.selected_connector_candidate).toEqual(expect.objectContaining({
      candidate: 'native_squidrun_comms',
      writes_or_sends: false,
      evidence: expect.objectContaining({
        message_artifact_count: 1,
        native_comms_row_count: 2,
      }),
    }));
    expect(result.native_comms_metadata).toEqual(expect.objectContaining({
      ok: true,
      row_count: 2,
      sender_counts: expect.objectContaining({ mira: 1, architect: 1 }),
      target_counts: expect.objectContaining({ builder: 2 }),
      status_counts: expect.objectContaining({ routed: 1, recorded: 1 }),
      role_pair_counts: expect.objectContaining({ 'mira->builder': 1, 'architect->builder': 1 }),
      mira_route_count: 1,
    }));
    expect(result.native_comms_metadata.latest_rows[0]).toEqual(expect.objectContaining({
      message_id: 'hm-test-10',
      sender: 'mira',
      target: 'builder',
      status: 'routed',
    }));
    expect(JSON.stringify(result)).not.toMatch(/Secret customer|private message body|raw calendar body|private comms|rawBody|excerpt/i);
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      internal_only: true,
      read_only: true,
      calendar_write_performed: false,
      message_send_performed: false,
      message_body_export_performed: false,
      network_performed: false,
      external_send_performed: false,
    }));
  });

  test('stays active with connector candidates when local artifacts are absent', () => {
    projectRoot = tempProject();

    const result = readMiraCalendarMessageCuriosity({}, {
      projectRoot,
      commsHistoryReader: () => ({ ok: false, reason: 'fixture_missing', rows: [] }),
    });

    expect(result.ok).toBe(true);
    expect(result.decision).toBe('calendar_message_metadata_read_only');
    expect(result.result_count).toBe(0);
    expect(result.calendar_artifact_count).toBe(0);
    expect(result.message_artifact_count).toBe(0);
    expect(result.connector_candidates.length).toBeGreaterThan(0);
    expect(result.no_mutation_performed).toBe(true);
  });
});
