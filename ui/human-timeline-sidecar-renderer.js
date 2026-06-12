(function () {
  'use strict';

  const SNAPSHOT_CHANNEL = 'human-timeline:snapshot';
  const REFRESH_MS = 5000;
  let timer = null;
  let feed = null;

  function getBridgeApi() {
    return window.squidrunAPI || window.squidrun || {};
  }

  function bridgeInvoke(channel, payload) {
    const api = getBridgeApi();
    const invoke = typeof api.invoke === 'function'
      ? api.invoke.bind(api)
      : (api.ipc && typeof api.ipc.invoke === 'function' ? api.ipc.invoke.bind(api.ipc) : null);
    if (!invoke) return Promise.resolve({ ok: false, reason: 'bridge_unavailable' });
    return invoke(channel, payload);
  }

  async function loadSnapshot() {
    const result = await bridgeInvoke(SNAPSHOT_CHANNEL, {});
    if (result && result.ok === false && result.reason) {
      throw new Error(result.reason);
    }
    return result;
  }

  function init() {
    const root = document.getElementById('humanTimelineRoot');
    const module = window.SquidRunHumanTimelineFeed;
    if (!root || !module || typeof module.createHumanTimelineFeed !== 'function') return;
    feed = module.createHumanTimelineFeed(root, { loadSnapshot });
    document.getElementById('humanTimelineRefresh')?.addEventListener('click', () => {
      feed.refresh();
    });
    feed.refresh();
    timer = setInterval(() => feed.refresh(), REFRESH_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  window.addEventListener('beforeunload', () => {
    if (timer) clearInterval(timer);
  });
  window.addEventListener('DOMContentLoaded', init);
}());
