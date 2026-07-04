'use strict';

/**
 * hm-dup-triage: body-hash divergence scanner for duplicate helper
 * functions (S468 weaker-duplicate-hunt tooling, kept warm for the
 * consolidation lane). Usage: node ui/scripts/hm-dup-triage.js [names...]
 * Default names = the S468 chartered families.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const names = process.argv.length > 2 ? process.argv.slice(2) : ['normalizeScope', 'toText', 'normalizeString', 'normalizeWhitespace', 'normalizeAction', 'normalizePath', 'toNumber', 'timestampMs', 'truncateText', 'normalizePaneId', 'normalizeRole', 'escapeHtml'];
const files = execSync('git ls-files', { encoding: 'utf8', cwd: 'D:/projects/squidrun' }).split(/\r?\n/)
  .filter((f) => (f.startsWith('ui/modules') || f === 'ui/renderer.js') && f.endsWith('.js') && !f.includes('__tests__'));
for (const name of names) {
  const variants = new Map();
  for (const f of files) {
    let src;
    try { src = fs.readFileSync('D:/projects/squidrun/' + f, 'utf8'); } catch { continue; }
    const marker = 'function ' + name + '(';
    const idx = src.indexOf(marker);
    if (idx < 0) continue;
    let depth = 0;
    let end = idx;
    for (let i = src.indexOf('{', idx); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(idx, end + 1).replace(/\s+/g, ' ');
    const h = crypto.createHash('md5').update(body).digest('hex').slice(0, 6);
    if (!variants.has(h)) variants.set(h, []);
    variants.get(h).push(f);
  }
  const total = [...variants.values()].reduce((n, a) => n + a.length, 0);
  if (total > 1) {
    console.log(`${name}: ${total} copies, ${variants.size} distinct bodies${variants.size > 1 ? ' <== DIVERGENT' : ' (identical)'}`);
  }
}
