import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateRootReadiness } from "./state-root.js";
import { listRuntimeTurnJournal, type RuntimeTurnJournalRecord } from "./turn-journal.js";

export type RuntimeTurnMemorySummary = {
  protocol: "mira.runtime_turn_memory_summary.v0";
  generated_at: string;
  source_record_count: number;
  summary: string;
  topics: string[];
  open_loops: string[];
  quality_notes: string[];
  last_user_intent: string | null;
  external_send: false;
  tools_executed: false;
};

export type RuntimeTurnMemoryResult = {
  ok: true;
  protocol: "mira.runtime_turn_memory_summary_read.v0";
  loaded: boolean;
  path: string | null;
  summary: RuntimeTurnMemorySummary | null;
  external_send: false;
  tools_executed: false;
};

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getMemoryPath(rootPath: string): string {
  return path.resolve(rootPath, "conversation-memory", "recent-summary.json");
}

function cleanText(value: unknown, maxLength = 180): string {
  return String(value || "")
    .replace(/\b(schema|session_id|message_id|request_id|external_send|tools_executed|source_draft_sha256|runtime_executes)[\w-]*\b\s*[:=]?\s*/gi, "")
    .replace(/[{}[\]"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function intentFromPrompt(prompt: string): string | null {
  const text = cleanText(prompt, 160);
  if (!text) return null;
  if (/\b(who are you|what are you)\b/i.test(text)) return "asked who Mira is";
  if (/\b(memory|remember|recent|last|said before)\b/i.test(text)) return "asked Mira to use recent memory";
  if (/\b(draft|reply|customer|invoice|task|review)\b/i.test(text)) return "worked on a local draft or task";
  if (/\b(wrong|bad|dumb|stupid|shape|quality)\b/i.test(text)) return "called out answer quality";
  if (/\b(why|how|explain)\b/i.test(text)) return "asked for reasoning";
  return `said: ${text}`;
}

function addUnique(values: string[], value: string | null): void {
  if (!value || values.includes(value)) return;
  values.push(value);
}

function topicFromRecord(record: RuntimeTurnJournalRecord): string | null {
  const combined = `${record.prompt} ${record.response?.content || ""}`;
  if (/\b(invoice|customer|draft|reply)\b/i.test(combined)) return "customer reply drafting";
  if (/\b(task|review|approve|reject|edit)\b/i.test(combined)) return "local task review";
  if (/\b(memory|remember|recent|journal)\b/i.test(combined)) return "recent memory";
  if (/\b(model|gemma|ollama|openai)\b/i.test(combined)) return "model behavior";
  if (/\b(wrong|bad|dumb|stupid|quality|shape)\b/i.test(combined)) return "answer quality";
  return null;
}

function qualityNoteFromRecord(record: RuntimeTurnJournalRecord): string | null {
  if (record.outcome === "error") return `last error: ${cleanText(record.error?.code || "runtime error", 80)}`;
  const response = record.response?.content || "";
  if (/(I heard:|Runtime state:|Loaded normalized core summary:|Operator context:)/i.test(response)) {
    return "avoid runtime recitals in visible replies";
  }
  if (/Last prompt was .*I answered:/i.test(response)) {
    return "avoid quote-chaining previous fallback text";
  }
  if (/\b(wrong|bad|dumb|stupid|quality|shape)\b/i.test(record.prompt)) {
    return "answer quality is the active pressure";
  }
  return null;
}

function openLoopFromRecord(record: RuntimeTurnJournalRecord): string | null {
  const prompt = record.prompt;
  if (/\b(draft|reply|customer|invoice)\b/i.test(prompt)) return "keep draft/review work local until explicitly sent by a human";
  if (/\b(memory|remember|recent)\b/i.test(prompt)) return "answer from what just happened without quoting the previous turns";
  if (record.outcome === "error") return "check the failed turn before claiming the issue is solved";
  return null;
}

function isLowSignalRecord(record: RuntimeTurnJournalRecord): boolean {
  const prompt = cleanText(record.prompt, 80).toLowerCase();
  if (["status", "prime", "ping", "health"].includes(prompt)) return true;
  const response = cleanText(record.response?.content || "", 220).toLowerCase();
  return prompt === "status" || /recent turn journal|full lived memory|starter notes|permissions/.test(response);
}

export function buildRuntimeTurnMemorySummary(records: RuntimeTurnJournalRecord[], now = new Date()): RuntimeTurnMemorySummary {
  const topics: string[] = [];
  const openLoops: string[] = [];
  const qualityNotes: string[] = [];
  const recent = records.filter((record) => !isLowSignalRecord(record)).slice(0, 12);

  for (const record of recent) {
    addUnique(topics, topicFromRecord(record));
    addUnique(openLoops, openLoopFromRecord(record));
    addUnique(qualityNotes, qualityNoteFromRecord(record));
  }

  const lastUserIntent = recent[0] ? intentFromPrompt(recent[0].prompt) : null;
  const pieces: string[] = [
    lastUserIntent ? `Most recent thread: ${lastUserIntent}.` : null,
    topics.length ? `Recurring areas: ${topics.slice(0, 5).join(", ")}.` : null,
    qualityNotes.length ? `Tone/quality: ${qualityNotes.slice(0, 3).join("; ")}.` : null,
    openLoops.length ? `Needs: ${openLoops[0]}.` : null,
  ].filter((piece): piece is string => Boolean(piece));

  return {
    protocol: "mira.runtime_turn_memory_summary.v0",
    generated_at: now.toISOString(),
    source_record_count: recent.length,
    summary: pieces.join(" ") || "No recent conversation memory has been summarized yet.",
    topics,
    open_loops: openLoops,
    quality_notes: qualityNotes,
    last_user_intent: lastUserIntent,
    external_send: false,
    tools_executed: false,
  };
}

export function refreshRuntimeTurnMemorySummary(input: {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  limit?: number;
} = {}): RuntimeTurnMemoryResult {
  const stateRoot = getStateRootReadiness(input.env || process.env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.runtime_turn_memory_summary_read.v0",
      loaded: false,
      path: null,
      summary: null,
      external_send: false,
      tools_executed: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const memoryPath = getMemoryPath(rootPath);
  if (!isInside(rootPath, memoryPath)) {
    return {
      ok: true,
      protocol: "mira.runtime_turn_memory_summary_read.v0",
      loaded: false,
      path: null,
      summary: null,
      external_send: false,
      tools_executed: false,
    };
  }

  const journal = listRuntimeTurnJournal({ env: input.env || process.env, limit: input.limit || 30 });
  const summary = buildRuntimeTurnMemorySummary(journal.records, input.now || new Date());
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  const tempPath = `${memoryPath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, memoryPath);

  return {
    ok: true,
    protocol: "mira.runtime_turn_memory_summary_read.v0",
    loaded: true,
    path: memoryPath,
    summary,
    external_send: false,
    tools_executed: false,
  };
}

export function readRuntimeTurnMemorySummary(input: {
  env?: NodeJS.ProcessEnv;
} = {}): RuntimeTurnMemoryResult {
  const stateRoot = getStateRootReadiness(input.env || process.env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.runtime_turn_memory_summary_read.v0",
      loaded: false,
      path: null,
      summary: null,
      external_send: false,
      tools_executed: false,
    };
  }
  const rootPath = path.resolve(stateRoot.path);
  const memoryPath = getMemoryPath(rootPath);
  if (!isInside(rootPath, memoryPath) || !fs.existsSync(memoryPath)) {
    return {
      ok: true,
      protocol: "mira.runtime_turn_memory_summary_read.v0",
      loaded: false,
      path: null,
      summary: null,
      external_send: false,
      tools_executed: false,
    };
  }
  try {
    const summary = JSON.parse(fs.readFileSync(memoryPath, "utf8")) as RuntimeTurnMemorySummary;
    if (summary.protocol !== "mira.runtime_turn_memory_summary.v0") throw new Error("bad protocol");
    return {
      ok: true,
      protocol: "mira.runtime_turn_memory_summary_read.v0",
      loaded: true,
      path: memoryPath,
      summary,
      external_send: false,
      tools_executed: false,
    };
  } catch {
    return {
      ok: true,
      protocol: "mira.runtime_turn_memory_summary_read.v0",
      loaded: false,
      path: memoryPath,
      summary: null,
      external_send: false,
      tools_executed: false,
    };
  }
}
