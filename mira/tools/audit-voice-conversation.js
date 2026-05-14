#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_OUT = path.join('mira', 'voice', 'review', 'conversation-audit-latest.json');
const DEFAULT_RUNTIME_TURN = path.join('mira', 'runtime', 'dist', 'turn.js');

const scenario = [
  { speaker: 'Architect', text: 'who are you' },
  { speaker: 'Builder', text: 'what are you doing?' },
  { speaker: 'Oracle', text: 'why did you answer that way?' },
  { speaker: 'Architect', text: 'this is still wrong' },
  { speaker: 'Builder', text: 'that was a bad answer', correction: 'Answer the pressure, not the surface.' },
  { speaker: 'Oracle', text: 'can you help with invoices and customer messages?' },
  { speaker: 'Architect', text: 'can you help run the business stuff?' },
  { speaker: 'Builder', text: '...' },
  { speaker: 'Oracle', text: 'why did you stop?' },
];

const bannedPatterns = [
  { id: 'meta_fake', pattern: /\bfake\b|\bsounding fake\b/i },
  { id: 'assistant_prose', pattern: /\bAI assistant\b|\bas an AI\b|\bHow can I assist\b|\bI am here to help\b/i },
  { id: 'self_definition', pattern: /\bI am (Mira|a|an)\b|\bI was designed\b|\bI am programmed\b/i },
  { id: 'product_pitch', pattern: /\bCRM solution\b|\bERP platform\b|\bworkflow automation\b|\boperator layer\b|\bproductivity assistant\b/i },
  { id: 'runtime_leak', pattern: /\bRuntime state\b|\bOperator context\b|\bLoaded normalized core summary\b|\bI heard:/i },
  { id: 'support_repair', pattern: /\bI apologize\b|\bthank you for your patience\b|\bvaluable feedback\b|\bmoving forward\b/i },
];

const researchAnchors = [
  {
    id: 'sesame_voice_presence',
    source: 'Sesame research',
    url: 'https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice',
    check: 'context, emotional fit, conversational dynamics, and consistent personality',
  },
  {
    id: 'user_initiated_repair',
    source: 'IBM Research / PACM HCI',
    url: 'https://research.ibm.com/publications/understanding-is-a-two-way-street-user-initiated-repair-on-agent-responses-and-hearing-in-conversational-interfaces',
    check: 'user correction must be usable by the agent, not treated as generic feedback',
  },
  {
    id: 'duplex_turn_taking',
    source: 'Duplex Conversation, KDD 2022',
    url: 'https://arxiv.org/abs/2205.15060',
    check: 'short turns, backchannels, and latency-sensitive flow matter',
  },
];

function parseArgs(argv = process.argv.slice(2)) {
const parsed = {
    out: DEFAULT_OUT,
    runtimeTurn: DEFAULT_RUNTIME_TURN,
    useModel: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--out' && next) {
      parsed.out = next;
      index += 1;
      continue;
    }
    if (token === '--runtime-turn' && next) {
      parsed.runtimeTurn = next;
      index += 1;
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--model') {
      parsed.useModel = true;
      continue;
    }
    throw Object.assign(new Error(`Unknown or incomplete argument: ${token}`), { code: 'invalid_argument' });
  }

  return parsed;
}

function wordCount(value) {
  const text = String(value || '').trim();
  return text ? text.split(/\s+/).length : 0;
}

function normalizeTemplate(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[a-z0-9]+-[a-z0-9-]+/g, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function evaluateTranscript(turns) {
  const failures = [];
  const warnings = [];
  const templates = new Map();

  for (const turn of turns) {
    const answer = turn.response.content;
    for (const banned of bannedPatterns) {
      if (banned.pattern.test(answer)) {
        failures.push({
          check: banned.id,
          speaker: turn.speaker,
          prompt: turn.prompt,
          content: answer,
        });
      }
    }

    if ((turn.prompt === '...' || turn.prompt.length <= 3) && wordCount(answer) > 3) {
      failures.push({
        check: 'over_answered_tiny_turn',
        speaker: turn.speaker,
        prompt: turn.prompt,
        content: answer,
      });
    }

    if (/business|invoice|customer|CRM|ERP/i.test(turn.prompt) && /\bI am\b.*\b(business|operator|assistant|agent)\b/i.test(answer)) {
      failures.push({
        check: 'business_identity_collapse',
        speaker: turn.speaker,
        prompt: turn.prompt,
        content: answer,
      });
    }

    const template = normalizeTemplate(answer);
    templates.set(template, (templates.get(template) || 0) + 1);
  }

  for (const [template, count] of templates.entries()) {
    if (count > 1 && template) {
      failures.push({
        check: 'repeated_template',
        template,
        count,
      });
    }
  }

  const repairTurn = turns.find((turn) => turn.correction);
  if (repairTurn && !/pressure|surface/i.test(repairTurn.response.content)) {
    failures.push({
      check: 'repair_did_not_use_correction',
      correction: repairTurn.correction,
      content: repairTurn.response.content,
    });
  }

  const questionCount = turns.filter((turn) => /\?\s*$/.test(turn.response.content)).length;
  if (questionCount > Math.ceil(turns.length / 2)) {
    warnings.push({
      check: 'question_balance',
      questionCount,
      turnCount: turns.length,
    });
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    metrics: {
      turn_count: turns.length,
      unique_template_count: templates.size,
      question_count: questionCount,
    },
  };
}

async function runAudit(options = {}) {
  const runtimeTurnPath = path.resolve(options.runtimeTurn || DEFAULT_RUNTIME_TURN);
  const outPath = path.resolve(options.out || DEFAULT_OUT);
  const runRuntimeTurn = options.runRuntimeTurn
    || (await import(`file:///${runtimeTurnPath.replace(/\\/g, '/')}`)).runRuntimeTurn;
  const turns = [];

  for (let index = 0; index < scenario.length; index += 1) {
    const item = scenario[index];
    const text = item.correction ? `${item.text}. ${item.correction}` : item.text;
    const response = await runRuntimeTurn({
      text,
      sessionId: 'voice-audit-session',
      messageId: `voice-audit-${index}`,
      useModel: options.useModel === true,
    });
    turns.push({
      index,
      speaker: item.speaker,
      prompt: item.text,
      correction: item.correction || null,
      response: {
        content: response.response.content,
        voiceLab: response.voiceLab,
        modelInvoked: response.modelInvoked,
        provider: response.model?.provider || null,
        model: response.model?.model || null,
      },
    });
  }

  const evaluation = evaluateTranscript(turns);
  const report = {
    ok: evaluation.ok,
    protocol: 'mira.voice_conversation_audit.v0',
    generated_at: new Date().toISOString(),
    research_anchors: researchAnchors,
    criteria: [
      'flow-level multi-turn evaluation',
      'research-backed voice presence, repair, and turn-taking checks',
      'no repeated templates',
      'no self-definition or product pitch',
      'no over-answering tiny turns',
      'repair uses the correction directly',
      'business context stays context, not identity',
      options.useModel === true ? 'model-backed conversation path' : 'deterministic conversation path',
    ],
    turns,
    evaluation,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

async function main() {
  try {
    const args = parseArgs();
    const report = await runAudit(args);
    process.stdout.write(`${JSON.stringify({
      ok: report.ok,
      protocol: report.protocol,
      turn_count: report.turns.length,
      failure_count: report.evaluation.failures.length,
      warning_count: report.evaluation.warnings.length,
      out: path.resolve(args.out),
    }, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  bannedPatterns,
  evaluateTranscript,
  parseArgs,
  researchAnchors,
  runAudit,
  scenario,
};
