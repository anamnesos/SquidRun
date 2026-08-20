'use strict';

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function verifyAppWindowVisible(options = {}) {
  const windowKey = String(options.rawWindowKey || 'main').trim() || 'main';
  const expectedTitle = String(options.expectedTitle || '');
  const windowRef = options.getAppWindow(windowKey);
  if (!options.canSendToWindow(windowRef)) {
    return { ok: false, windowKey, reason: `${windowKey}_window_not_registered` };
  }
  const visible = typeof windowRef.isVisible === 'function' ? windowRef.isVisible() : null;
  if (visible === false) {
    return { ok: false, windowKey, reason: `${windowKey}_window_not_visible`, visible };
  }
  const title = typeof windowRef.getTitle === 'function' ? text(windowRef.getTitle()) : null;
  if (expectedTitle && title && title.toLowerCase() !== expectedTitle.toLowerCase()) {
    return {
      ok: false,
      windowKey,
      reason: `${windowKey}_window_title_mismatch`,
      expectedTitle,
      title,
      visible,
    };
  }
  return { ok: true, windowKey, visible, title: title || expectedTitle || null };
}

module.exports = { verifyAppWindowVisible };
