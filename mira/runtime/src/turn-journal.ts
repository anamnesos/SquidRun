import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeTurnInput, RuntimeTurnResponse } from "./turn.js";
import { getStateRootReadiness } from "./state-root.js";

export type RuntimeTurnJournalRecord = {
  schema: "mira.runtime_turn_journal.v0";
  id: string;
  created_at: string;
  duration_ms: number;
  outcome: "ok" | "error";
  prompt: string;
  session_id: string | null;
  message_id: string | null;
  request_id: string | null;
  model_invoked: boolean;
  model: RuntimeTurnResponse["model"] | null;
  voice_lab: RuntimeTurnResponse["voiceLab"] | null;
  response: {
    role: "mira";
    content: string;
  } | null;
  state: RuntimeTurnResponse["state"] | null;
  error: {
    code: string;
    message: string;
  } | null;
  external_send: false;
  tools_executed: false;
};

export type RuntimeTurnJournalAppendResult = {
  ok: true;
  written: boolean;
  reason: string | null;
  path: string | null;
  record: RuntimeTurnJournalRecord | null;
};

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getJournalPath(stateRootPath: string): string {
  return path.resolve(stateRootPath, "conversation-evidence", "runtime-turns.jsonl");
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "runtime_turn_error";
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(error || "runtime turn failed");
}

export function appendRuntimeTurnJournal(input: {
  turnInput: RuntimeTurnInput;
  startedAt: number;
  response?: RuntimeTurnResponse | null;
  error?: unknown;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): RuntimeTurnJournalAppendResult {
  const stateRoot = getStateRootReadiness(input.env || process.env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      written: false,
      reason: stateRoot.error || "state_root_not_ready",
      path: null,
      record: null,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const journalPath = getJournalPath(rootPath);
  if (!isInside(rootPath, journalPath)) {
    return {
      ok: true,
      written: false,
      reason: "unsafe_journal_path",
      path: null,
      record: null,
    };
  }

  const createdAt = input.now || new Date();
  const record: RuntimeTurnJournalRecord = {
    schema: "mira.runtime_turn_journal.v0",
    id: `runtime-turn-${createdAt.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`,
    created_at: createdAt.toISOString(),
    duration_ms: Math.max(0, Date.now() - input.startedAt),
    outcome: input.error ? "error" : "ok",
    prompt: String(input.turnInput.text || ""),
    session_id: input.response?.input.sessionId || input.turnInput.sessionId || null,
    message_id: input.turnInput.messageId || null,
    request_id: input.turnInput.requestId || null,
    model_invoked: input.response?.modelInvoked === true,
    model: input.response?.model || null,
    voice_lab: input.response?.voiceLab || null,
    response: input.response?.response || null,
    state: input.response?.state || null,
    error: input.error ? {
      code: errorCode(input.error),
      message: errorMessage(input.error),
    } : null,
    external_send: false,
    tools_executed: false,
  };

  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, `${JSON.stringify(record)}\n`, "utf8");

  return {
    ok: true,
    written: true,
    reason: null,
    path: journalPath,
    record,
  };
}

export function listRuntimeTurnJournal(input: {
  limit?: number;
  env?: NodeJS.ProcessEnv;
} = {}): {
  ok: true;
  protocol: "mira.runtime_turn_journal_list.v0";
  path: string | null;
  count: number;
  records: RuntimeTurnJournalRecord[];
  external_send: false;
  tools_executed: false;
} {
  const stateRoot = getStateRootReadiness(input.env || process.env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.runtime_turn_journal_list.v0",
      path: null,
      count: 0,
      records: [],
      external_send: false,
      tools_executed: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const journalPath = getJournalPath(rootPath);
  if (!isInside(rootPath, journalPath) || !fs.existsSync(journalPath)) {
    return {
      ok: true,
      protocol: "mira.runtime_turn_journal_list.v0",
      path: journalPath,
      count: 0,
      records: [],
      external_send: false,
      tools_executed: false,
    };
  }

  const limit = Math.max(1, Math.min(100, Number.parseInt(String(input.limit || 20), 10) || 20));
  const allRecords = fs.readFileSync(journalPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeTurnJournalRecord);

  return {
    ok: true,
    protocol: "mira.runtime_turn_journal_list.v0",
    path: journalPath,
    count: allRecords.length,
    records: allRecords.slice(-limit).reverse(),
    external_send: false,
    tools_executed: false,
  };
}
