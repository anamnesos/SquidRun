import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateRootReadiness } from "./state-root.js";

export type WorkDraftInput = {
  text?: string;
  kind?: string;
  sessionId?: string | null;
  messageId?: string | null;
  source?: string | null;
};

export type WorkDraftResult = {
  ok: true;
  protocol: "mira.work_draft.v0";
  id: string;
  kind: "customer_reply";
  status: "pending_review";
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  externalSend: false;
  runtimeExecutesExternalAction: false;
  reviewRequired: true;
  preview: string;
};

export type WorkDraftListResult = {
  ok: true;
  protocol: "mira.work_draft_list.v0";
  stateRootPath: string | null;
  draftCount: number;
  drafts: Array<{
    id: string;
    kind: "customer_reply";
    status: "pending_review";
    relativePath: string;
    absolutePath: string;
    createdAt: string | null;
    preview: string;
  }>;
  externalSend: false;
  runtimeExecutesExternalAction: false;
};

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "draft";
}

function buildDraftMarkdown(input: {
  id: string;
  text: string;
  createdAt: string;
  sessionId: string | null;
  messageId: string | null;
  source: string;
}): string {
  return [
    "---",
    "schema: mira.work_draft.v0",
    `id: ${input.id}`,
    "kind: customer_reply",
    "status: pending_review",
    `created_at: ${input.createdAt}`,
    `source: ${input.source}`,
    `session_id: ${input.sessionId || ""}`,
    `message_id: ${input.messageId || ""}`,
    "external_send: false",
    "runtime_executes_external_action: false",
    "review_required: true",
    "---",
    "",
    "# Customer Reply Draft",
    "",
    "## Request",
    input.text,
    "",
    "## Draft",
    "Thanks for reaching out. I’m looking at this now and will make sure the next reply is accurate before anything is sent.",
    "",
    "What I have so far:",
    `- ${input.text}`,
    "",
    "Before this goes out, I need to confirm the exact names, dates, amounts, attachments, and any promises we are making.",
    "",
    "## Review Checklist",
    "- Confirm facts against the source conversation or document.",
    "- Remove placeholders and vague claims.",
    "- Decide whether this should be sent, edited, or discarded.",
    "",
  ].join("\n");
}

function parseFrontMatter(markdown: string): Record<string, string> {
  if (!markdown.startsWith("---\n")) return {};
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return {};
  return markdown.slice(4, end)
    .split(/\r?\n/)
    .reduce<Record<string, string>>((acc, line) => {
      const separator = line.indexOf(":");
      if (separator < 0) return acc;
      acc[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      return acc;
    }, {});
}

function getDraftsDir(rootPath: string): string {
  return path.resolve(rootPath, "work", "drafts");
}

export function createWorkDraft(input: WorkDraftInput = {}, env: NodeJS.ProcessEnv = process.env): WorkDraftResult {
  const text = String(input.text || "").trim();
  if (!text) {
    throw Object.assign(new Error("Work draft text cannot be empty."), { code: "empty_work_draft_text" });
  }

  const kind = String(input.kind || "customer_reply").trim();
  if (kind !== "customer_reply") {
    throw Object.assign(new Error("Only customer_reply work drafts are supported in v0."), { code: "unsupported_work_draft_kind" });
  }

  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before work drafts can be written."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  const draftsDir = getDraftsDir(rootPath);
  if (!isInside(rootPath, draftsDir)) {
    throw Object.assign(new Error("Work draft destination escaped Mira state root."), { code: "unsafe_work_draft_path" });
  }

  const createdAt = new Date().toISOString();
  const id = `work-draft-${createdAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const fileName = `${id}-${slugify(text)}.md`;
  const absolutePath = path.resolve(draftsDir, fileName);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Work draft file escaped Mira state root."), { code: "unsafe_work_draft_path" });
  }

  const markdown = buildDraftMarkdown({
    id,
    text,
    createdAt,
    sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
    messageId: typeof input.messageId === "string" ? input.messageId : null,
    source: typeof input.source === "string" && input.source.trim() ? input.source.trim() : "runtime-ui",
  });

  fs.mkdirSync(draftsDir, { recursive: true });
  const handle = fs.openSync(absolutePath, "wx");
  try {
    fs.writeFileSync(handle, markdown, "utf8");
  } finally {
    fs.closeSync(handle);
  }

  return {
    ok: true,
    protocol: "mira.work_draft.v0",
    id,
    kind: "customer_reply",
    status: "pending_review",
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    externalSend: false,
    runtimeExecutesExternalAction: false,
    reviewRequired: true,
    preview: markdown,
  };
}

export function listWorkDrafts(env: NodeJS.ProcessEnv = process.env): WorkDraftListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.work_draft_list.v0",
      stateRootPath: stateRoot.path,
      draftCount: 0,
      drafts: [],
      externalSend: false,
      runtimeExecutesExternalAction: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const draftsDir = getDraftsDir(rootPath);
  if (!isInside(rootPath, draftsDir) || !fs.existsSync(draftsDir)) {
    return {
      ok: true,
      protocol: "mira.work_draft_list.v0",
      stateRootPath: rootPath,
      draftCount: 0,
      drafts: [],
      externalSend: false,
      runtimeExecutesExternalAction: false,
    };
  }

  const drafts = fs.readdirSync(draftsDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => {
      const absolutePath = path.resolve(draftsDir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      const markdown = fs.readFileSync(absolutePath, "utf8");
      const meta = parseFrontMatter(markdown);
      return {
        id: meta.id || path.basename(fileName, ".md"),
        kind: "customer_reply" as const,
        status: "pending_review" as const,
        relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
        absolutePath,
        createdAt: meta.created_at || null,
        preview: markdown.slice(0, 800),
      };
    })
    .filter((draft): draft is NonNullable<typeof draft> => Boolean(draft))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));

  return {
    ok: true,
    protocol: "mira.work_draft_list.v0",
    stateRootPath: rootPath,
    draftCount: drafts.length,
    drafts,
    externalSend: false,
    runtimeExecutesExternalAction: false,
  };
}
