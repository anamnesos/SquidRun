/**
 * Shared transcript reader for runtime modules.
 * Reads JSONL transcript files from the workspace transcripts directory.
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH } = require('../../config');

const TRANSCRIPTS_DIR = path.join(WORKSPACE_PATH, 'memory', 'transcripts');

function getDateString() {
  return new Date().toISOString().split('T')[0];
}

function getTranscriptPath(role, date = null) {
  const dateStr = date || getDateString();
  return path.join(TRANSCRIPTS_DIR, `${role}-${dateStr}.jsonl`);
}

function parseTranscriptLines(lines) {
  return lines
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readTranscript(role, options = {}) {
  const { date, limit, since } = options;
  const filePath = getTranscriptPath(role, date);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    let entries = parseTranscriptLines(content.split('\n'));

    if (since) {
      const sinceTime = new Date(since).getTime();
      entries = entries.filter((entry) => new Date(entry.timestamp).getTime() > sinceTime);
    }

    if (limit && entries.length > limit) {
      entries = entries.slice(-limit);
    }

    return entries;
  } catch {
    return [];
  }
}

module.exports = {
  TRANSCRIPTS_DIR,
  getDateString,
  getTranscriptPath,
  parseTranscriptLines,
  readTranscript,
};
