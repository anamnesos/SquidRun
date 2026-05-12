'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_EMAIL_CURIOSITY_SCHEMA,
  MIRA_EMAIL_CURIOSITY_SNAPSHOT_SCHEMA,
  defaultEmailCuriositySnapshotPath,
  readMiraEmailCuriosity,
  writeMiraEmailCuriositySnapshot,
} = require('../modules/mira-email-curiosity');

function tempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-email-curiosity-'));
  fs.mkdirSync(path.join(projectRoot, '.squidrun', 'runtime'), { recursive: true });
  return projectRoot;
}

describe('Mira email curiosity', () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  test('reads compact connector metadata without exposing raw message ids or bodies', () => {
    const result = readMiraEmailCuriosity({
      labels: [
        { id: 'INBOX', name: 'INBOX', messagesTotal: 46985, messagesUnread: 45024, threadsUnread: 43963 },
        { id: 'STARRED', name: 'STARRED', messagesTotal: 14, messagesUnread: 11, threadsUnread: 11 },
      ],
      message_ids: ['19e1dafa17846125', '19e1dab7f81d85b7'],
      query: 'newer_than:7d -in:spam -in:trash',
    });

    expect(result.schema).toBe(MIRA_EMAIL_CURIOSITY_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('email_metadata_read_only');
    expect(result.label_count).toBe(2);
    expect(result.unread_total).toBe(45035);
    expect(result.top_labels[0]).toEqual(expect.objectContaining({
      id: 'INBOX',
      name: 'INBOX',
      messages_unread: 45024,
      threads_unread: 43963,
    }));
    expect(result.recent_message_count).toBe(2);
    expect(result.recent_messages[0]).toEqual(expect.objectContaining({
      message_ref: expect.stringMatching(/^email-msg:/),
    }));
    expect(result.label_pressure_buckets.map((entry) => entry.bucket)).toEqual(expect.arrayContaining([
      'inbox_unread',
      'starred_unread',
    ]));
    expect(result.snapshot_gaps).toEqual(expect.objectContaining({
      recent_message_count: 2,
      missing_sender_domain_count: 2,
      missing_subject_count: 2,
      missing_timestamp_count: 2,
      thread_poor_snapshot: true,
    }));
    expect(result.suggested_next_snapshot_queries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        query: expect.stringContaining('label:STARRED is:unread'),
        metadata_only: true,
        body_read_required: false,
        send_or_modify_required: false,
      }),
      expect.objectContaining({
        query: expect.stringContaining('label:INBOX'),
        metadata_only: true,
      }),
    ]));
    expect(result.pressure_question).toMatch(/metadata/i);
    expect(JSON.stringify(result)).not.toContain('19e1dafa17846125');
    expect(JSON.stringify(result)).not.toMatch(/raw body|credential_secret|oauth_token/i);
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      internal_only: true,
      read_only: true,
      email_body_read: false,
      email_send_performed: false,
      email_modify_performed: false,
      raw_message_ids_exposed: false,
      suggested_queries_executed: false,
      external_send_performed: false,
    }));
  });

  test('writes and reads a compact snapshot file for scout reuse', () => {
    projectRoot = tempProject();
    const write = writeMiraEmailCuriositySnapshot({
      labels: [{ id: 'UNREAD', name: 'UNREAD', messagesTotal: 20, messagesUnread: 20 }],
      recent_message_ids: ['abc123'],
    }, { projectRoot });

    expect(write.schema).toBe(MIRA_EMAIL_CURIOSITY_SNAPSHOT_SCHEMA);
    expect(write.decision).toBe('email_snapshot_written');
    expect(write.label_count).toBe(1);
    expect(write.recent_message_count).toBe(1);
    expect(fs.existsSync(defaultEmailCuriositySnapshotPath(projectRoot))).toBe(true);

    const read = readMiraEmailCuriosity({}, { projectRoot });
    expect(read.ok).toBe(true);
    expect(read.top_labels[0]).toEqual(expect.objectContaining({
      id: 'UNREAD',
      messages_unread: 20,
    }));
    expect(JSON.stringify(read)).not.toContain('abc123');
  });

  test('preserves stored hashed refs and reports metadata gaps instead of rehashing snapshot objects', () => {
    projectRoot = tempProject();
    const snapshotPath = defaultEmailCuriositySnapshotPath(projectRoot);
    fs.writeFileSync(snapshotPath, JSON.stringify({
      schema: MIRA_EMAIL_CURIOSITY_SNAPSHOT_SCHEMA,
      source: 'gmail_connector_metadata',
      query: 'newer_than:7d -in:spam -in:trash label:INBOX',
      labels: [{ id: 'IMPORTANT', name: 'IMPORTANT', messages_total: 8, messages_unread: 6, threads_unread: 5 }],
      recent_messages: [
        { message_ref: 'email-msg:aaaabbbbccccdddd' },
        { message_ref: 'email-msg:1111222233334444' },
      ],
    }), 'utf8');

    const result = readMiraEmailCuriosity({}, { projectRoot });

    expect(result.ok).toBe(true);
    expect(result.recent_messages.map((entry) => entry.message_ref)).toEqual([
      'email-msg:aaaabbbbccccdddd',
      'email-msg:1111222233334444',
    ]);
    expect(result.snapshot_gaps).toEqual(expect.objectContaining({
      missing_sender_domain_count: 2,
      missing_subject_count: 2,
      missing_timestamp_count: 2,
      thread_poor_snapshot: true,
    }));
    expect(result.suggested_next_snapshot_queries[0]).toEqual(expect.objectContaining({
      query: expect.stringContaining('label:IMPORTANT is:unread'),
      body_read_required: false,
    }));
  });

  test('reports unavailable when no connector snapshot exists', () => {
    projectRoot = tempProject();
    const result = readMiraEmailCuriosity({}, { projectRoot });

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('unavailable_in_this_runtime');
    expect(result.reason).toBe('email_connector_snapshot_missing');
    expect(result.label_count).toBe(0);
    expect(result.recent_message_count).toBe(0);
    expect(result.no_mutation_performed).toBe(true);
  });
});
