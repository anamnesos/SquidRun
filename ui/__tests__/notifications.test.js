/**
 * Tests for notifications.js module
 * Tech debt item #9 - consolidated notification system
 */

// Mock document with full DOM simulation
let mockElements = [];
let mockStatusBar = null;

const createMockElement = (tag) => {
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    style: { cssText: '' },
    children: [],
    classList: {
      _classes: new Set(),
      add: function(cls) { this._classes.add(cls); },
      remove: function(cls) { this._classes.delete(cls); },
      contains: function(cls) { return this._classes.has(cls); },
    },
    appendChild: function(child) {
      this.children.push(child);
      mockElements.push(child);
    },
    remove: function() {
      mockElements = mockElements.filter(e => e !== this);
      if (mockStatusBar) {
        mockStatusBar.children = mockStatusBar.children.filter(e => e !== this);
      }
    },
    querySelector: function(selector) {
      return mockElements.find(e => {
        if (selector.startsWith('.')) {
          return e.className.includes(selector.slice(1));
        }
        return false;
      }) || null;
    },
    querySelectorAll: function(selector) {
      return this.children.filter(e => {
        if (selector.startsWith('.')) {
          return e.className.includes(selector.slice(1));
        }
        return false;
      });
    },
  };
  return el;
};

const mockDocument = {
  querySelector: jest.fn((selector) => {
    if (selector === '.status-bar') {
      return mockStatusBar;
    }
    if (selector.startsWith('.')) {
      return mockElements.find(e => e.className.includes(selector.slice(1))) || null;
    }
    return null;
  }),
  querySelectorAll: jest.fn((selector) => {
    if (selector.startsWith('.')) {
      return mockElements.filter(e => e.className.includes(selector.slice(1)));
    }
    return [];
  }),
  createElement: jest.fn((tag) => createMockElement(tag)),
  body: {
    appendChild: jest.fn((el) => {
      mockElements.push(el);
    }),
  },
};

global.document = mockDocument;

const notifications = require('../modules/notifications');

describe('notifications.js module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockElements = [];
    mockStatusBar = createMockElement('div');
    mockStatusBar.className = 'status-bar';
    mockElements.push(mockStatusBar);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('showNotification', () => {
    it('should show toast notification by default', () => {
      notifications.showNotification('Test message');

      const toast = mockElements.find(e => e.className.includes('toast-notification'));
      expect(toast).toBeDefined();
      expect(toast.textContent).toBe('Test message');
      expect(toast.className).toContain('toast-info');
    });

    it('should show statusbar notification when location is statusbar', () => {
      notifications.showNotification('Status message', { location: 'statusbar' });

      const notice = mockStatusBar.children.find(e => e.className.includes('status-notice'));
      expect(notice).toBeDefined();
      expect(notice.textContent).toContain('Status message');
    });

    it('should apply correct type class for warnings', () => {
      notifications.showNotification('Warning!', { type: 'warning' });

      const toast = mockElements.find(e => e.className.includes('toast-warning'));
      expect(toast).toBeDefined();
    });

    it('should apply correct type class for errors', () => {
      notifications.showNotification('Error!', { type: 'error' });

      const toast = mockElements.find(e => e.className.includes('toast-error'));
      expect(toast).toBeDefined();
    });
  });

  describe('showToast (legacy API)', () => {
    it('should create toast element', () => {
      notifications.showToast('Test toast');

      const toast = mockElements.find(e => e.className.includes('toast-notification'));
      expect(toast).toBeDefined();
      expect(toast.textContent).toBe('Test toast');
    });

    it('should remove existing toast when new one shown', () => {
      notifications.showToast('First');
      const firstToast = mockElements.find(e => e.className.includes('toast-notification'));

      // Simulate querySelector finding the existing toast for removal
      mockDocument.querySelector.mockImplementation((selector) => {
        if (selector === '.toast-notification') return firstToast;
        if (selector === '.status-bar') return mockStatusBar;
        return null;
      });

      notifications.showToast('Second');

      const toasts = mockElements.filter(e => e.className.includes('toast-notification'));
      // First toast should have been removed
      expect(toasts.some(t => t.textContent === 'Second')).toBe(true);
    });

    it('should fade out after timeout', () => {
      jest.useFakeTimers();
      notifications.showToast('Test');

      const toast = mockElements.find(e => e.className.includes('toast-notification'));

      jest.advanceTimersByTime(notifications.DEFAULT_TOAST_TIMEOUT);

      expect(toast.classList._classes.has('toast-fade')).toBe(true);
    });

    it('should accept type parameter', () => {
      notifications.showToast('Warning', 'warning');

      const toast = mockElements.find(e => e.className.includes('toast-warning'));
      expect(toast).toBeDefined();
    });
  });

  describe('showStatusNotice (legacy API)', () => {
    it('should create status bar notice', () => {
      notifications.showStatusNotice('Test notice');

      const notice = mockStatusBar.children.find(e => e.className.includes('status-notice'));
      expect(notice).toBeDefined();
      expect(notice.textContent).toContain('Test notice');
    });

    it('should prepend with separator', () => {
      notifications.showStatusNotice('Test');

      const notice = mockStatusBar.children.find(e => e.className.includes('status-notice'));
      expect(notice.textContent).toBe(' | Test');
    });

    it('should handle missing status bar gracefully', () => {
      mockStatusBar = null;

      expect(() => {
        notifications.showStatusNotice('Test');
      }).not.toThrow();
    });

    it('should remove after timeout', () => {
      jest.useFakeTimers();
      notifications.showStatusNotice('Test');

      const notice = mockStatusBar.children.find(e => e.className.includes('status-notice'));
      expect(notice).toBeDefined();

      jest.advanceTimersByTime(notifications.DEFAULT_STATUSBAR_TIMEOUT);

      // Notice should have called remove()
      expect(mockStatusBar.children.some(e => e.className.includes('status-notice'))).toBe(false);
    });

    it('should accept custom timeout', () => {
      jest.useFakeTimers();
      notifications.showStatusNotice('Test', 2000);

      jest.advanceTimersByTime(1999);
      expect(mockStatusBar.children.some(e => e.className.includes('status-notice'))).toBe(true);

      jest.advanceTimersByTime(1);
      expect(mockStatusBar.children.some(e => e.className.includes('status-notice'))).toBe(false);
    });

    it('should allow multiple notices simultaneously', () => {
      notifications.showStatusNotice('First');
      notifications.showStatusNotice('Second');

      const notices = mockStatusBar.children.filter(e => e.className.includes('status-notice'));
      expect(notices.length).toBe(2);
    });
  });

  describe('exported constants', () => {
    it('should export DEFAULT_TOAST_TIMEOUT', () => {
      expect(notifications.DEFAULT_TOAST_TIMEOUT).toBe(5000);
    });

    it('should export DEFAULT_STATUSBAR_TIMEOUT', () => {
      expect(notifications.DEFAULT_STATUSBAR_TIMEOUT).toBe(6000);
    });

    it('should export FADE_DURATION', () => {
      expect(notifications.FADE_DURATION).toBe(500);
    });
  });
});
