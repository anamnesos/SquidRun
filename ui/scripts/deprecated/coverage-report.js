// Quick coverage summary analysis
const data = require('../coverage/coverage-summary.json');

const entries = Object.entries(data)
  .filter(([k]) => k !== 'total')
  .map(([k, v]) => ({
    file: k.replace(/^.*?ui[/\\]/, ''),
    stmts: v.statements.pct,
    branch: v.branches.pct,
    funcs: v.functions.pct,
    lines: v.lines.pct,
  }))
  .sort((a, b) => a.lines - b.lines);

console.log('=== MODULES UNDER 50% LINE COVERAGE ===');
const under50 = entries.filter(e => e.lines < 50);
under50.forEach(e => console.log(`  ${String(e.lines).padStart(6)}% | ${e.file}`));
console.log(`\nTotal under 50%: ${under50.length} modules`);

console.log('\n=== MODULES 50-80% LINE COVERAGE ===');
const mid = entries.filter(e => e.lines >= 50 && e.lines < 80);
mid.forEach(e => console.log(`  ${String(e.lines).padStart(6)}% | ${e.file}`));
console.log(`\nTotal 50-80%: ${mid.length} modules`);

const total = data.total;
console.log(`\n=== OVERALL ===`);
console.log(`Statements: ${total.statements.pct}%`);
console.log(`Branches:   ${total.branches.pct}%`);
console.log(`Functions:  ${total.functions.pct}%`);
console.log(`Lines:      ${total.lines.pct}%`);
