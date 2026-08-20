'use strict';

const CACHE_NAME = 'squidrun-team-room-shell-v1';
const SHELL_PATHS = Object.freeze([
  '/',
  '/team-room.css',
  '/team-room.js',
  '/team-room.webmanifest',
  '/team-room-icon-192.png',
  '/team-room-icon-512.png',
  '/team-room-icon-180.png',
]);
const SHELL_SET = new Set(SHELL_PATHS);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then((cache) => cache.addAll(SHELL_PATHS))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names
      .filter((name) => name.startsWith('squidrun-team-room-shell-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !SHELL_SET.has(url.pathname)) return;
  event.respondWith(fetch(event.request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, copy));
      }
      return response;
    })
    .catch(async () => (await caches.match(url.pathname)) || caches.match('/')));
});
