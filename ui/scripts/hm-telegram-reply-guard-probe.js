#!/usr/bin/env node

const {
  probeTelegramReplyObligation,
  closeTelegramReplyObligationStores,
} = require('../modules/main/telegram-reply-obligations');

function usage() {
  console.log('Usage: node hm-telegram-reply-guard-probe.js --inbound <message-id> [--db-path <path>] [--json]');
  console.log('       node hm-telegram-reply-guard-probe.js --obligation <obligation-id> [--db-path <path>] [--json]');
}

function parseArgs(argv = []) {
  const parsed = {
    inboundMessageId: null,
    obligationId: null,
    dbPath: null,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--inbound' || token === '--message-id') {
      if (!argv[index + 1]) return { ok: false, error: `${token} requires a value` };
      parsed.inboundMessageId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--obligation') {
      if (!argv[index + 1]) return { ok: false, error: '--obligation requires a value' };
      parsed.obligationId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--db-path') {
      if (!argv[index + 1]) return { ok: false, error: '--db-path requires a path' };
      parsed.dbPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (String(token || '').startsWith('--')) {
      return { ok: false, error: `Unknown option ${token}` };
    }
    if (!parsed.inboundMessageId) {
      parsed.inboundMessageId = token;
      continue;
    }
    return { ok: false, error: `Unexpected argument ${token}` };
  }
  return { ok: true, parsed };
}

function formatCandidate(candidate = {}) {
  const marker = candidate.matched ? 'MATCH' : 'NO';
  const parts = [
    marker,
    `reason=${candidate.reason || 'unknown'}`,
    `row=${candidate.rowId || 'unknown'}`,
    `message=${candidate.messageId || 'unknown'}`,
  ];
  if (candidate.chatId) parts.push(`chat=${candidate.chatId}`);
  if (candidate.sessionId) parts.push(`session=${candidate.sessionId}`);
  if (candidate.replyToMessageId) parts.push(`replyTo=${candidate.replyToMessageId}`);
  if (candidate.timestampMs) parts.push(`ts=${candidate.timestampMs}`);
  return parts.join(' ');
}

function printHuman(result = {}) {
  if (!result.ok) {
    console.log(`Telegram reply guard probe: ${result.status || 'failed'} (${result.reason || 'unknown'})`);
    if (result.inboundMessageId) console.log(`Inbound: ${result.inboundMessageId}`);
    if (result.obligationId) console.log(`Obligation: ${result.obligationId}`);
    if (result.dbPath) console.log(`DB: ${result.dbPath}`);
    return;
  }

  const obligation = result.obligation || {};
  console.log(
    [
      'Telegram reply guard probe:',
      `status=${result.status}`,
      `obligation=${obligation.obligationId || 'unknown'}`,
      `inbound=${obligation.inboundMessageId || 'unknown'}`,
      `state=${obligation.status || 'unknown'}`,
    ].join(' ')
  );
  console.log(`Context: session=${obligation.sessionId || 'unknown'} chat=${obligation.chatId || 'unknown'} opened=${obligation.openedAtMs || 'unknown'} deadline=${obligation.deadlineAtMs || 'unknown'}`);
  if (!Array.isArray(result.candidates) || result.candidates.length === 0) {
    console.log('Candidates: none');
    return;
  }
  console.log('Candidates:');
  for (const candidate of result.candidates) {
    console.log(`- ${formatCandidate(candidate)}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`[hm-telegram-reply-guard-probe] ${parsed.error}`);
    usage();
    process.exit(1);
  }
  if (parsed.parsed.help) {
    usage();
    process.exit(0);
  }
  if (!parsed.parsed.inboundMessageId && !parsed.parsed.obligationId) {
    console.error('[hm-telegram-reply-guard-probe] --inbound or --obligation is required');
    usage();
    process.exit(1);
  }

  const result = probeTelegramReplyObligation({
    inboundMessageId: parsed.parsed.inboundMessageId,
    obligationId: parsed.parsed.obligationId,
  }, {
    dbPath: parsed.parsed.dbPath,
  });
  closeTelegramReplyObligationStores();
  if (parsed.parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  process.exit(result.ok ? 0 : 2);
}

if (require.main === module) {
  main().catch((err) => {
    closeTelegramReplyObligationStores();
    console.error(`[hm-telegram-reply-guard-probe] Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  formatCandidate,
  printHuman,
  main,
};
