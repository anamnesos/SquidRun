#!/usr/bin/env node
/**
 * hm-timeline-gate.js — Oracle's verify gate for the human-timeline ("Today") surface (#5 spine).
 *
 * THREE LAYERS, in order of what each guarantees:
 *   1. tokenDenylist  — no banned agent-jargon token survives to rendered text. (necessary)
 *   2. readsHuman     — the line isn't a laundered commit-subject / dev-speak fragment. (closer to sufficient)
 *   3. sourceFidelity — a generated headline introduces NO specific fact (number / proper noun / entity)
 *                       absent from its source. This is the truth-surface guarantee: human-but-wrong = the lie.
 *
 * gateHeadline(headline, sourceText) -> { pass, failures[] }  is the pure function Builder imports into the
 * cache/generation step (gate BEFORE caching; fall back to deterministic template on FAIL).
 *
 * CLI: `node ui/scripts/hm-timeline-gate.js` runs layers 1+2 against the LIVE snapshot's rendered headlines
 * (source-fidelity needs the source pairing, which lives at generation time — run it there, not on rendered-only).
 *
 * NOTE (Oracle, S446): even all three layers are necessary-not-FULLY-sufficient. True "sounds like a person"
 * is a judgment call — a human spot-check stays the final bar. Do not crown this gate.
 */

// ---- Layer 1: token denylist ------------------------------------------------
const DENY = [
  ['sha-hex', /\b[0-9a-f]{7,40}\b/],
  ['role-marker', /\((?:ORACLE|ARCHITECT|BUILDER|MIRA)[^)]*\)|\[TRIGGER\]|cross-window/i],
  ['delivery-ids', /\b(deliveryId|messageId|message id|delivery id)\b/i],
  ['pane', /\bpane\b/i],
  ['ack', /\back(?:ed|nowledged|\.unverified)?\b/i],
  ['HEAD', /\bHEAD\b/],
  ['commit', /\bcommit(?:ted)?\b/i],
  ['trigger', /\btrigger\b/i],
  ['sidecar', /\bsidecar\b/i],
  ['census/verdict', /\b(census|verdict)\b/i],
  ['arm', /\barms?\b/i],
  ['G-code', /\bG\d+\b/],
  ['infra', /\b(daemon|supervisor|poller|injection|PTY|websocket|\bWS\b|fingerprint|schema|snapshot|dataRoot|scoped)\b/i],
  ['receipt-jargon', /\b(modelPromptReceipt|prompt_submitted|in_band|accepted\.unverified)\b/i],
  ['protocol-jargon', /\b(root-coherence|blast radius|dedup|idempotent|\bC4\b)\b/i],
  ['hm-scripts', /\bhm-[a-z-]+\b/i],
  ['file-paths', /[A-Z]:\\|\.squidrun|\.jsonl?\b|\.js\b/i],
];
function tokenDenylist(headline) {
  const fails = [];
  for (const [name, re] of DENY) {
    const m = String(headline || '').match(re);
    if (m) fails.push(`jargon:${name}("${m[0]}")`);
  }
  return fails;
}

// ---- Layer 2: reads-human heuristic ----------------------------------------
const DEV_TELLS = [
  ['no-actor-imperative', /^(harden|fix|add|remove|refactor|update|bump|wire|stop|filter|record|upgrade|cap|demote|fold|relocate|delete|merge|revert|implement|introduce|rename|move|drop|enable|disable|patch|guard|rework|split|carve|reapply|suppress|rate-limit)\b/i],
  ['dev-noun-salad', /\b(launchers?|guards?|handlers?|seam|retry path|env leaks?|fallback|rollout|assertion|invalidation|reconcil\w+|substrate|scaffold|projection|arbiter|lease|coalesce)\b/i],
  ['conjunction-fragment', /\b\w+ and \w+ (guards?|leaks?|checks?|paths?|fixes?|caps?)\b/i],
];
function readsHuman(headline) {
  const t = String(headline || '');
  return DEV_TELLS.filter(([, re]) => re.test(t)).map(([n]) => `dev-speak:${n}`);
}

// ---- Layer 3: source fidelity (the truth guarantee) ------------------------
// Generic words the translation layer is allowed to introduce (not "added facts").
const ALLOWED_GENERIC = new Set([
  'the','team','a','an','to','for','of','and','on','in','with','its','their','his','her',
  'made','make','fixed','fix','added','add','changed','change','saved','set','up','out','over',
  'agent','agents','window','windows','memory','intact','app','restarted','came','back','helper',
  'review','decision','launch','message','update','sent','got','you','your','their','team’s',
  'cleaner','safer','clearer','plain','english','now','today','work','working','done','ready',
]);
const STOP = new Set([...ALLOWED_GENERIC, 'is','was','were','are','be','been','this','that','it','as','at','by','from','into','than','then','so','but','or','not','no']);
function significantTokens(text) {
  return String(text || '')
    .split(/[^A-Za-z0-9À-ɏ]+/)
    .filter(Boolean)
    .filter((w) => !STOP.has(w.toLowerCase()));
}
function sourceFidelity(headline, sourceText, opts = {}) {
  if (sourceText == null) return []; // no source provided -> layer not applicable
  const srcLower = String(sourceText).toLowerCase();
  const fails = [];
  for (const tok of significantTokens(headline)) {
    const low = tok.toLowerCase();
    if (ALLOWED_GENERIC.has(low)) continue;
    const inSource = srcLower.includes(low);
    if (inSource) continue;
    const isNumber = /^\d+([.,]\d+)?$/.test(tok);
    const isProperNoun = /^[A-Z]/.test(tok) && tok.length > 1 && tok !== tok.toUpperCase().slice(0, 1) + tok.slice(1).toLowerCase().slice(0, 0);
    // STRICT, always-on: an invented SPECIFIC (number or proper noun absent from source) is the dangerous lie.
    // Ordinary descriptive words ("sure", "safer") that capture meaning are NOT flagged — that over-strictness
    // rejects good human translations. The residual (invented common nouns) is the human spot-check's job.
    if (isNumber) fails.push(`added-number:"${tok}"`);
    else if (/^[A-Z]/.test(tok) && tok.length > 1) fails.push(`added-entity:"${tok}"`);
    // OPTIONAL tight mode (generation-time, when the FULL source row is available, not just a terse subject):
    else if (opts.tight && tok.length >= 5) fails.push(`added-term:"${tok}"`);
  }
  return fails;
}

// ---- The gate ---------------------------------------------------------------
function gateHeadline(headline, sourceText = null) {
  const failures = [
    ...tokenDenylist(headline),
    ...readsHuman(headline),
    ...sourceFidelity(headline, sourceText),
  ];
  return { pass: failures.length === 0, failures };
}

module.exports = { gateHeadline, tokenDenylist, readsHuman, sourceFidelity };

// ---- CLI: run layers 1+2 against the live snapshot --------------------------
if (require.main === module) {
  (async () => {
    let snap;
    try {
      const { buildHumanTimelineSnapshot } = require('../modules/main/human-timeline.js');
      snap = await Promise.resolve(buildHumanTimelineSnapshot());
    } catch (e) {
      console.error('GATE: cannot load snapshot —', e.message);
      process.exit(2);
    }
    const feed = (snap.feed && snap.feed.items) || [];
    const needs = (snap.needsYou && snap.needsYou.items) || [];
    const rows = [...feed, ...needs].map((e) => ({ where: e.kind || 'item', text: `${e.headline || ''} ${e.detail || ''}`.trim() }));
    let failed = 0;
    for (const r of rows) {
      const f = [...tokenDenylist(r.text), ...readsHuman(r.text)];
      if (f.length) { failed++; console.log(`FAIL [${r.where}] ${r.text.slice(0, 80)}  <<${f.join(',')}`); }
    }
    console.log(`\nrendered rows scanned: ${rows.length} | FAIL: ${failed} | PASS: ${rows.length - failed}`);
    console.log(`(CLI runs layers 1+2; source-fidelity runs at generation time where the source is paired)`);
    console.log(`GATE: ${failed === 0 ? 'PASS' : 'FAIL'}`);
    process.exit(failed === 0 ? 0 : 1);
  })();
}
