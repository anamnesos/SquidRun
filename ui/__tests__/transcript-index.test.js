'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseClaudeTranscriptRecord,
  parseClaudeTranscriptFile,
  buildTranscriptIndex,
  searchTranscriptIndex,
} = require('../modules/transcript-index');

describe('transcript-index', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-transcript-index-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('parses user conversation turns and tags corrections/entities', () => {
    const record = parseClaudeTranscriptRecord({
      type: 'user',
      sessionId: 'session-1',
      timestamp: '2026-03-28T23:00:00.000Z',
      message: {
        role: 'user',
        content: 'Actually that is not why Qeline affects me. It had to do with my wife\'s brother and Michelle Aviso at 8754356993.',
      },
    }, {
      sourceFile: 'C:\\test\\session.jsonl',
      lineNumber: 7,
    });

    expect(record).toEqual(expect.objectContaining({
      speaker: 'user',
      sessionId: 'session-1',
      sourceCitation: 'C:\\test\\session.jsonl:7',
    }));
    expect(record.tags).toEqual(expect.arrayContaining(['correction', 'qeline_case', 'telegram']));
    expect(record.entities).toEqual(expect.arrayContaining(['Michelle Aviso', '8754356993']));
  });

  test('ignores tool-result only user records', () => {
    const record = parseClaudeTranscriptRecord({
      type: 'user',
      sessionId: 'session-1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_123',
            content: 'stdout only',
          },
        ],
      },
    }, {
      sourceFile: 'C:\\test\\session.jsonl',
      lineNumber: 12,
    });

    expect(record).toBeNull();
  });

  test('builds an index from transcript files and returns searchable results', () => {
    const projectsDir = path.join(tempRoot, 'claude-projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    const transcriptPath = path.join(projectsDir, 'session-a.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-a',
        timestamp: '2026-03-28T22:00:00.000Z',
        message: {
          role: 'user',
          content: 'the user said Qeline first mattered because of his wife\'s brother and Michelle Aviso.',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-a',
        timestamp: '2026-03-28T22:01:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Decision: search the transcript archive before answering.' },
          ],
        },
      }),
      JSON.stringify({
        type: 'progress',
        data: { type: 'hook_progress' },
      }),
      '',
    ].join('\n'));

    const indexPath = path.join(tempRoot, 'transcript-index.jsonl');
    const metaPath = path.join(tempRoot, 'transcript-index-meta.json');

    const buildResult = buildTranscriptIndex({
      projectsDir,
      indexPath,
      metaPath,
    });

    expect(buildResult.ok).toBe(true);
    expect(buildResult.transcriptFileCount).toBe(1);
    expect(buildResult.recordCount).toBe(2);
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.existsSync(metaPath)).toBe(true);

    const searchResult = searchTranscriptIndex('wife brother Michelle Aviso', {
      indexPath,
      metaPath,
      limit: 3,
    });

    expect(searchResult.count).toBeGreaterThan(0);
    expect(searchResult.results[0]).toEqual(expect.objectContaining({
      speaker: 'user',
    }));
    expect(searchResult.results[0].excerpt).toContain('Michelle Aviso');
  });

  test('parses a transcript file and reports malformed lines separately', () => {
    const transcriptPath = path.join(tempRoot, 'session-b.jsonl');
    fs.writeFileSync(transcriptPath, [
      '{"type":"user","sessionId":"session-b","message":{"role":"user","content":"hello"}}',
      '{bad json',
      '',
    ].join('\n'));

    const result = parseClaudeTranscriptFile(transcriptPath);
    expect(result.records).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual(expect.objectContaining({
      lineNumber: 2,
    }));
  });
});
