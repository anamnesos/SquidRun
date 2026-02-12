/**
 * Oracle Image Generation Module
 * AI-powered image generation (Recraft V3 / OpenAI gpt-image-1)
 * Gallery view: shows all generated images, newest first
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { escapeHtml } = require('./utils');
const { registerScopedIpcListener } = require('../renderer-ipc-registry');

let imageGenAvailable = true; // optimistic default until capabilities load

/** Convert a Windows path to a proper file:/// URL */
function toFileUrl(filePath) {
  return 'file:///' + filePath.replace(/\\/g, '/');
}

/** Load and render all images from generated-images directory */
async function loadGallery() {
  const galleryList = document.getElementById('oracleGalleryList');
  if (!galleryList) return;

  try {
    const images = await ipcRenderer.invoke('oracle:listImages');
    if (!images || images.length === 0) {
      galleryList.innerHTML = '<div class="oracle-gallery-empty">No images yet</div>';
      return;
    }

    galleryList.innerHTML = images.map(img => {
      const name = escapeHtml(img.filename);
      // Use file:// URL (CSP allows file: protocol for images)
      const src = toFileUrl(img.path);
      return `
        <div class="oracle-gallery-item" data-path="${escapeHtml(img.path)}">
          <img class="oracle-gallery-img" src="${src}" alt="${name}" />
          <div class="oracle-gallery-overlay">
            <span class="oracle-gallery-name">${name}</span>
            <div class="oracle-gallery-actions">
              <button class="btn btn-sm oracle-gallery-copy" title="Copy to clipboard">Copy</button>
              <button class="btn btn-sm btn-danger oracle-gallery-delete" title="Delete image">Delete</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Attach event handlers
    galleryList.querySelectorAll('.oracle-gallery-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.oracle-gallery-item');
        const imagePath = item?.dataset.path;
        if (!imagePath) return;
        try {
          await ipcRenderer.invoke('oracle:deleteImage', imagePath);
          item.remove();
          // If gallery is now empty, show placeholder
          if (galleryList.children.length === 0) {
            galleryList.innerHTML = '<div class="oracle-gallery-empty">No images yet</div>';
          }
        } catch (err) {
          log.error('Oracle', 'Failed to delete image:', err);
        }
      });
    });

    galleryList.querySelectorAll('.oracle-gallery-copy').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.oracle-gallery-item');
        const img = item?.querySelector('.oracle-gallery-img');
        if (!img) return;
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          ctx.drawImage(img, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          if (blob) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
          }
        } catch (err) {
          log.error('Oracle', 'Copy to clipboard failed:', err);
        }
      });
    });
  } catch (err) {
    log.error('Oracle', 'Failed to load gallery:', err);
    galleryList.innerHTML = '<div class="oracle-gallery-empty">Failed to load images</div>';
  }
}

/** Update Generate button state based on image generation capability */
function applyImageGenCapability(generateBtn, capabilities) {
  if (!generateBtn) return;
  imageGenAvailable = !!capabilities.imageGenAvailable;

  // Update provider hint element (created once, reused)
  let hint = document.getElementById('oracleCapabilityHint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'oracleCapabilityHint';
    hint.className = 'oracle-capability-hint';
    generateBtn.parentNode.insertBefore(hint, generateBtn.nextSibling);
  }

  if (imageGenAvailable) {
    generateBtn.disabled = false;
    generateBtn.title = 'Generate image';
    const provider = capabilities.recraftAvailable ? 'Recraft' : 'OpenAI';
    hint.textContent = `Using ${provider}`;
    hint.classList.remove('oracle-capability-missing');
    hint.classList.add('oracle-capability-active');
  } else {
    generateBtn.disabled = true;
    generateBtn.title = 'Set a Recraft or OpenAI key in the Keys tab';
    hint.textContent = 'Set a Recraft or OpenAI key in the Keys tab';
    hint.classList.remove('oracle-capability-active');
    hint.classList.add('oracle-capability-missing');
  }
}

let domCleanupFns = [];

function setupOracleTab(updateStatusFn) {
  destroyOracleTab();

  const generateBtn = document.getElementById('oracleGenerateBtn');
  const promptInput = document.getElementById('oraclePromptInput');
  const styleSelect = document.getElementById('oracleStyleSelect');
  const sizeSelect = document.getElementById('oracleSizeSelect');
  const resultsEl = document.getElementById('oracleResults');

  // Fetch initial feature capabilities
  ipcRenderer.invoke('get-feature-capabilities').then(caps => {
    if (caps) applyImageGenCapability(generateBtn, caps);
  }).catch(() => {});

  // Listen for dynamic capability updates (e.g. keys added/removed)
  registerScopedIpcListener('tab-oracle', 'feature-capabilities-updated', (event, caps) => {
    if (caps) applyImageGenCapability(generateBtn, caps);
  });

  if (generateBtn) {
    const clickHandler = async () => {
      const prompt = promptInput?.value.trim();
      if (!prompt) {
        if (resultsEl) resultsEl.innerHTML = '<div class="oracle-error">Please enter a prompt</div>';
        return;
      }

      generateBtn.disabled = true;
      const originalText = generateBtn.innerHTML;
      generateBtn.textContent = 'Generating...';
      if (resultsEl) resultsEl.innerHTML = '<div class="oracle-loading">Generating image...</div>';

      try {
        const result = await ipcRenderer.invoke('oracle:generateImage', {
          prompt,
          style: styleSelect?.value || 'realistic_image',
          size: sizeSelect?.value || '1024x1024',
        });

        if (result.success) {
          if (resultsEl) resultsEl.innerHTML = '';
          if (updateStatusFn) updateStatusFn(`Image generated via ${result.provider}`);
          // Refresh gallery to show the new image at top
          await loadGallery();
        } else {
          if (resultsEl) resultsEl.innerHTML = `<div class="oracle-error">${escapeHtml(result.error)}</div>`;
        }
      } catch (err) {
        log.error('Oracle', 'Generation failed:', err);
        if (resultsEl) resultsEl.innerHTML = `<div class="oracle-error">Generation failed: ${escapeHtml(err.message)}</div>`;
      }

      generateBtn.disabled = !imageGenAvailable;
      generateBtn.innerHTML = originalText;
    };
    generateBtn.addEventListener('click', clickHandler);
    domCleanupFns.push(() => generateBtn.removeEventListener('click', clickHandler));
  }

  // Listen for agent-triggered image generation results pushed from main process
  registerScopedIpcListener('tab-oracle', 'oracle:image-generated', (event, data) => {
    if (!data || !data.imagePath) return;

    if (resultsEl) resultsEl.innerHTML = '';
    if (updateStatusFn) updateStatusFn(`Image generated via ${data.provider} (agent)`);
    // Refresh gallery to show the new image
    loadGallery();
  });

  // Load gallery on startup
  loadGallery();
}

function destroyOracleTab() {
  for (const fn of domCleanupFns) {
    try { fn(); } catch (_) {}
  }
  domCleanupFns = [];

  // Clear scoped IPC listeners
  const { clearScopedIpcListeners } = require('../renderer-ipc-registry');
  clearScopedIpcListeners('tab-oracle');
}

module.exports = {
  setupOracleTab,
  destroyOracleTab,
  applyImageGenCapability,
};
