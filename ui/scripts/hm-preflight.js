#!/usr/bin/env node
/**
 * hm-preflight: Scans a target project for existing agent protocols that might conflict with Hivemind.
 * Usage: node hm-preflight.js [target-dir]
 */

const fs = require('fs');
const path = require('path');

const TARGET_FILES = ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md', 'CODEX.md'];

// Patterns that indicate agent coordination protocols (potential conflicts)
const CONFLICT_PATTERNS = {
  role_assignment: /\b(role|persona|identity)\b|you are the|your role is/i,
  identity_announcement: /\bannounce\b|\bidentify yourself\b|\bstate your\b|identity announcement|announcement protocol/i,
  registry_sign_in: /\bregistry\b|\bsign-in\b|\bcheck-in\b|\blogin\b|workstation query|registry sign-in/i,
  reporting_chain: /\breport to\b|\bescalate to\b|\bnotify\b|reporting chain/i,
  communication_protocol: /\bcommunication\b|\bmessage\b|\bprotocol\b|hm-send|websocket|agent communication/i,
  startup_routine: /\bon startup\b|startup protocol|startup baseline|on launch/i
};

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const conflicts = [];
  const safeRules = [];

  // Simple heuristic: lines with conflict keywords are conflicts, others are "safe" (coding rules)
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    let isConflict = false;
    for (const [category, pattern] of Object.entries(CONFLICT_PATTERNS)) {
      if (pattern.test(trimmed)) {
        conflicts.push(`[${category}] ${trimmed}`);
        isConflict = true;
        break;
      }
    }

    if (!isConflict && trimmed.length > 10 && (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed))) {
      safeRules.push(trimmed);
    }
  });

  return {
    file: path.basename(filePath),
    hasAgentProtocols: conflicts.length > 0,
    conflicts: conflicts.slice(0, 10), // Limit output
    safeRules: safeRules.slice(0, 5)    // Sample safe rules
  };
}

function main() {
  const targetDir = process.argv[2] || '.';
  const results = [];

  TARGET_FILES.forEach(fileName => {
    const filePath = path.join(targetDir, fileName);
    if (fs.existsSync(filePath)) {
      results.push(scanFile(filePath));
    }
  });

  console.log(JSON.stringify(results, null, 2));
}

main();
