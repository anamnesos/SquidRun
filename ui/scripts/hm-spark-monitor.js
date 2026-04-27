#!/usr/bin/env node
'use strict';

const sparkCapture = require('../modules/trading/spark-capture');

function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
  };
  for (const token of argv) {
    if (token === '--json') {
      options.json = true;
    }
  }
  return options;
}

async function main() {
  const options = parseCliArgs();
  const result = await sparkCapture.runSparkScan({});
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.alertMessage || 'No new spark alerts.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  parseCliArgs,
  main,
};
