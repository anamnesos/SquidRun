#!/usr/bin/env node
'use strict';

const { appendVoiceEgressMessage } = require('../modules/voice-broker');

function usage() {
  console.log('Usage: node ui/scripts/hm-voice-say.js [text]');
  console.log('       echo "Mira reply" | node ui/scripts/hm-voice-say.js --stdin');
  console.log('Queues text for the active Voice tab to speak as Mira.');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }

  const useStdin = argv.includes('--stdin');
  const text = useStdin
    ? await readStdin()
    : argv.filter((arg) => arg !== '--stdin').join(' ');

  const result = appendVoiceEgressMessage({
    text,
    source: 'hm-voice-say',
  });

  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
};
