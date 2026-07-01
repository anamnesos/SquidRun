#!/usr/bin/env node
'use strict';

const path = require('path');

const {
  buildFableBuilderReplayPacket,
  writeReplayJobPacket,
} = require('../modules/main/model-replay-job-packet');

function setOption(options, key, value) {
  if (Object.prototype.hasOwnProperty.call(options, key)) {
    if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = [options[key], value];
  } else {
    options[key] = value;
  }
}

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) continue;
    const eqIndex = token.indexOf('=');
    if (eqIndex > 2) {
      setOption(options, token.slice(2, eqIndex), token.slice(eqIndex + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith('--')) {
      setOption(options, key, true);
      continue;
    }
    setOption(options, key, next);
    index += 1;
  }
  return options;
}

function option(options, key, fallback = null) {
  const value = options[key];
  if (Array.isArray(value)) return value[value.length - 1];
  if (value === undefined || value === true) return fallback;
  return value;
}

function usage() {
  return {
    ok: true,
    usage: [
      'node ui/scripts/hm-model-replay-job-packet.js [--project-root <path>] [--output <json>] [--created-at <date>] [--print-packet]',
    ],
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || options.h) {
    console.log(JSON.stringify(usage(), null, 2));
    return 0;
  }

  const projectRoot = path.resolve(option(options, 'project-root', process.cwd()));
  const packet = buildFableBuilderReplayPacket({
    projectRoot,
    createdAt: option(options, 'created-at', undefined),
    packetId: option(options, 'packet-id', undefined),
  });
  const output = option(options, 'output', null);
  const written = output
    ? writeReplayJobPacket(packet, path.resolve(projectRoot, output))
    : null;
  const payload = {
    ok: packet.status === 'ready_to_run',
    status: packet.status,
    packetId: packet.packetId,
    packetHash: packet.packetHash,
    readinessBlockers: packet.readinessBlockers,
    outputPath: written ? written.path : null,
    outputSha256: written ? written.sha256 : null,
    printPacket: Boolean(options['print-packet']),
    packet: options['print-packet'] ? packet : undefined,
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      reason: error.message || String(error),
    }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
};
