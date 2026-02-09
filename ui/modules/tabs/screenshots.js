/**
 * Screenshots Module
 */

const log = require('../logger');

function attachExpandToggle(item) {
  const thumb = item.querySelector('.screenshot-thumb');
  if (!thumb) return;
  thumb.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = thumb.classList.toggle('expanded');
    item.classList.toggle('has-expanded-thumb', isExpanded);
  });
}

async function handleScreenshotDrop(files, updateStatusFn) {
  const listEl = document.getElementById('screenshotList');
  if (!listEl) return;

  const emptyMsg = listEl.querySelector('.screenshot-empty');
  if (emptyMsg) emptyMsg.remove();

  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Data = e.target.result;
      const result = await window.hivemind.screenshot.save(base64Data, file.name);
      if (!result.success) {
        if (updateStatusFn) updateStatusFn(`Failed to save ${file.name}: ${result.error}`);
        return;
      }

      const savedFilename = result.filename;
      const savedPath = result.path;

      const item = document.createElement('div');
      item.className = 'screenshot-item';
      item.dataset.filename = savedFilename;
      item.innerHTML = `
        <img class="screenshot-thumb" src="${base64Data}" alt="${savedFilename}">
        <div class="screenshot-info">
          <div class="screenshot-name" title="${savedPath}">${savedFilename}</div>
          <div class="screenshot-size">${(file.size / 1024).toFixed(1)} KB</div>
        </div>
        <div class="screenshot-actions">
          <button class="screenshot-btn copy-btn" title="Copy path">Copy</button>
          <button class="screenshot-btn delete-btn" title="Delete">X</button>
        </div>
      `;

      item.querySelector('.delete-btn').addEventListener('click', async () => {
        const delResult = await window.hivemind.screenshot.delete(savedFilename);
        if (delResult.success) {
          item.remove();
          if (listEl.children.length === 0) {
            listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
          }
          if (updateStatusFn) updateStatusFn(`Deleted ${savedFilename}`);
        } else {
          if (updateStatusFn) updateStatusFn(`Failed to delete ${savedFilename}: ${delResult.error || 'Unknown error'}`);
        }
      });

      item.querySelector('.copy-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(savedPath);
          if (updateStatusFn) updateStatusFn(`Copied path: ${savedPath}`);
        } catch (err) {}
      });

      attachExpandToggle(item);
      listEl.appendChild(item);
    };
    reader.readAsDataURL(file);
  }
}

async function loadScreenshots(updateStatusFn) {
  const listEl = document.getElementById('screenshotList');
  if (!listEl) return;

  try {
    const result = await window.hivemind.screenshot.list();
    if (!result.success) return;

    if (result.files.length === 0) {
      listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
      return;
    }

    listEl.innerHTML = '';
    for (const file of result.files) {
      const item = document.createElement('div');
      item.className = 'screenshot-item';
      item.dataset.filename = file.name;
      item.innerHTML = `
        <img class="screenshot-thumb" src="file://${file.path.replace(/\\/g, '/')}" alt="${file.name}">
        <div class="screenshot-info">
          <div class="screenshot-name" title="${file.path}">${file.name}</div>
          <div class="screenshot-size">${(file.size / 1024).toFixed(1)} KB</div>
        </div>
        <div class="screenshot-actions">
          <button class="screenshot-btn copy-btn" title="Copy path">Copy</button>
          <button class="screenshot-btn delete-btn" title="Delete">X</button>
        </div>
      `;

      const savedFilename = file.name;
      const savedPath = file.path;
      item.querySelector('.delete-btn').addEventListener('click', async () => {
        const delResult = await window.hivemind.screenshot.delete(savedFilename);
        if (delResult.success) {
          item.remove();
          if (listEl.children.length === 0) {
            listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
          }
          if (updateStatusFn) updateStatusFn(`Deleted ${savedFilename}`);
        } else {
          if (updateStatusFn) updateStatusFn(`Failed to delete ${savedFilename}: ${delResult.error || 'Unknown error'}`);
        }
      });

      item.querySelector('.copy-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(savedPath);
          if (updateStatusFn) updateStatusFn(`Copied path: ${savedPath}`);
        } catch (err) {}
      });

      attachExpandToggle(item);
      listEl.appendChild(item);
    }
  } catch (err) {
    log.error('Screenshots', 'Error loading screenshots', err);
  }
}

function setupScreenshots(updateStatusFn) {
  const dropzone = document.getElementById('screenshotDropzone');
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('dragover'); });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      handleScreenshotDrop(e.dataTransfer.files, updateStatusFn);
    });
    dropzone.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
      input.onchange = () => handleScreenshotDrop(input.files, updateStatusFn);
      input.click();
    });
  }

  document.addEventListener('paste', (e) => {
    const items = e.clipboardData.items;
    const files = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) files.push(item.getAsFile());
    }
    if (files.length > 0) handleScreenshotDrop(files, updateStatusFn);
  });

  loadScreenshots(updateStatusFn);
}

module.exports = {
  setupScreenshots,
  loadScreenshots
};
