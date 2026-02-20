/**
 * Screenshots Module
 */

const log = require('../logger');

const MAX_RENDERED_SCREENSHOTS = 80;

// Track DOM listener cleanup functions
let domCleanupFns = [];
let screenshotPathByName = new Map();

function renderEmptyState(listEl) {
  if (!listEl) return;
  listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
}

function hasScreenshotItems(listEl) {
  return Boolean(listEl && listEl.querySelector('.screenshot-item'));
}

function toFileUrl(filePath) {
  if (!filePath) return '';
  const normalized = String(filePath).replace(/\\/g, '/');
  return `file://${encodeURI(normalized)}`;
}

function createScreenshotItem({ name, path, sizeBytes = 0 }) {
  const item = document.createElement('div');
  item.className = 'screenshot-item';
  item.dataset.filename = name;
  item.dataset.path = path || '';

  const thumb = document.createElement('img');
  thumb.className = 'screenshot-thumb';
  thumb.src = toFileUrl(path);
  thumb.alt = String(name);
  thumb.loading = 'lazy';
  thumb.decoding = 'async';
  thumb.referrerPolicy = 'no-referrer';

  const info = document.createElement('div');
  info.className = 'screenshot-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'screenshot-name';
  nameEl.title = path || '';
  nameEl.textContent = String(name);

  const sizeEl = document.createElement('div');
  sizeEl.className = 'screenshot-size';
  sizeEl.textContent = `${(Math.max(0, Number(sizeBytes) || 0) / 1024).toFixed(1)} KB`;

  info.appendChild(nameEl);
  info.appendChild(sizeEl);

  const actions = document.createElement('div');
  actions.className = 'screenshot-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'screenshot-btn copy-btn';
  copyBtn.dataset.action = 'copy';
  copyBtn.title = 'Copy path';
  copyBtn.textContent = 'Copy';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'screenshot-btn delete-btn';
  deleteBtn.dataset.action = 'delete';
  deleteBtn.title = 'Delete';
  deleteBtn.textContent = 'Delete';

  actions.appendChild(copyBtn);
  actions.appendChild(deleteBtn);

  item.appendChild(thumb);
  item.appendChild(info);
  item.appendChild(actions);
  return item;
}

function pruneRenderedScreenshots(listEl, maxItems = MAX_RENDERED_SCREENSHOTS) {
  if (!listEl) return;
  const items = listEl.querySelectorAll('.screenshot-item');
  if (items.length <= maxItems) return;
  for (let i = maxItems; i < items.length; i += 1) {
    const img = items[i].querySelector('img.screenshot-thumb');
    if (img) {
      img.src = '';
    }
    items[i].remove();
  }
}

function appendScreenshotItem(listEl, screenshot) {
  if (!listEl || !screenshot?.name || !screenshot?.path) return;
  const emptyMsg = listEl.querySelector('.screenshot-empty');
  if (emptyMsg) emptyMsg.remove();

  // Replace existing node if filename already exists.
  const existing = Array.from(listEl.querySelectorAll('.screenshot-item'))
    .find((node) => node.dataset.filename === screenshot.name);
  if (existing) {
    const existingImg = existing.querySelector('img.screenshot-thumb');
    if (existingImg) existingImg.src = '';
    existing.remove();
  }

  const item = createScreenshotItem({
    name: screenshot.name,
    path: screenshot.path,
    sizeBytes: screenshot.size || screenshot.sizeBytes || 0,
  });

  // Newest first so cap removes oldest from the bottom.
  listEl.prepend(item);
  screenshotPathByName.set(screenshot.name, screenshot.path);
  pruneRenderedScreenshots(listEl);
}

async function handleScreenshotDrop(files, updateStatusFn) {
  const listEl = document.getElementById('screenshotList');
  if (!listEl) return;

  for (const file of files) {
    if (!file || !file.type || !file.type.startsWith('image/')) continue;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const base64Data = e?.target?.result;
        if (!base64Data) return;

        const result = await window.squidrun.screenshot.save(base64Data, file.name);
        if (!result?.success) {
          if (updateStatusFn) updateStatusFn(`Failed to save ${file.name}: ${result?.error || 'Unknown error'}`);
          return;
        }

        appendScreenshotItem(listEl, {
          name: result.filename,
          path: result.path,
          size: file.size,
        });
      } finally {
        // Release large base64 payload references ASAP.
        reader.onload = null;
      }
    };
    reader.readAsDataURL(file);
  }
}

async function loadScreenshots(updateStatusFn) {
  const listEl = document.getElementById('screenshotList');
  if (!listEl) return;

  try {
    const result = await window.squidrun.screenshot.list({ limit: MAX_RENDERED_SCREENSHOTS });
    if (!result?.success) return;

    screenshotPathByName = new Map();
    if (!Array.isArray(result.files) || result.files.length === 0) {
      renderEmptyState(listEl);
      return;
    }

    listEl.innerHTML = '';
    for (const file of result.files.slice(0, MAX_RENDERED_SCREENSHOTS)) {
      screenshotPathByName.set(file.name, file.path);
      listEl.appendChild(createScreenshotItem({
        name: file.name,
        path: file.path,
        sizeBytes: file.size,
      }));
    }
  } catch (err) {
    log.error('Screenshots', 'Error loading screenshots', err);
    if (updateStatusFn) updateStatusFn(`Failed to load screenshots: ${err.message}`);
  }
}

function setupListDelegation(updateStatusFn) {
  const listEl = document.getElementById('screenshotList');
  if (!listEl) return;

  const clickHandler = async (event) => {
    const actionBtn = event.target?.closest?.('button[data-action]');
    const thumb = event.target?.closest?.('.screenshot-thumb');

    if (thumb) {
      const item = thumb.closest('.screenshot-item');
      if (!item) return;
      event.stopPropagation();
      const isExpanded = thumb.classList.toggle('expanded');
      item.classList.toggle('has-expanded-thumb', isExpanded);
      return;
    }

    if (!actionBtn) return;
    const item = actionBtn.closest('.screenshot-item');
    if (!item) return;

    const filename = item.dataset.filename || '';
    const path = item.dataset.path || screenshotPathByName.get(filename) || '';
    const action = actionBtn.dataset.action;

    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(path);
        if (updateStatusFn) updateStatusFn(`Copied path: ${path}`);
      } catch (err) {
        if (updateStatusFn) updateStatusFn('Failed to copy screenshot path');
      }
      return;
    }

    if (action === 'delete') {
      const delResult = await window.squidrun.screenshot.delete(filename);
      if (delResult?.success) {
        const img = item.querySelector('img.screenshot-thumb');
        if (img) img.src = '';
        item.remove();
        screenshotPathByName.delete(filename);
        if (!hasScreenshotItems(listEl)) {
          renderEmptyState(listEl);
        }
        if (updateStatusFn) updateStatusFn(`Deleted ${filename}`);
      } else if (updateStatusFn) {
        updateStatusFn(`Failed to delete ${filename}: ${delResult?.error || 'Unknown error'}`);
      }
    }
  };

  listEl.addEventListener('click', clickHandler);
  domCleanupFns.push(() => listEl.removeEventListener('click', clickHandler));
}

function setupScreenshots(updateStatusFn) {
  // Clean up previous listeners before re-init
  destroyScreenshots();

  const dropzone = document.getElementById('screenshotDropzone');
  if (dropzone) {
    const dragoverHandler = (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    };
    const dragleaveHandler = () => {
      dropzone.classList.remove('dragover');
    };
    const dropHandler = (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      handleScreenshotDrop(e.dataTransfer.files, updateStatusFn);
    };
    const clickHandler = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = () => handleScreenshotDrop(input.files, updateStatusFn);
      input.click();
    };

    dropzone.addEventListener('dragover', dragoverHandler);
    dropzone.addEventListener('dragleave', dragleaveHandler);
    dropzone.addEventListener('drop', dropHandler);
    dropzone.addEventListener('click', clickHandler);

    domCleanupFns.push(
      () => dropzone.removeEventListener('dragover', dragoverHandler),
      () => dropzone.removeEventListener('dragleave', dragleaveHandler),
      () => dropzone.removeEventListener('drop', dropHandler),
      () => dropzone.removeEventListener('click', clickHandler),
    );
  }

  const pasteHandler = (e) => {
    const items = e?.clipboardData?.items || [];
    const files = [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) files.push(item.getAsFile());
    }
    if (files.length > 0) handleScreenshotDrop(files, updateStatusFn);
  };
  document.addEventListener('paste', pasteHandler);
  domCleanupFns.push(() => document.removeEventListener('paste', pasteHandler));

  setupListDelegation(updateStatusFn);
  loadScreenshots(updateStatusFn);
}

function destroyScreenshots() {
  for (const fn of domCleanupFns) {
    try {
      fn();
    } catch (_) {}
  }
  domCleanupFns = [];
  screenshotPathByName.clear();
}

module.exports = {
  setupScreenshots,
  destroyScreenshots,
  loadScreenshots,
};
