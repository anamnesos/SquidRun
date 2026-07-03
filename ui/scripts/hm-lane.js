#!/usr/bin/env node
'use strict';

/**
 * hm-lane.js — lane registry: the source of truth for OPEN long-horizon work.
 *
 * James (S467): agents idle out between pokes while their work sits open;
 * every long job has secretly been a human poking per step. A lane is a
 * declared piece of long-horizon work with an OWNER; the lane heartbeat
 * (hm-lane-heartbeat.js) re-invokes idle owners until the lane is closed
 * or honestly blocked. Opening a lane is a promise; closing it is a claim.
 *
 * Usage:
 *   node ui/scripts/hm-lane.js open <id> --owner <role> --objective "<text>"
 *   node ui/scripts/hm-lane.js close <id> [--reason "<text>"]
 *   node ui/scripts/hm-lane.js block <id> --reason "<text>"
 *   node ui/scripts/hm-lane.js reopen <id>
 *   node ui/scripts/hm-lane.js list [--json]
 */

const fs = require('fs');
const path = require('path');

const LANES_PATH = path.join(__dirname, '..', '..', '.squidrun', 'runtime', 'lanes.json');

function readLanes(lanesPath = LANES_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lanesPath, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.lanes ? parsed : { version: 1, lanes: {} };
  } catch (_) {
    return { version: 1, lanes: {} };
  }
}

function writeLanes(state, lanesPath = LANES_PATH) {
  fs.mkdirSync(path.dirname(lanesPath), { recursive: true });
  const tmp = `${lanesPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, lanesPath);
}

function applyLaneCommand(state, cmd, id, opts = {}, nowMs = Date.now()) {
  const lanes = state.lanes;
  if (cmd === 'open') {
    if (!opts.owner || !opts.objective) throw new Error('open requires --owner and --objective');
    lanes[id] = {
      id,
      owner: String(opts.owner),
      objective: String(opts.objective),
      status: 'open',
      openedAtMs: nowMs,
      updatedAtMs: nowMs,
      pokes: 0,
      lastPokeAtMs: 0,
      reason: null,
    };
    return lanes[id];
  }
  const lane = lanes[id];
  if (!lane) throw new Error(`unknown lane: ${id}`);
  if (cmd === 'close') {
    lane.status = 'done';
    lane.reason = opts.reason ? String(opts.reason) : null;
  } else if (cmd === 'block') {
    if (!opts.reason) throw new Error('block requires --reason (honest blockers have names)');
    lane.status = 'blocked';
    lane.reason = String(opts.reason);
  } else if (cmd === 'reopen') {
    lane.status = 'open';
    lane.reason = null;
    lane.pokes = 0;
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
  lane.updatedAtMs = nowMs;
  return lane;
}

function parseArgs(argv) {
  const [cmd, id] = argv;
  const opts = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--owner') opts.owner = argv[++i];
    else if (argv[i] === '--objective') opts.objective = argv[++i];
    else if (argv[i] === '--reason') opts.reason = argv[++i];
    else if (argv[i] === '--json') opts.json = true;
  }
  return { cmd, id, opts };
}

function main() {
  const { cmd, id, opts } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'list') {
    const state = readLanes();
    const lanes = Object.values(state.lanes);
    if (opts.json) {
      console.log(JSON.stringify(lanes, null, 1));
      return;
    }
    if (!lanes.length) { console.log('no lanes'); return; }
    for (const lane of lanes) {
      const age = Math.round((Date.now() - lane.updatedAtMs) / 60000);
      console.log(`${lane.status.toUpperCase().padEnd(8)} ${lane.id} [${lane.owner}] ${age}m since update, pokes=${lane.pokes} :: ${lane.objective}${lane.reason ? ` (${lane.reason})` : ''}`);
    }
    return;
  }
  if (!id) throw new Error('lane id required');
  const state = readLanes();
  const lane = applyLaneCommand(state, cmd, id, opts);
  writeLanes(state);
  console.log(`${cmd} ${lane.id}: ${lane.status}${lane.reason ? ` (${lane.reason})` : ''}`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(`hm-lane: ${err.message}`); process.exit(1); }
}

module.exports = { readLanes, writeLanes, applyLaneCommand, LANES_PATH };
