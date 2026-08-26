#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { closeCommsJournalStores } = require('../modules/main/comms-journal');
const {
  sendLongTelegramMessage,
  splitLongTelegramMessage,
} = require('./hm-telegram-routing');

function usage() {
  console.log('Usage: node send-long-telegram.js <message> [--chat-id <id>] [--file <path>] [--stdin] [--role <role>] [--message-id <id>]');
}

function readStdin() {
  try {
    return fs.readFileSync('/dev/stdin', 'utf8');
  } catch (_) {
    return fs.readFileSync(0, 'utf8');
  }
}

function parseArgs(argv = []) {
  const messageParts = [];
  const options = {
    chatId: null,
    file: null,
    stdin: false,
    role: 'architect',
    messageId: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      return { ok: true, help: true, options, message: '' };
    }
    if (token === '--stdin') {
      options.stdin = true;
      continue;
    }
    if (token === '--chat-id' && argv[i + 1]) {
      options.chatId = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--file' && argv[i + 1]) {
      options.file = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--role' && argv[i + 1]) {
      options.role = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--message-id' && argv[i + 1]) {
      options.messageId = argv[i + 1];
      i += 1;
      continue;
    }
    messageParts.push(token);
  }

  let message = messageParts.join(' ');
  if (options.stdin) {
    message = readStdin();
  } else if (options.file) {
    message = fs.readFileSync(path.resolve(options.file), 'utf8');
  }

  return { ok: true, help: false, options, message };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  if (!parsed.ok || parsed.help) {
    usage();
    process.exit(parsed.help ? 0 : 1);
  }

  const message = String(parsed.message || '').trim();
  if (!message) {
    console.error('[send-long-telegram] Message cannot be empty');
    process.exit(1);
  }

  const chunks = splitLongTelegramMessage(message);
  const result = await sendLongTelegramMessage(message, env, {
    chatId: parsed.options.chatId,
    senderRole: parsed.options.role || 'architect',
    messageId: parsed.options.messageId || null,
  });

  if (!result?.ok) {
    closeCommsJournalStores();
    console.error(`[send-long-telegram] Failed: ${result?.error || 'telegram_delivery_failed'}`);
    process.exit(1);
  }

  closeCommsJournalStores();
  console.log(
    `[send-long-telegram] Sent ${chunks.length} Telegram chunk(s)`
    + `${result.chatId ? ` to ${result.chatId}` : ''}`
    + `${result.messageId ? ` (last message_id: ${result.messageId})` : ''}`
  );
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    closeCommsJournalStores();
    console.error(`[send-long-telegram] Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  main,
};
