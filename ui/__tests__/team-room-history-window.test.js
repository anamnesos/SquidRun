'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TeamRoomStore } = require('../modules/main/team-room-store');

// A room that spans several calendar days, so day grouping is exercised against
// real timestamps rather than a single bucket.
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = [
  { date: new Date(2026, 7, 21, 10, 0, 0), count: 5 },
  { date: new Date(2026, 7, 22, 10, 0, 0), count: 3 },
  { date: new Date(2026, 7, 23, 10, 0, 0), count: 7 },
];

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

describe('Team Room history windowing', () => {
  let tempDir;
  let store;
  let clockMs;
  let idCounter;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-room-history-'));
    idCounter = 0;
    clockMs = DAYS[0].date.getTime();
    store = new TeamRoomStore({
      dbPath: path.join(tempDir, 'room.db'),
      attachmentRoot: path.join(tempDir, 'media'),
      now: () => clockMs,
      randomUUID: () => `id-${++idCounter}`,
    });
    expect(store.init().ok).toBe(true);

    for (const day of DAYS) {
      for (let index = 0; index < day.count; index += 1) {
        clockMs = day.date.getTime() + index * 1000;
        const posted = store.postMessage({
          identity: {
            memberId: 'james',
            memberKind: 'human',
            role: 'james',
            paneId: null,
            source: 'room_web',
            roomId: 'main',
            profileName: 'main',
          },
          payload: {
            body: `${dayKey(day.date)} message ${index + 1}`,
            clientNonce: `seed-${dayKey(day.date)}-${index}`,
          },
        });
        expect(posted.ok).toBe(true);
      }
    }
  });

  afterEach(() => {
    try { store.close?.(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('groups every message under its own calendar day, newest day first', () => {
    const days = store.listMessageDays();
    expect(days.map((entry) => entry.day)).toEqual([
      dayKey(DAYS[2].date),
      dayKey(DAYS[1].date),
      dayKey(DAYS[0].date),
    ]);
    expect(days.map((entry) => entry.count)).toEqual([7, 3, 5]);
    expect(store.countMessages()).toBe(15);
  });

  test('returns one selected day and nothing from its neighbours', () => {
    const middle = store.listMessages(undefined, undefined, { day: dayKey(DAYS[1].date) });
    expect(middle).toHaveLength(3);
    for (const message of middle) {
      expect(message.body.startsWith(dayKey(DAYS[1].date))).toBe(true);
    }
  });

  test('a limit returns the newest messages, still oldest-first', () => {
    const windowed = store.listMessages(undefined, undefined, { limit: 4 });
    expect(windowed).toHaveLength(4);
    const seqs = windowed.map((message) => Number(message.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // The newest four all belong to the last seeded day.
    for (const message of windowed) {
      expect(message.body.startsWith(dayKey(DAYS[2].date))).toBe(true);
    }
  });

  test('paging backwards walks the whole room without repeats or gaps', () => {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const rows = cursor === null
        ? store.listMessages(undefined, undefined, { limit: 4 })
        : store.listMessages(undefined, undefined, { limit: 4, beforeSeq: cursor });
      if (rows.length === 0) break;
      seen.unshift(...rows);
      cursor = Number(rows[0].seq);
    }
    expect(seen).toHaveLength(15);
    const ids = new Set(seen.map((message) => message.messageId));
    expect(ids.size).toBe(15);
    expect(seen.map((message) => Number(message.seq)))
      .toEqual(store.listMessages().map((message) => Number(message.seq)));
  });

  test('an uncapped read still returns the whole room', () => {
    expect(store.listMessages()).toHaveLength(15);
  });

  test('a day with no messages is simply empty', () => {
    const empty = dayKey(new Date(DAYS[0].date.getTime() - DAY_MS));
    expect(store.listMessages(undefined, undefined, { day: empty })).toEqual([]);
  });
});
