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
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const defaultVoiceLabPath = path.join(repoRoot, "mira", "voice", "voice-lab-v0.jsonl");

const nearMatchers: Record<string, RegExp[]> = {
  "identity-who-are-you-v0": [
    /\bwho\s+(are|r)\s+(you|u)\b/i,
    /\bwhat\s+are\s+you\b/i,
    /\bwho\s+is\s+mira\b/i,
    /\bwhat\s+is\s+mira\b/i,
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
  "business-capability-without-business-bot-v0": [
    /\b(invoice|invoices|billing)\b.*\b(customer|customers|message|messages|email|emails)\b/i,
    /\b(customer|customers|message|messages|email|emails)\b.*\b(invoice|invoices|billing)\b/i,
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

export function matchVoiceLabTurn(inputText: string, labPath = defaultVoiceLabPath): VoiceLabMatch | null {
  const normalizedInput = normalizePrompt(inputText);
  if (!normalizedInput) return null;

  const cases = readVoiceLabCases(labPath);
  for (const testCase of cases) {
    const exact = normalizedInput === normalizePrompt(testCase.prompt);
    const near = nearMatchers[testCase.id]?.some((matcher) => matcher.test(inputText)) === true;
    if (!exact && !near) continue;

    const content = testCase.target_rewrites.find((candidate) => candidatePasses(testCase, candidate));
    if (!content) continue;

    return {
      ok: true,
      caseId: testCase.id,
      prompt: testCase.prompt,
      content,
      source: "mira.voice_lab.v0",
      match: exact ? "exact" : "near",
    };
  }

  return null;
}
