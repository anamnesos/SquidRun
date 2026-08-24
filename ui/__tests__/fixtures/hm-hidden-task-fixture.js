'use strict';

const fs = require('fs');

const markerPath = process.argv[2];
if (!markerPath) process.exit(87);

fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
process.stdout.write('hidden fixture stdout\n');
process.stderr.write('hidden fixture stderr\n');
setTimeout(() => process.exit(23), 1200);
