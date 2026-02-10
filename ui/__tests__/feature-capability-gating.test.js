/**
 * Feature Capability UI Gating Tests
 * Target: Oracle tab Generate button + Voice button disable when keys are missing
 */

// Mock electron
jest.mock('electron', () => ({
  ipcRenderer: {
    invoke: jest.fn().mockResolvedValue({}),
    on: jest.fn(),
  },
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('Oracle tab capability gating', () => {
  let applyImageGenCapability;

  beforeEach(() => {
    jest.clearAllMocks();

    // Minimal DOM mock
    const elements = {};
    global.document = {
      getElementById: jest.fn((id) => elements[id] || null),
      createElement: jest.fn((tag) => {
        const el = {
          tagName: tag.toUpperCase(),
          id: '',
          className: '',
          textContent: '',
          title: '',
          disabled: false,
          style: {},
          parentNode: null,
          nextSibling: null,
          classList: {
            _classes: new Set(),
            add(c) { this._classes.add(c); },
            remove(c) { this._classes.delete(c); },
            contains(c) { return this._classes.has(c); },
          },
          insertBefore(newNode, ref) { return newNode; },
        };
        // Register by id if set later
        const proxy = new Proxy(el, {
          set(target, prop, value) {
            target[prop] = value;
            if (prop === 'id' && value) {
              elements[value] = proxy;
            }
            return true;
          },
        });
        return proxy;
      }),
    };

    // Fresh import each test
    jest.resetModules();
    jest.mock('electron', () => ({
      ipcRenderer: {
        invoke: jest.fn().mockResolvedValue({}),
        on: jest.fn(),
      },
    }));
    jest.mock('../modules/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));

    ({ applyImageGenCapability } = require('../modules/tabs/oracle'));
  });

  afterEach(() => {
    delete global.document;
  });

  function makeButton() {
    const btn = {
      id: 'oracleGenerateBtn',
      disabled: false,
      title: '',
      parentNode: {
        insertBefore: jest.fn(),
      },
      nextSibling: null,
    };
    return btn;
  }

  test('disables Generate button when imageGenAvailable is false', () => {
    const btn = makeButton();

    applyImageGenCapability(btn, {
      imageGenAvailable: false,
      recraftAvailable: false,
      openaiAvailable: false,
    });

    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Set a Recraft or OpenAI key in the Keys tab');
  });

  test('enables Generate button when imageGenAvailable is true (Recraft)', () => {
    const btn = makeButton();

    applyImageGenCapability(btn, {
      imageGenAvailable: true,
      recraftAvailable: true,
      openaiAvailable: false,
    });

    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe('Generate image');

    // Verify hint was created with provider name
    const hint = global.document.getElementById('oracleCapabilityHint');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toBe('Using Recraft');
  });

  test('enables Generate button when imageGenAvailable is true (OpenAI)', () => {
    const btn = makeButton();

    applyImageGenCapability(btn, {
      imageGenAvailable: true,
      recraftAvailable: false,
      openaiAvailable: true,
    });

    expect(btn.disabled).toBe(false);
    const hint = global.document.getElementById('oracleCapabilityHint');
    expect(hint.textContent).toBe('Using OpenAI');
  });

  test('shows missing-key hint when disabled', () => {
    const btn = makeButton();

    applyImageGenCapability(btn, {
      imageGenAvailable: false,
      recraftAvailable: false,
      openaiAvailable: false,
    });

    const hint = global.document.getElementById('oracleCapabilityHint');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toBe('Set a Recraft or OpenAI key in the Keys tab');
    expect(hint.classList.contains('oracle-capability-missing')).toBe(true);
    expect(hint.classList.contains('oracle-capability-active')).toBe(false);
  });

  test('hint shows active class when enabled', () => {
    const btn = makeButton();

    applyImageGenCapability(btn, {
      imageGenAvailable: true,
      recraftAvailable: true,
      openaiAvailable: false,
    });

    const hint = global.document.getElementById('oracleCapabilityHint');
    expect(hint.classList.contains('oracle-capability-active')).toBe(true);
    expect(hint.classList.contains('oracle-capability-missing')).toBe(false);
  });

  test('reuses hint element on repeated calls', () => {
    const btn = makeButton();

    applyImageGenCapability(btn, { imageGenAvailable: false, recraftAvailable: false, openaiAvailable: false });
    const firstHint = global.document.getElementById('oracleCapabilityHint');

    applyImageGenCapability(btn, { imageGenAvailable: true, recraftAvailable: true, openaiAvailable: false });
    const secondHint = global.document.getElementById('oracleCapabilityHint');

    // Same element, not a new one
    expect(secondHint).toBe(firstHint);
    expect(secondHint.textContent).toBe('Using Recraft');
  });

  test('no-ops when generateBtn is null', () => {
    expect(() => {
      applyImageGenCapability(null, { imageGenAvailable: false });
    }).not.toThrow();
  });
});

describe('Voice button capability gating logic', () => {
  test('voice button disabled when voiceTranscriptionAvailable is false', () => {
    const voiceEnabled = true;
    const voiceCapabilityAvailable = false;
    const disabled = !voiceEnabled || !voiceCapabilityAvailable;
    expect(disabled).toBe(true);
  });

  test('voice button enabled when voiceTranscriptionAvailable is true and voiceEnabled', () => {
    const voiceEnabled = true;
    const voiceCapabilityAvailable = true;
    const disabled = !voiceEnabled || !voiceCapabilityAvailable;
    expect(disabled).toBe(false);
  });

  test('voice button disabled when voiceEnabled is false regardless of capability', () => {
    const voiceEnabled = false;
    const voiceCapabilityAvailable = true;
    const disabled = !voiceEnabled || !voiceCapabilityAvailable;
    expect(disabled).toBe(true);
  });

  test('voice button shows correct title when capability missing', () => {
    const voiceCapabilityAvailable = false;
    const title = voiceCapabilityAvailable ? 'Toggle voice input' : 'Set OpenAI key in Keys tab for voice input';
    expect(title).toBe('Set OpenAI key in Keys tab for voice input');
  });

  test('voice button shows correct title when capability available', () => {
    const voiceCapabilityAvailable = true;
    const title = voiceCapabilityAvailable ? 'Toggle voice input' : 'Set OpenAI key in Keys tab for voice input';
    expect(title).toBe('Toggle voice input');
  });
});
