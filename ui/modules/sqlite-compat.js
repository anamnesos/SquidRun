/**
 * SQLite compatibility shim.
 *
 * Electron's bundled Node.js does not include `node:sqlite` (requires Node 22.5+).
 * This module tries `node:sqlite` first and falls back to `better-sqlite3`,
 * which is already an Electron-rebuilt native dependency.
 */

let _DatabaseSync;
let _backend;

function resolve() {
  if (_DatabaseSync) return;
  try {
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      _DatabaseSync = mod.DatabaseSync;
      _backend = 'node:sqlite';
      return;
    }
  } catch {
    // node:sqlite not available — expected inside Electron.
  }
  _DatabaseSync = require('better-sqlite3');
  _backend = 'better-sqlite3';
}

function getDatabaseSync() {
  resolve();
  return _DatabaseSync;
}

function getBackend() {
  resolve();
  return _backend;
}

/**
 * Create a new database connection, handling API differences between backends.
 * @param {string} filename  Path to the database file.
 * @param {{ allowExtension?: boolean }} [opts]
 */
function openDatabase(filename, opts) {
  resolve();
  if (_backend === 'node:sqlite') {
    return new _DatabaseSync(filename, opts || {});
  }
  // better-sqlite3 ignores unknown options; omit allowExtension.
  return new _DatabaseSync(filename);
}

module.exports = { getDatabaseSync, getBackend, openDatabase };
