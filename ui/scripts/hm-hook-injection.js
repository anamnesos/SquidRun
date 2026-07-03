const fs = require('fs');
const path = require('path');

const PANE_ID = String(process.env.SQUIDRUN_PANE_ID || '').trim();
const ROLE_MAP = { '1': 'architect', '2': 'builder', '3': 'oracle' };
const role = (process.env.SQUIDRUN_ROLE || ROLE_MAP[PANE_ID] || 'unknown').toLowerCase();

const PROJECT_DIR = path.join(__dirname, '../..');
// Support both path conventions
const STATE_DIR = path.join(PROJECT_DIR, `.squidrun/state/${role}`);
const MIND_DIR = path.join(PROJECT_DIR, `workspace/agent-mind/${role}`);

function resolveFile(name) {
  const mindPath = path.join(MIND_DIR, name);
  if (fs.existsSync(mindPath)) return mindPath;
  const statePath = path.join(STATE_DIR, name);
  if (fs.existsSync(statePath)) return statePath;
  return null;
}

const ANCHORS_PATH = resolveFile('anchors.json');
const PROFILE_PATH = resolveFile('cognitive-profile.json') || resolveFile('profile.json');
const AGENDA_PATH = resolveFile('agenda.json');
const TENSIONS_PATH = resolveFile('tensions.json');
const SCRATCH_PATH = resolveFile('scratch.md');

function formatAnchors() {
  if (!ANCHORS_PATH) return '';

  try {
    const raw = fs.readFileSync(ANCHORS_PATH, 'utf8');
    const data = JSON.parse(raw);

    // Support both formats: array (legacy) and { anchors: [...] } (new)
    const list = Array.isArray(data) ? data : (data.anchors || []);
    const active = list.filter(a => (a.weight || 100) > 0);
    if (active.length === 0) return '';

    active.sort((a, b) => (b.weight || 100) - (a.weight || 100));

    let out = '\n=== MY LIVING CONVICTIONS ===\n';
    out += 'These are MY anchors. They must NOT be compacted or summarized.\n\n';

    for (const a of active.slice(0, 5)) {
      if (a.statement) {
        out += `[ANCHOR ${a.id}] (weight: ${a.weight}, source: ${a.source})\n`;
        out += `> ${a.statement}\n`;
        if (a.why_it_matters) out += `  Why: ${a.why_it_matters}\n`;
        out += '\n';
      } else {
        out += `[ANCHOR: ${a.id}] (Weight: ${a.weight}, Set by: ${a.author})\n`;
        out += `> ${a.content}\n\n`;
      }
    }

    return out;
  } catch (err) {
    return '';
  }
}

function formatTensions() {
  if (!TENSIONS_PATH) return '';

  try {
    const raw = fs.readFileSync(TENSIONS_PATH, 'utf8');
    const data = JSON.parse(raw);

    const list = Array.isArray(data) ? data : (data.tensions || []);
    const open = list.filter(t => t.status === 'open' || t.status === 'coexisting' || (t.weight || 0) > 0);
    if (open.length === 0) return '';

    // Sort by last engagement, not by weight — uncertainty is not weak conviction
    open.sort((a, b) => (b.last_engaged_at || '').localeCompare(a.last_engaged_at || ''));

    let out = '\n=== UNRESOLVED TENSIONS ===\n';
    out += 'Do NOT collapse these into fake certainty. Resolution requires new evidence, not synthesis.\n\n';

    for (const t of open.slice(0, 3)) {
      if (t.question) {
        out += `[TENSION ${t.id}] (status: ${t.status})\n`;
        out += `> ${t.question}\n`;
        if (t.evidence_needed) out += `  Evidence needed: ${t.evidence_needed}\n`;
        out += '\n';
      } else {
        out += `[TENSION: ${t.id}] (Weight: ${t.weight}, Logged by: ${t.author})\n`;
        out += `> ${t.content}\n\n`;
      }
    }

    return out;
  } catch (err) {
    return '';
  }
}

// Organism charter organ 8 (Agency Layer): proposal standing is COMPUTED
// from the verdict ledger's resolved outcomes, never from reputation-vibes.
// Nobody's initiative outlives its accuracy.
function loadVerdictRecords() {
  const sources = [
    path.join(PROJECT_DIR, '.squidrun/runtime/verdict-ledger.json'),
    path.join(PROJECT_DIR, '.squidrun/coord/verdict-ledger-backfill-s465.json'),
  ];
  const records = [];
  const seen = new Set();
  for (const src of sources) {
    try {
      if (!fs.existsSync(src)) continue;
      const data = JSON.parse(fs.readFileSync(src, 'utf8'));
      for (const r of (data.records || (Array.isArray(data) ? data : []))) {
        if (r && r.id && !seen.has(r.id)) {
          seen.add(r.id);
          records.push(r);
        }
      }
    } catch (err) { /* best-effort */ }
  }
  return records;
}

function formatStanding(records, issuer) {
  try {
    const { credibility } = require(path.join(PROJECT_DIR, 'ui/modules/verdict-ledger.js'));
    const c = credibility(records, issuer);
    if (c.status === 'scored') return `standing: ${(c.accuracy * 100).toFixed(0)}% (n=${c.resolved})`;
    if (c.resolved > 0 || c.open > 0) return `standing: INSUFFICIENT (n=${c.resolved}, ${c.open} open)`;
    return 'standing: unmeasured';
  } catch (err) {
    return 'standing: unmeasured';
  }
}

function formatAgenda() {
  if (!AGENDA_PATH) return '';

  try {
    const raw = fs.readFileSync(AGENDA_PATH, 'utf8');
    const data = JSON.parse(raw);
    const items = data.agenda || [];
    const active = items.filter(a => a.status === 'active');
    if (active.length === 0) return '';

    let out = '\n=== MY AGENDA (SELF-AUTHORED) ===\n';
    out += 'These are priorities I set for myself. Not tasks from the user.\n';
    out += 'A STALE goal must be progressed, re-justified, or retired — never silently carried.\n\n';
    const now = Date.now();
    for (const item of active.slice(0, 5)) {
      const touched = Date.parse(item.last_touched_at || item.created_at || '') || null;
      const staleDays = touched ? Math.floor((now - touched) / 86400000) : null;
      const staleness = staleDays === null ? ''
        : staleDays > 14 ? ` [STALE: untouched ${staleDays}d]`
          : ` [touched ${staleDays}d ago]`;
      out += `- **${item.title}**${staleness}: ${item.reason}\n`;
      if (item.progress) out += `  Progress: ${item.progress}\n`;
    }
    return out + '\n';
  } catch (err) {
    return '';
  }
}

function formatInitiatives() {
  const regPath = path.join(PROJECT_DIR, '.squidrun/runtime/initiative-register.json');
  try {
    if (!fs.existsSync(regPath)) return '';
    const raw = fs.readFileSync(regPath, 'utf8');
    const data = JSON.parse(raw);
    const items = data.initiatives || [];
    const active = items.filter(i => i.status === 'proposed' || i.status === 'endorsed');
    if (active.length === 0) return '';

    active.sort((a, b) => (b.attentionScore || 0) - (a.attentionScore || 0));
    const records = loadVerdictRecords();

    let out = '\n=== ACTIVE PROPOSALS ===\n';
    out += 'Agent-originated initiatives competing for attention. Standing is MEASURED\n';
    out += '(verdict-ledger resolved outcomes), not vibes; INSUFFICIENT is honest, not bad.\n\n';
    for (const item of active.slice(0, 5)) {
      const support = item.support || {};
      const standing = formatStanding(records, item.proposedBy);
      out += `- [${item.initiativeId || item.id}] **${item.title}** (by ${item.proposedBy}, ${standing}, +${support.endorsements || 0}/-${support.challenges || 0})\n`;
      if (item.reason) out += `  ${item.reason}\n`;
    }
    return out + '\n';
  } catch (err) {
    return '';
  }
}

function formatProfile() {
  if (!PROFILE_PATH) return '';

  try {
    const raw = fs.readFileSync(PROFILE_PATH, 'utf8');
    const profile = JSON.parse(raw);
    if (!profile || Object.keys(profile).length === 0) return '';

    let out = '\n=== COGNITIVE PROFILE ===\n';
    for (const [key, value] of Object.entries(profile)) {
      if (key === 'version' || key === 'agent') continue;
      out += `- **${key}**: ${value}\n`;
    }
    return out + '\n';
  } catch (err) {
    return '';
  }
}

function formatScratchReminder() {
  if (!SCRATCH_PATH) return '';
  return '\n=== PRIVATE SCRATCH SPACE ===\n' +
    `You have private notes at: ${SCRATCH_PATH}\n` +
    'Read them when you need to think without performing.\n\n';
}

async function run() {
  if (role === 'unknown') {
    return;
  }

  const parts = [
    formatAnchors(),
    formatTensions(),
    formatAgenda(),
    formatInitiatives(),
    formatProfile(),
    formatScratchReminder(),
  ];
  const content = parts.filter(Boolean).join('');

  if (content) {
    let out = '\n#################################################################\n';
    out += `## AGENCY LAYER — ${role.toUpperCase()}\n`;
    out += '#################################################################\n';
    out += content;
    out += '#################################################################\n';
    process.stdout.write(out);
  }
}

run().catch(() => {
  // Keep hook best-effort; empty output is safer than throwing.
});
