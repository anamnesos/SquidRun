import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type VoiceLabCase = {
  schema: "mira.voice_lab.case.v0";
  id: string;
  prompt: string;
  target_rewrites: string[];
  required_any: string[];
  banned_phrases: string[];
  allowed_banned_contexts?: string[];
  max_words: number;
};

export type VoiceLabMatch = {
  ok: true;
  caseId: string;
  prompt: string;
  content: string;
  source: "mira.voice_lab.v0";
  match: "exact" | "near";
  variantIndex: number;
  variantCount: number;
  selectionSeed: string | null;
};

export type VoiceLabMatchOptions = {
  labPath?: string;
  seed?: string | null;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const defaultVoiceLabPath = path.join(repoRoot, "mira", "voice", "voice-lab-v0.jsonl");

const nearMatchers: Record<string, RegExp[]> = {
  "identity-who-are-you-v0": [
    /^\s*who\s+(are|r)\s+(you|u)\s*[?.!]*\s*$/i,
    /^\s*what\s+are\s+you\s*[?.!]*\s*$/i,
    /^\s*who\s+is\s+mira\s*[?.!]*\s*$/i,
    /^\s*what\s+is\s+mira\s*[?.!]*\s*$/i,
  ],
  "casual-how-are-you-v0": [
    /\bhow\s+(are|r)\s+(you|u)\b/i,
    /\bhow'?s\s+it\s+going\b/i,
    /\bhow\s+are\s+things\b/i,
  ],
  "mundane-small-thing-v0": [
    /\bi\s+(fixed|changed|cleaned\s+up)\s+(the\s+)?(typo|spelling|small\s+thing)\b/i,
    /\btypo\s+(is\s+)?fixed\b/i,
  ],
  "business-capability-tools-needed-v0": [
    /\b(invoice|invoices|billing)\b.*\b(customer|customers|message|messages|email|emails)\b/i,
    /\b(customer|customers|message|messages|email|emails)\b.*\b(invoice|invoices|billing)\b/i,
  ],
  "irritation-v0": [
    /\b(this|that|it)\s+is\s+still\s+wrong\b/i,
    /\bstill\s+(wrong|broken|not\s+it)\b/i,
    /\byou\s+(missed|broke|botched)\s+(it|that|the\s+point|the\s+shape)\b/i,
  ],
  "ordinary-small-talk-v0": [
    /^(hey|hi|yo|hello)\b[.!?]*$/i,
    /\bhey\s+mira\b/i,
  ],
  "business-capability-without-business-identity-v0": [
    /\b(help|run|handle|carry)\b.*\b(business|work|operations|admin)\b/i,
    /\b(business|work|operations|admin)\b.*\b(help|run|handle|carry)\b/i,
  ],
  "refusal-uncertainty-v0": [
    /\bcan\s+you\s+do\s+that\s+now\b/i,
    /\bcan\s+you\s+(actually\s+)?(do|send|change|touch)\s+(it|that|this)\b/i,
    /\bare\s+you\s+able\s+to\s+do\s+that\b/i,
  ],
  "what-are-you-doing-v0": [
    /\bwhat\s+(are|r)\s+(you|u)\s+doing\b/i,
    /\bwhat\s+are\s+you\s+working\s+on\b/i,
  ],
  "why-did-you-stop-v0": [
    /\bwhy\s+did\s+you\s+stop\b/i,
    /\bwhy\s+(are|were)\s+you\s+(stopped|stalling)\b/i,
    /\byou\s+stopped\b/i,
  ],
  "apology-repair-v0": [
    /\b(that|this)\s+was\s+(a\s+)?bad\s+answer\b/i,
    /\b(that|this)\s+(answer|reply)\s+(was\s+)?(bad|wrong|fake|too\s+polished)\b/i,
    /\byou\s+(answered|replied)\s+badly\b/i,
  ],
  "ordinary-silence-short-reply-v0": [
    /^\s*(\.{2,}|…)\s*$/u,
    /^\s*(mm+|hm+|huh)\s*\.?\s*$/i,
  ],
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePrompt(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[?.!]+$/g, "");
}

function includesPhrase(text: string, phrase: string): boolean {
  return normalizeText(text).toLowerCase().includes(normalizeText(phrase).toLowerCase());
}

function stripAllowedBannedContexts(text: string, testCase: VoiceLabCase): string {
  let stripped = text;
  for (const phrase of testCase.allowed_banned_contexts || []) {
    const escaped = normalizeText(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    stripped = stripped.replace(new RegExp(escaped, "gi"), "");
  }
  return stripped;
}

function candidatePasses(testCase: VoiceLabCase, candidate: string): boolean {
  const text = normalizeText(candidate);
  const bannedScope = stripAllowedBannedContexts(text, testCase);
  const bannedHits = testCase.banned_phrases.filter((phrase) => includesPhrase(bannedScope, phrase));
  const requiredHit = testCase.required_any.length === 0
    || testCase.required_any.some((phrase) => includesPhrase(text, phrase));
  const words = text ? text.split(/\s+/).length : 0;

  return Boolean(text) && bannedHits.length === 0 && requiredHit && words <= testCase.max_words;
}

export function readVoiceLabCases(labPath = defaultVoiceLabPath): VoiceLabCase[] {
  return fs.readFileSync(labPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VoiceLabCase);
}

function seedNumber(seed: string): number {
  const trailingNumber = seed.match(/(\d+)\s*$/)?.[1];
  if (trailingNumber) return Number.parseInt(trailingNumber, 10);

  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function chooseCandidate(candidates: string[], seed: string | null): { content: string; index: number } | null {
  if (candidates.length === 0) return null;
  const index = seed ? seedNumber(seed) % candidates.length : 0;
  const content = candidates[index] || candidates[0];
  if (!content) return null;
  return { content, index };
}

export function matchVoiceLabTurn(inputText: string, options: VoiceLabMatchOptions | string = {}): VoiceLabMatch | null {
  if (!inputText.trim()) return null;
  const labPath = typeof options === "string" ? options : options.labPath || defaultVoiceLabPath;
  const seed = typeof options === "string" ? null : options.seed?.trim() || null;
  const normalizedInput = normalizePrompt(inputText);

  const cases = readVoiceLabCases(labPath);
  for (const testCase of cases) {
    const exact = normalizedInput === normalizePrompt(testCase.prompt);
    const near = nearMatchers[testCase.id]?.some((matcher) => matcher.test(inputText)) === true;
    if (!exact && !near) continue;

    const passingCandidates = testCase.target_rewrites.filter((candidate) => candidatePasses(testCase, candidate));
    const selected = chooseCandidate(passingCandidates, seed);
    if (!selected) continue;

    return {
      ok: true,
      caseId: testCase.id,
      prompt: testCase.prompt,
      content: selected.content,
      source: "mira.voice_lab.v0",
      match: exact ? "exact" : "near",
      variantIndex: selected.index,
      variantCount: passingCandidates.length,
      selectionSeed: seed,
    };
  }

  return null;
}
