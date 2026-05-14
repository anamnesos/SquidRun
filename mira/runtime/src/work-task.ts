import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateRootReadiness } from "./state-root.js";

export type WorkTaskInput = {
  sourceDraftId?: string;
  sourceDraftPath?: string;
  sessionId?: string | null;
  messageId?: string | null;
  source?: string | null;
};

export type WorkTaskResult = {
  ok: true;
  protocol: "mira.work_task.v0";
  id: string;
  kind: "draft_intake_task";
  status: "pending_review";
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  sourceDraftId: string;
  sourceDraftRelativePath: string;
  sourceDraftSha256: string;
  externalSend: false;
  crmMutation: false;
  runtimeExecutesExternalAction: false;
  reviewRequired: true;
  preview: string;
};

export type WorkTaskListResult = {
  ok: true;
  protocol: "mira.work_task_list.v0";
  stateRootPath: string | null;
  taskCount: number;
  tasks: Array<{
    id: string;
    kind: "draft_intake_task";
    status: "pending_review";
    relativePath: string;
    absolutePath: string;
    sourceDraftId: string | null;
    sourceDraftRelativePath: string | null;
    sourceDraftSha256: string | null;
    createdAt: string | null;
    preview: string;
  }>;
  externalSend: false;
  crmMutation: false;
  runtimeExecutesExternalAction: false;
};

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

function extractSection(markdown: string, heading: string): string {
  const pattern = new RegExp(`^## ${heading}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`, "m");
  return markdown.match(pattern)?.[1]?.trim() || "";
}

function getTasksDir(rootPath: string): string {
  return path.resolve(rootPath, "work", "tasks");
}

function getDraftsDir(rootPath: string): string {
  return path.resolve(rootPath, "work", "drafts");
}

function resolveDraft(input: WorkTaskInput, rootPath: string): {
  id: string;
  relativePath: string;
  absolutePath: string;
  markdown: string;
  sha256: string;
} {
  const draftsDir = getDraftsDir(rootPath);
  let absolutePath: string | null = null;
  const requestedPath = String(input.sourceDraftPath || "").trim();
  if (requestedPath) {
    absolutePath = path.resolve(rootPath, requestedPath);
  } else {
    const sourceDraftId = String(input.sourceDraftId || "").trim();
    if (!sourceDraftId) {
      throw Object.assign(new Error("sourceDraftId or sourceDraftPath is required."), { code: "missing_source_draft" });
    }
    if (!fs.existsSync(draftsDir)) {
      throw Object.assign(new Error("No work drafts exist in Mira state root."), { code: "source_draft_not_found" });
    }
    const found = fs.readdirSync(draftsDir)
      .filter((fileName) => fileName.endsWith(".md"))
      .map((fileName) => path.resolve(draftsDir, fileName))
      .find((candidatePath) => {
        if (!isInside(rootPath, candidatePath)) return false;
        const markdown = fs.readFileSync(candidatePath, "utf8");
        return parseFrontMatter(markdown).id === sourceDraftId;
      });
    absolutePath = found || null;
  }

  if (!absolutePath || !isInside(rootPath, absolutePath) || !isInside(draftsDir, absolutePath) || !fs.existsSync(absolutePath)) {
    throw Object.assign(new Error("Source draft was not found inside Mira work drafts."), { code: "source_draft_not_found" });
  }

  const markdown = fs.readFileSync(absolutePath, "utf8");
  const meta = parseFrontMatter(markdown);
  if (meta.schema !== "mira.work_draft.v0") {
    throw Object.assign(new Error("Source file is not a Mira work draft."), { code: "invalid_source_draft" });
  }
  return {
    id: meta.id || path.basename(absolutePath, ".md"),
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    markdown,
    sha256: crypto.createHash("sha256").update(markdown, "utf8").digest("hex"),
  };
}

function buildTaskMarkdown(input: {
  id: string;
  createdAt: string;
  source: string;
  sessionId: string | null;
  messageId: string | null;
  draftId: string;
  draftRelativePath: string;
  draftSha256: string;
  request: string;
}): string {
  return [
    "---",
    "schema: mira.work_task.v0",
    `id: ${input.id}`,
    "kind: draft_intake_task",
    "status: pending_review",
    `created_at: ${input.createdAt}`,
    `source: ${input.source}`,
    `session_id: ${input.sessionId || ""}`,
    `message_id: ${input.messageId || ""}`,
    `source_draft_id: ${input.draftId}`,
    `source_draft_relative_path: ${input.draftRelativePath}`,
    `source_draft_sha256: ${input.draftSha256}`,
    "external_send: false",
    "crm_mutation: false",
    "runtime_executes_external_action: false",
    "review_required: true",
    "---",
    "",
    "# Draft Intake Task",
    "",
    "## Source Draft",
    `- id: ${input.draftId}`,
    `- path: ${input.draftRelativePath}`,
    `- sha256: ${input.draftSha256}`,
    "",
    "## Task",
    input.request || "Review the source draft and decide the next safe action.",
    "",
    "## Checklist",
    "- Read the linked draft.",
    "- Confirm the customer/work request and missing facts.",
    "- Decide whether the draft should be edited, sent manually, split into more tasks, or discarded.",
    "- Do not send externally or mutate CRM from this task.",
    "",
  ].join("\n");
}

export function createWorkTaskFromDraft(input: WorkTaskInput = {}, env: NodeJS.ProcessEnv = process.env): WorkTaskResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before work tasks can be written."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  const draft = resolveDraft(input, rootPath);
  const tasksDir = getTasksDir(rootPath);
  if (!isInside(rootPath, tasksDir)) {
    throw Object.assign(new Error("Work task destination escaped Mira state root."), { code: "unsafe_work_task_path" });
  }

  const createdAt = new Date().toISOString();
  const id = `work-task-${createdAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const request = extractSection(draft.markdown, "Request");
  const absolutePath = path.resolve(tasksDir, `${id}-${slugify(draft.id)}.md`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Work task file escaped Mira state root."), { code: "unsafe_work_task_path" });
  }

  const markdown = buildTaskMarkdown({
    id,
    createdAt,
    source: typeof input.source === "string" && input.source.trim() ? input.source.trim() : "runtime-ui",
    sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
    messageId: typeof input.messageId === "string" ? input.messageId : null,
    draftId: draft.id,
    draftRelativePath: draft.relativePath,
    draftSha256: draft.sha256,
    request,
  });

  fs.mkdirSync(tasksDir, { recursive: true });
  const handle = fs.openSync(absolutePath, "wx");
  try {
    fs.writeFileSync(handle, markdown, "utf8");
  } finally {
    fs.closeSync(handle);
  }

  return {
    ok: true,
    protocol: "mira.work_task.v0",
    id,
    kind: "draft_intake_task",
    status: "pending_review",
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    sourceDraftId: draft.id,
    sourceDraftRelativePath: draft.relativePath,
    sourceDraftSha256: draft.sha256,
    externalSend: false,
    crmMutation: false,
    runtimeExecutesExternalAction: false,
    reviewRequired: true,
    preview: markdown,
  };
}

export function listWorkTasks(env: NodeJS.ProcessEnv = process.env): WorkTaskListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.work_task_list.v0",
      stateRootPath: stateRoot.path,
      taskCount: 0,
      tasks: [],
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const tasksDir = getTasksDir(rootPath);
  if (!isInside(rootPath, tasksDir) || !fs.existsSync(tasksDir)) {
    return {
      ok: true,
      protocol: "mira.work_task_list.v0",
      stateRootPath: rootPath,
      taskCount: 0,
      tasks: [],
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
    };
  }

  const tasks = fs.readdirSync(tasksDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => {
      const absolutePath = path.resolve(tasksDir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      const markdown = fs.readFileSync(absolutePath, "utf8");
      const meta = parseFrontMatter(markdown);
      return {
        id: meta.id || path.basename(fileName, ".md"),
        kind: "draft_intake_task" as const,
        status: "pending_review" as const,
        relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
        absolutePath,
        sourceDraftId: meta.source_draft_id || null,
        sourceDraftRelativePath: meta.source_draft_relative_path || null,
        sourceDraftSha256: meta.source_draft_sha256 || null,
        createdAt: meta.created_at || null,
        preview: markdown.slice(0, 800),
      };
    })
    .filter((task): task is NonNullable<typeof task> => Boolean(task))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));

  return {
    ok: true,
    protocol: "mira.work_task_list.v0",
    stateRootPath: rootPath,
    taskCount: tasks.length,
    tasks,
    externalSend: false,
    crmMutation: false,
    runtimeExecutesExternalAction: false,
  };
}
