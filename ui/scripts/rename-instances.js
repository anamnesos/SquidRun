#!/usr/bin/env node
/**
 * Pre-startup script to rename instance folders to new short names.
 * Run this BEFORE starting the app (when folders aren't locked by agents).
 *
 * Usage: node ui/scripts/rename-instances.js
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(__dirname, '..', '..', 'workspace', 'instances');

const RENAMES = [
  { old: 'lead', new: 'arch' },
  { old: 'orchestrator', new: 'infra' },
  { old: 'worker-a', new: 'front' },
  { old: 'worker-b', new: 'back' },
  { old: 'investigator', new: 'ana' },
  { old: 'reviewer', new: 'rev' },
];

console.log('Hivemind Instance Folder Rename Script');
console.log('======================================');
console.log(`Workspace: ${WORKSPACE}\n`);

let renamed = 0;
let skipped = 0;
let errors = 0;

for (const { old: oldName, new: newName } of RENAMES) {
  const oldPath = path.join(WORKSPACE, oldName);
  const newPath = path.join(WORKSPACE, newName);

  // Check if old folder exists
  if (!fs.existsSync(oldPath)) {
    // Check if new folder already exists (already renamed)
    if (fs.existsSync(newPath)) {
      console.log(`[SKIP] ${oldName} -> ${newName} (already renamed)`);
      skipped++;
    } else {
      console.log(`[SKIP] ${oldName} -> ${newName} (source not found)`);
      skipped++;
    }
    continue;
  }

  // Check if target already exists (conflict)
  if (fs.existsSync(newPath)) {
    console.log(`[ERROR] ${oldName} -> ${newName} (target exists, manual merge needed)`);
    errors++;
    continue;
  }

  // Do the rename
  try {
    fs.renameSync(oldPath, newPath);
    console.log(`[OK] ${oldName} -> ${newName}`);
    renamed++;
  } catch (err) {
    console.log(`[ERROR] ${oldName} -> ${newName}: ${err.message}`);
    errors++;
  }
}

console.log(`\nDone: ${renamed} renamed, ${skipped} skipped, ${errors} errors`);

if (errors > 0) {
  console.log('\nSome renames failed. Make sure no agents are running.');
  process.exit(1);
}

console.log('\nReady to start Hivemind!');
