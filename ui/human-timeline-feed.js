(function () {
  'use strict';

  function safeArray(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
  }

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  function itemNode(item, className) {
    const node = el('article', className || 'human-timeline-item');
    node.dataset.tone = item.tone || 'neutral';
    const meta = el('div', 'human-timeline-item-meta', item.timeLabel || '');
    const title = el('h3', '', item.title || 'Team update');
    const detail = el('p', '', item.detail || '');
    node.appendChild(meta);
    node.appendChild(title);
    node.appendChild(detail);
    return node;
  }

  function emptyState(title, detail) {
    const node = el('div', 'human-timeline-empty');
    node.appendChild(el('strong', '', title));
    node.appendChild(el('span', '', detail));
    return node;
  }

  function setText(root, selector, value) {
    const node = root.querySelector(selector);
    if (node) node.textContent = value;
  }

  function renderHumanTimelineFeed(root, snapshot = {}) {
    if (!root) return;
    const feedItems = safeArray(snapshot.feed && snapshot.feed.items);
    const needItems = safeArray(snapshot.needsYou && snapshot.needsYou.items);
    setText(root, '[data-human-timeline-window]', snapshot.window?.label || 'Today');
    setText(root, '[data-human-timeline-updated]', snapshot.generatedAt ? `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}` : 'Not loaded');
    setText(root, '[data-human-timeline-feed-count]', String(feedItems.length));
    setText(root, '[data-human-timeline-need-count]', String(needItems.length));
    const overflowCount = Number(snapshot.needsYou && snapshot.needsYou.overflowCount) || 0;
    const excludedLabel = snapshot.footer && snapshot.footer.excludedForeignLabel
      ? snapshot.footer.excludedForeignLabel
      : '';
    setText(root, '[data-human-timeline-need-overflow]', overflowCount > 0 ? `+${overflowCount} more` : '');
    setText(root, '[data-human-timeline-footer]', excludedLabel);

    const needsRoot = root.querySelector('[data-human-timeline-needs]');
    if (needsRoot) {
      needsRoot.replaceChildren();
      if (needItems.length) {
        needItems.forEach((item) => needsRoot.appendChild(itemNode(item, 'human-timeline-need')));
        if (overflowCount > 0) {
          needsRoot.appendChild(el('div', 'human-timeline-overflow', `+${overflowCount} more need your attention.`));
        }
      } else {
        needsRoot.appendChild(emptyState('Nothing needs you right now', 'The team has no open question waiting on you.'));
      }
    }

    const feedRoot = root.querySelector('[data-human-timeline-feed]');
    if (feedRoot) {
      feedRoot.replaceChildren();
      if (feedItems.length) {
        feedItems.forEach((item) => feedRoot.appendChild(itemNode(item, 'human-timeline-item')));
      } else {
        feedRoot.appendChild(emptyState('No team updates yet today', 'New work, answers, and decisions will appear here.'));
      }
    }
  }

  function createHumanTimelineFeed(root, options = {}) {
    const loadSnapshot = typeof options.loadSnapshot === 'function'
      ? options.loadSnapshot
      : async () => ({ feed: { items: [] }, needsYou: { items: [] } });
    const onError = typeof options.onError === 'function' ? options.onError : null;
    async function refresh() {
      try {
        const snapshot = await loadSnapshot();
        renderHumanTimelineFeed(root, snapshot || {});
        return snapshot;
      } catch (error) {
        if (onError) onError(error);
        renderHumanTimelineFeed(root, {
          generatedAt: new Date().toISOString(),
          feed: { items: [] },
          needsYou: {
            items: [{
              id: 'human-timeline-load-error',
              title: 'The feed could not load',
              detail: error?.message || 'The read-only snapshot was unavailable.',
              tone: 'warn',
            }],
          },
        });
        return null;
      }
    }
    return { refresh };
  }

  window.SquidRunHumanTimelineFeed = {
    createHumanTimelineFeed,
    renderHumanTimelineFeed,
  };
}());
