module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  verbose: true,
  collectCoverageFrom: [
    'config.js',
    'daemon-client.js',
    'terminal-daemon.js',
  ],
};
