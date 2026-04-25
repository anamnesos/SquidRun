'use strict';

const stripAnsiPackage = require('strip-ansi');

function stripAnsi(value) {
  return stripAnsiPackage(String(value || ''));
}

module.exports = {
  stripAnsi,
};
