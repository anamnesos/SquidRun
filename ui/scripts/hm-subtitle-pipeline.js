#!/usr/bin/env node

'use strict';

const path = require('path');

const pipeline = require('../modules/subtitles/pipeline');

function printUsage() {
  process.stdout.write([
    'Usage: node ui/scripts/hm-subtitle-pipeline.js <video-file> [options]',
    '',
    'Options:',
    '  --output <path>              Write subtitle file to this path',
    '  --translation-model <name>   Ollama model for Korean translation/rewrite',
    '  --asr-model <name>           faster-whisper model name (default: small)',
    '  --ollama-base-url <url>      Ollama base URL',
    '  --force-bootstrap            Reinstall Python worker dependencies',
    '  --help                       Show this help text',
    '',
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const { flags, positionals } = pipeline.parseArgs(argv);
  if (flags.help || positionals.length === 0) {
    printUsage();
    return 0;
  }

  const videoPath = positionals[0];
  const result = await pipeline.runSubtitlePipeline({
    videoPath,
    outputPath: flags.output ? path.resolve(flags.output) : null,
    translationModel: flags['translation-model'] || pipeline.DEFAULT_TRANSLATION_MODEL,
    asrModel: flags['asr-model'] || pipeline.DEFAULT_ASR_MODEL,
    ollamaBaseUrl: flags['ollama-base-url'] || null,
    forceBootstrap: Boolean(flags['force-bootstrap']),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
