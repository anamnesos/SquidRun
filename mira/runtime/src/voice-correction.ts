import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type VoiceCorrectionInput = {
  prompt: string;
  soundedFake: string;
  better: string;
  caseId?: string | null;
  source?: string;
  outPath?: string;
};

export type VoiceCorrectionCapture = {
  ok: true;
  protocol: "mira.voice_review_capture.v0";
  out_path: string;
  record: {
    schema: "mira.voice_review_candidate.v0";
    id: string;
    created_at: string;
    source: string;
    prompt: string;
    sounded_fake: string;
    better_phrasing: string;
    suggested_case_id: string | null;
    review_status: "pending_review";
    live_voice_mutated: false;
  };
  live_voice_mutated: false;
};

const defaultOutPath = path.join("mira", "voice", "review", "candidates.jsonl");

function normalizeText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function requireText(value: unknown, fieldName: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw Object.assign(new Error(`${fieldName} is required.`), { code: `missing_${fieldName}` });
  }
  return normalized;
}

export function captureVoiceCorrection(input: VoiceCorrectionInput, now = new Date()): VoiceCorrectionCapture {
  const outPath = input.outPath || process.env.MIRA_VOICE_REVIEW_PATH || defaultOutPath;
  const resolvedOutPath = path.resolve(outPath);
  const record: VoiceCorrectionCapture["record"] = {
    schema: "mira.voice_review_candidate.v0",
    id: `voice-review-${crypto.randomUUID()}`,
    created_at: now.toISOString(),
    source: normalizeText(input.source) || "runtime-ui",
    prompt: requireText(input.prompt, "prompt"),
    sounded_fake: requireText(input.soundedFake, "sounded_fake"),
    better_phrasing: requireText(input.better, "better"),
    suggested_case_id: input.caseId ? normalizeText(input.caseId) : null,
    review_status: "pending_review",
    live_voice_mutated: false,
  };

  fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  fs.appendFileSync(resolvedOutPath, `${JSON.stringify(record)}\n`, "utf8");

  return {
    ok: true,
    protocol: "mira.voice_review_capture.v0",
    out_path: resolvedOutPath,
    record,
    live_voice_mutated: false,
  };
}
