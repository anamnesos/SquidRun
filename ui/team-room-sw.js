'use strict';

const CACHE_NAME = 'squidrun-team-room-shell-v2';
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

function safePushPayload(event) {
  try {
    const value = event.data?.json();
    if (value?.schema !== 'squidrun.team_room_push.v1') return null;
    const sender = ['Mira', 'Rook', 'Vera'].includes(value.sender) ? value.sender : 'Team Room';
    const notificationClass = ['failure', 'needs_james', 'question'].includes(value.notificationClass)
      ? value.notificationClass
      : '';
    if (!notificationClass) return null;
    const body = ({
      failure: 'A failure needs your attention.',
      needs_james: 'A decision needs you.',
      question: 'There is a real question for you.',
    })[notificationClass];
    return {
      title: `${sender} · Team Room`,
      body,
      messageId: String(value.messageId || ''),
      notificationClass,
      url: '/',
    };
  } catch {
    return null;
  }
}

self.addEventListener('push', (event) => {
  const payload = safePushPayload(event);
  if (!payload) return;
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/team-room-icon-192.png',
    badge: '/team-room-icon-192.png',
    tag: payload.messageId ? `team-room-${payload.messageId}` : 'team-room',
    renotify: false,
    data: {
      messageId: payload.messageId,
      notificationClass: payload.notificationClass,
      url: payload.url,
    },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(async (clients) => {
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        return existing.navigate?.('/');
      }
      return self.clients.openWindow('/');
    }));
});
