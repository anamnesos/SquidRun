#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const {
  generateStartupBriefing,
  readStartupBriefing,
  resolveBriefingPath,
} = require('../modules/startup-ai-briefing');

async function main(argv = process.argv.slice(2)) {
  const command = String(argv[0] || 'generate').trim().toLowerCase();

  if (command === 'read') {
    const content = readStartupBriefing();
    if (content) {
      process.stdout.write(`${content}\n`);
    }
    return;
  }

  if (command !== 'generate') {
    throw new Error(`Unknown command: ${command}`);
  }

  const result = await generateStartupBriefing({
    source: 'hm-startup-ai-briefing',
  });

  if (!result?.ok) {
    throw new Error(result?.error || 'startup_briefing_generation_failed');
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    outputPath: result.outputPath || resolveBriefingPath(),
    transcriptCount: Array.isArray(result.transcriptFiles) ? result.transcriptFiles.length : 0,
    generatedAt: result.generatedAt || null,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
