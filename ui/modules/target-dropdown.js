/**
 * Hivemind Target Dropdown - Custom dropdown with pane preview on hover
 * Extracted from renderer.js for modularization
 */

const log = require('./logger');

/**
 * Initializes the custom target dropdown
 * Replaces native select with interactive dropdown that highlights target pane
 */
function initCustomTargetDropdown() {
  const nativeSelect = document.getElementById('commandTarget');
  if (!nativeSelect) return;

  // Hide native select
  nativeSelect.style.display = 'none';

  // Create custom dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'custom-target-dropdown';
  dropdown.innerHTML = `
    <button type="button" class="custom-target-button" id="customTargetBtn">
      <span class="selected-text">Architect</span>
      <span class="arrow">▼</span>
    </button>
    <div class="custom-target-list" id="customTargetList"></div>
  `;

  // Insert after native select
  nativeSelect.parentNode.insertBefore(dropdown, nativeSelect.nextSibling);

  const button = dropdown.querySelector('.custom-target-button');
  const list = dropdown.querySelector('.custom-target-list');
  const selectedText = dropdown.querySelector('.selected-text');

  // Build options from native select
  const options = [
    { value: '1', label: 'Architect', pane: '1' },
    { value: 'all', label: 'All Agents', pane: 'all' },
    { value: '2', label: 'Infra', pane: '2' },
    { value: '3', label: 'Frontend', pane: '3' },
    { value: '4', label: 'Backend', pane: '4' },
    { value: '5', label: 'Analyst', pane: '5' },
    { value: '6', label: 'Reviewer', pane: '6' },
  ];

  options.forEach(opt => {
    const option = document.createElement('div');
    option.className = 'custom-target-option' + (opt.value === nativeSelect.value ? ' selected' : '');
    option.dataset.value = opt.value;
    option.dataset.pane = opt.pane;
    option.innerHTML = `
      <span class="pane-number">${opt.pane === 'all' ? '★' : opt.pane}</span>
      <span class="option-label">${opt.label}</span>
    `;
    list.appendChild(option);

    // Hover: highlight target pane(s)
    option.addEventListener('mouseenter', () => {
      clearPaneHighlights();
      if (opt.pane === 'all') {
        // Highlight all panes
        document.querySelectorAll('.pane').forEach(pane => {
          pane.classList.add('preview-highlight');
        });
      } else {
        // Highlight single pane
        const pane = document.querySelector(`.pane[data-pane-id="${opt.pane}"]`);
        if (pane) pane.classList.add('preview-highlight');
      }
    });

    option.addEventListener('mouseleave', () => {
      // Don't clear immediately - let the list mouseleave handle it
    });

    // Click: select option
    option.addEventListener('click', () => {
      // Update native select
      nativeSelect.value = opt.value;
      nativeSelect.dispatchEvent(new Event('change'));

      // Update visual state
      list.querySelectorAll('.custom-target-option').forEach(o => o.classList.remove('selected'));
      option.classList.add('selected');
      selectedText.textContent = opt.label;

      // Close dropdown
      dropdown.classList.remove('open');
      clearPaneHighlights();
    });
  });

  // Toggle dropdown
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
      clearPaneHighlights();
    }
  });

  // Clear highlights when mouse leaves dropdown list
  list.addEventListener('mouseleave', () => {
    clearPaneHighlights();
  });

  // Keyboard navigation
  button.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dropdown.classList.toggle('open');
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      clearPaneHighlights();
    }
  });

  function clearPaneHighlights() {
    document.querySelectorAll('.pane.preview-highlight').forEach(pane => {
      pane.classList.remove('preview-highlight');
    });
  }

  log.info('UI', 'Custom target dropdown initialized with pane preview');
}

module.exports = {
  initCustomTargetDropdown,
};
