/**
 * Jest setup file - runs before all tests
 * Configures global mocks and test utilities
 */

// Suppress console output during tests (optional - comment out for debugging)
// global.console = {
//   ...console,
//   log: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
//   error: jest.fn(),
// };

// Mock the logger module to prevent file writes and console spam
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Provide a utility to reset all mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
});
