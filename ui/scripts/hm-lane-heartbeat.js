#!/usr/bin/env node
'use strict';

/**
 * hm-lane-heartbeat.js — the engine James remembered.
 *
 * Generalizes the wake machinery that once ran 24-hour days (but only ever
 * covered oracle/architect) to EVERY mind with open lane work: an OPEN lane
 * whose owner has been silent past the idle threshold gets a continuation
 * prompt, automatically, until the lane is closed or honestly blocked.
 * Turn-based minds idle between pokes; this is the poker, mechanized.
 *
 * Idle signal (v0, deliberately simple): the owner's last outbound message
 * in the comms ledger. A redundant poke to a mid-turn pane is harmless by
 * design — the prompt says so, and transport v1.1 delivers it as a queued
 * turn. Escalation: MAX_POKES without owner activity => lane marked
 * 'stalled' and the architect pane is told, once.
 *
 *   node ui/scripts/hm-lane-heartbeat.js run [--interval-s 120] [--idle-min 8]
 *   node ui/scripts/hm-lane-heartbeat.js once     (single cycle, for tests)
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { readLanes, writeLanes } = require('./hm-lane');

const SCRIPTS_DIR = __dirname;
const IDLE_MIN_DEFAULT = 8;
const INTERVAL_S_DEFAULT = 120;
const POKE_COOLDOWN_MIN = 7;
const MAX_POKES_BEFORE_STALL = 3;

/** Pure: newest outbound timestampMs per role from hm-comms --json rows. */
function lastOutboundFromRows(rows, roles) {
  const last = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const sender = row && row.sender;
    const ms = row && Number(row.timestampMs);
    if (!sender || !roles.includes(sender) || !Number.isFinite(ms)) continue;
    if (!last[sender] || ms > last[sender]) last[sender] = ms;
  }
  return last;
}

function readLedgerLastOutboundMs(roles) {
  // --json is the seam contract (CommsJournalJsonRow); the rendered text
  // format is display-only and must never be parsed (S468 doctrine:
  // never regex another process's human-facing output).
  const out = execFileSync(process.execPath, [
    path.join(SCRIPTS_DIR, 'hm-comms.js'), 'history', '--limit', '120', '--json',
  ], { encoding: 'utf8', timeout: 30000 });
  return lastOutboundFromRows(JSON.parse(out).rows, roles);
}

/** Pure decision core — contract-tested. */
function decidePokes(lanes, lastOutboundMsByOwner, nowMs, {
  idleMs = IDLE_MIN_DEFAULT * 60000,
  cooldownMs = POKE_COOLDOWN_MIN * 60000,
  maxPokes = MAX_POKES_BEFORE_STALL,
} = {}) {
  const pokes = [];
  const stalls = [];
  for (const lane of Object.values(lanes)) {
    if (lane.status !== 'open') continue;
    const lastSeen = Math.max(lastOutboundMsByOwner[lane.owner] || 0, lane.openedAtMs || 0);
    const idleFor = nowMs - lastSeen;
    if (idleFor < idleMs) {
      // owner active since last poke — reset the escalation counter
      if (lane.pokes > 0 && lastSeen > (lane.lastPokeAtMs || 0)) lane.pokes = 0;
      continue;
    }
    if (nowMs - (lane.lastPokeAtMs || 0) < cooldownMs) continue;
    if (lane.pokes >= maxPokes) {
      if (lane.status !== 'stalled') stalls.push(lane);
      continue;
    }
    pokes.push(lane);
  }
  return { pokes, stalls };
}

function sendToOwner(owner, message) {
  execFileSync(process.execPath, [
    path.join(SCRIPTS_DIR, 'hm-send.js'), owner, message, '--role', 'architect',
  ], { encoding: 'utf8', timeout: 60000 });
}

function cycle(nowMs = Date.now(), { dryRun = false } = {}) {
  const state = readLanes();
  const owners = [...new Set(Object.values(state.lanes).map((lane) => lane.owner))];
  if (!owners.length) return { pokes: [], stalls: [] };
  const lastOutbound = readLedgerLastOutboundMs(owners);
  const { pokes, stalls } = decidePokes(state.lanes, lastOutbound, nowMs);

  for (const lane of pokes) {
    const idleMin = Math.round((nowMs - Math.max(lastOutbound[lane.owner] || 0, lane.openedAtMs)) / 60000);
    if (!dryRun) {
      sendToOwner(lane.owner,
        `(LANE HEARTBEAT ${lane.pokes + 1}/${MAX_POKES_BEFORE_STALL}) Lane '${lane.id}' is OPEN and you look idle ~${idleMin}m. `
        + `Objective: ${lane.objective}. CONTINUE to done or blocked — when finished: node ui/scripts/hm-lane.js close ${lane.id} `
        + `--reason "<what shipped>"; if stuck: node ui/scripts/hm-lane.js block ${lane.id} --reason "<blocker>". `
        + `If you are mid-work right now, ignore this and keep going.`);
    }
    lane.pokes += 1;
    lane.lastPokeAtMs = nowMs;
    lane.updatedAtMs = nowMs;
  }
  for (const lane of stalls) {
    lane.status = 'stalled';
    lane.updatedAtMs = nowMs;
    if (!dryRun) {
      sendToOwner('architect',
        `(LANE HEARTBEAT — STALL) Lane '${lane.id}' [${lane.owner}] hit ${MAX_POKES_BEFORE_STALL} pokes with no owner activity. `
        + `Objective: ${lane.objective}. Needs a human-grade look: restart the pane, reassign, or close honestly.`);
    }
  }
  if (pokes.length || stalls.length) writeLanes(state);
  return { pokes: pokes.map((l) => l.id), stalls: stalls.map((l) => l.id) };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = rest.indexOf(name);
    return i >= 0 ? Number(rest[i + 1]) : dflt;
  };
  if (cmd === 'once') {
    const result = cycle();
    console.log(JSON.stringify(result));
    return;
  }
  if (cmd === 'run') {
    const intervalS = arg('--interval-s', INTERVAL_S_DEFAULT);
    console.log(`lane heartbeat running: interval ${intervalS}s, idle ${arg('--idle-min', IDLE_MIN_DEFAULT)}m`);
    const tick = () => {
      try {
        const result = cycle();
        if (result.pokes.length || result.stalls.length) {
          console.log(`${new Date().toISOString()} pokes=[${result.pokes}] stalls=[${result.stalls}]`);
        }
      } catch (err) {
        console.error(`${new Date().toISOString()} cycle error: ${err.message}`);
      }
    };
    tick();
    setInterval(tick, intervalS * 1000);
    return;
  }
  console.log('usage: hm-lane-heartbeat.js run [--interval-s N] [--idle-min N] | once');
}

if (require.main === module) main();

module.exports = { decidePokes, cycle, lastOutboundFromRows };
