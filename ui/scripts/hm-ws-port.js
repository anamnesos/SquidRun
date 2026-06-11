#!/usr/bin/env node
'use strict';

const { resolveWebSocketPortInfo } = require('../config');

function normalizePort(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function resolveCliWebSocketPortInfo(options = {}) {
  const env = options.env || process.env;
  const explicit = normalizePort(options.port ?? env.HM_SEND_PORT);
  if (explicit) {
    return {
      port: explicit,
      source: Object.prototype.hasOwnProperty.call(options, 'port') ? 'option:port' : 'env:HM_SEND_PORT',
    };
  }
  return resolveWebSocketPortInfo({
    ...options,
    env,
    profileName: options.profileName || env.SQUIDRUN_PROFILE || 'main',
  });
}

function resolveCliWebSocketPort(options = {}) {
  return resolveCliWebSocketPortInfo(options).port;
}

module.exports = {
  normalizePort,
  resolveCliWebSocketPort,
  resolveCliWebSocketPortInfo,
};
