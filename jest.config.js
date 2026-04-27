module.exports = {
  projects: ['<rootDir>/ui/jest.config.js'],
  testPathIgnorePatterns: [
    '<rootDir>/.squidrun/',
    '<rootDir>/ui/dist/',
    '<rootDir>/coverage/',
    '<rootDir>/node_modules/',
  ],
};
