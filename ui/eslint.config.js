const globals = require('globals');

module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.browser,
        ...globals.node,
        // Electron preload exposes these
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        confirm: 'readonly',
        alert: 'readonly',
      }
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-undef': 'error',
      'no-unreachable': 'error',
    }
  },
  {
    // Ignore test files and node_modules
    ignores: ['node_modules/**', '__tests__/**', '*.test.js']
  }
];
