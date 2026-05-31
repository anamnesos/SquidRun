#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const {
  SNAPSHOT_SCHEMA,
  buildLiveTaskAuditSnapshot,
} = require('../modules/main/live-task-audit-sidecar');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env.HM_TASK_AUDIT_PREVIEW_PORT || '8787', 10);
const UI_ROOT = path.join(__dirname, '..');
const PREVIEW_ROUTE = '/task-audit-preview';
const SNAPSHOT_ROUTE = '/snapshot.json';

const ASSET_ROUTES = Object.freeze({
  '/': 'live-task-audit-preview.html',
  [PREVIEW_ROUTE]: 'live-task-audit-preview.html',
  '/live-task-audit-sidecar-renderer.js': 'live-task-audit-sidecar-renderer.js',
  '/styles/live-task-audit-sidecar.css': 'styles/live-task-audit-sidecar.css',
});

function setOption(options, key, value) {
  options[key] = value;
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
    const value = (!next || String(next).startsWith('--')) ? true : next;
    setOption(options, key, value);
    if (value !== true) index += 1;
  }
  return options;
}

function asNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, contents) => {
    if (err) {
      sendJson(res, err.code === 'ENOENT' ? 404 : 500, {
        ok: false,
        reason: err.code === 'ENOENT' ? 'preview_asset_not_found' : 'preview_asset_read_failed',
      });
      return;
    }
    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': 'no-store',
    });
    res.end(contents);
  });
}

function resolveAssetPath(routePath) {
  const relative = ASSET_ROUTES[routePath];
  if (!relative) return null;
  return path.join(UI_ROOT, relative);
}

function createLiveTaskAuditPreviewServer(options = {}) {
  const snapshotOptions = options.snapshotOptions || {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, {
        ok: false,
        reason: 'read_only_preview_get_head_only',
        allowedMethods: ['GET', 'HEAD'],
      });
      return;
    }
    if (url.pathname === '/health.json') {
      sendJson(res, 200, {
        ok: true,
        preview: true,
        readOnly: true,
        route: PREVIEW_ROUTE,
        snapshotRoute: SNAPSHOT_ROUTE,
        snapshotSchema: SNAPSHOT_SCHEMA,
      });
      return;
    }
    if (url.pathname === SNAPSHOT_ROUTE) {
      sendJson(res, 200, buildLiveTaskAuditSnapshot(snapshotOptions));
      return;
    }
    const assetPath = resolveAssetPath(url.pathname);
    if (!assetPath) {
      sendJson(res, 404, { ok: false, reason: 'preview_route_not_found' });
      return;
    }
    sendFile(res, assetPath);
  });
  return { server, host: options.host || DEFAULT_HOST, port: asNumber(options.port, DEFAULT_PORT) };
}

function serverUrls(host, port) {
  const origin = `http://${host}:${port}`;
  return {
    origin,
    url: `${origin}${PREVIEW_ROUTE}`,
    snapshotUrl: `${origin}${SNAPSHOT_ROUTE}`,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node ui/scripts/hm-live-task-audit-preview.js [--host 127.0.0.1] [--port 8787]',
      route: PREVIEW_ROUTE,
      snapshotRoute: SNAPSHOT_ROUTE,
    }, null, 2));
    return 0;
  }
  const host = String(args.host || DEFAULT_HOST);
  const port = asNumber(args.port, DEFAULT_PORT);
  const preview = createLiveTaskAuditPreviewServer({ host, port });
  preview.server.listen(port, host, () => {
    const address = preview.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(JSON.stringify({
      ok: true,
      preview: true,
      readOnly: true,
      label: 'PREVIEW / not final Electron sidecar window',
      pid: process.pid,
      ...serverUrls(host, actualPort),
      snapshotSchema: SNAPSHOT_SCHEMA,
    }, null, 2));
  });
  preview.server.on('error', (err) => {
    console.error(JSON.stringify({ ok: false, reason: err.message || String(err), code: err.code || null }, null, 2));
    process.exitCode = 1;
  });
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PREVIEW_ROUTE,
  SNAPSHOT_ROUTE,
  createLiveTaskAuditPreviewServer,
  parseArgs,
  resolveAssetPath,
  serverUrls,
};
