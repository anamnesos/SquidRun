import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateRootReadiness } from "./state-root.js";
import { buildWorkDraftActionToken } from "./work-draft.js";

export type WorkTaskInput = {
  sourceDraftId?: string;
  sourceDraftPath?: string;
  sourceDraftToken?: string;
  sessionId?: string | null;
  messageId?: string | null;
  source?: string | null;
};

export type WorkTaskStatus = "pending_review" | "approved" | "rejected" | "edited";
export type WorkTaskReviewDecision = "approve" | "reject" | "edit";

export type WorkTaskResult = {
  ok: true;
  protocol: "mira.work_task.v0";
  id: string;
  kind: "draft_intake_task";
  status: WorkTaskStatus;
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
  displayTitle: string;
  taskPreview: string;
  checklistPreview: string;
};

export type WorkTaskListResult = {
  ok: true;
  protocol: "mira.work_task_list.v0";
  stateRootPath: string | null;
  taskCount: number;
  pendingCount: number;
  reviewedCount: number;
  tasks: Array<{
    actionToken: string;
    status: WorkTaskStatus;
    createdAt: string | null;
    reviewedAt: string | null;
    preview: string;
    displayTitle: string;
    taskPreview: string;
    checklistPreview: string;
    sourceDraftLinked: boolean;
    id?: string;
    kind?: "draft_intake_task";
    relativePath?: string;
    absolutePath?: string;
    sourceDraftId?: string | null;
    sourceDraftRelativePath?: string | null;
    sourceDraftSha256?: string | null;
  }>;
  externalSend: false;
  crmMutation: false;
  runtimeExecutesExternalAction: false;
};

export type WorkTaskReviewDetailResult = {
  ok: true;
  protocol: "mira.work_task_review_detail.v0";
  task: {
    actionToken: string;
    status: WorkTaskStatus;
    createdAt: string | null;
    reviewedAt: string | null;
    displayTitle: string;
    taskPreview: string;
    checklistPreview: string;
    preview: string;
  };
  linkedDraft: {
    displayTitle: string;
    requestPreview: string;
    draftPreview: string;
    editableDraft: string;
  } | null;
  review: WorkTaskReviewRecord | null;
  externalSend: false;
  crmMutation: false;
  runtimeExecutesExternalAction: false;
};

export type WorkTaskReviewRecord = {
  protocol: "mira.work_task_review.v0";
  reviewId: string;
  taskId: string;
  taskToken: string;
  decision: WorkTaskReviewDecision;
  status: WorkTaskStatus;
  reviewedAt: string;
  note: string | null;
  editedDraftText: string | null;
  externalSend: false;
  crmMutation: false;
  runtimeExecutesExternalAction: false;
};

export type WorkTaskReviewResult = {
  ok: true;
  protocol: "mira.work_task_review_write.v0";
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  review: WorkTaskReviewRecord;
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

export function buildWorkTaskActionToken(id: string): string {
  return `task-${crypto.createHash("sha256").update(`mira.work_task.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function extractSection(markdown: string, heading: string): string {
  const pattern = new RegExp(`^## ${heading}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`, "m");
  return markdown.match(pattern)?.[1]?.trim() || "";
}

function previewSection(value: string, maxLength = 260): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function stripFrontMatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---", 4);
  return end < 0 ? markdown : markdown.slice(end + 4);
}

function stripMarkdownJunk(value: string): string {
  const frontMatterKey = /^(schema|id|kind|status|created_at|source|session_id|message_id|source_draft_id|source_draft_relative_path|source_draft_sha256|external_send|crm_mutation|runtime_executes_external_action|review_required):\s*/i;
  return value
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed === "---") return false;
      if (frontMatterKey.test(trimmed)) return false;
      if (/^-\s*(id|path|sha256):\s*/i.test(trimmed)) return false;
      if (/^#{1,6}\s+/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function buildTaskDisplay(markdown: string): { displayTitle: string; taskPreview: string; checklistPreview: string; preview: string } {
  const task = previewSection(extractSection(markdown, "Task"));
  const checklist = previewSection(extractSection(markdown, "Checklist"));
  const fallback = previewSection(stripMarkdownJunk(stripFrontMatter(markdown)));
  const taskPreview = task || fallback;
  const checklistPreview = checklist;
  const preview = [
    taskPreview ? `Task: ${taskPreview}` : null,
    checklistPreview ? `Checklist: ${checklistPreview}` : null,
  ].filter(Boolean).join("\n");
  return {
    displayTitle: "Review task",
    taskPreview,
    checklistPreview,
    preview,
  };
}

function getTasksDir(rootPath: string): string {
  return path.resolve(rootPath, "work", "tasks");
}

function getDraftsDir(rootPath: string): string {
  return path.resolve(rootPath, "work", "drafts");
}

function getReviewsDir(rootPath: string): string {
  return path.resolve(rootPath, "work", "reviews");
}

function statusFromDecision(decision: WorkTaskReviewDecision): WorkTaskStatus {
  if (decision === "approve") return "approved";
  if (decision === "reject") return "rejected";
  return "edited";
}

function normalizeDecision(value: unknown): WorkTaskReviewDecision {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved") return "approve";
  if (normalized === "reject" || normalized === "rejected") return "reject";
  if (normalized === "edit" || normalized === "edited") return "edit";
  throw Object.assign(new Error("Review decision must be approve, reject, or edit."), { code: "invalid_review_decision" });
}

function parseReviewRecord(value: string): WorkTaskReviewRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<WorkTaskReviewRecord>;
    if (parsed.protocol !== "mira.work_task_review.v0" || typeof parsed.taskId !== "string") return null;
    if (!["approve", "reject", "edit"].includes(String(parsed.decision))) return null;
    if (!["approved", "rejected", "edited"].includes(String(parsed.status))) return null;
    return parsed as WorkTaskReviewRecord;
  } catch {
    return null;
  }
}

function listReviewRecords(rootPath: string): WorkTaskReviewRecord[] {
  const reviewsDir = getReviewsDir(rootPath);
  if (!isInside(rootPath, reviewsDir) || !fs.existsSync(reviewsDir)) return [];
  return fs.readdirSync(reviewsDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(reviewsDir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseReviewRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is WorkTaskReviewRecord => Boolean(record))
    .sort((left, right) => String(right.reviewedAt || "").localeCompare(String(left.reviewedAt || "")));
}

function latestReviewByTask(rootPath: string): Map<string, WorkTaskReviewRecord> {
  const records = listReviewRecords(rootPath);
  const map = new Map<string, WorkTaskReviewRecord>();
  for (const record of records) {
    if (!map.has(record.taskId)) map.set(record.taskId, record);
  }
  return map;
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
    const sourceDraftToken = String(input.sourceDraftToken || "").trim();
    if (!sourceDraftId && !sourceDraftToken) {
      throw Object.assign(new Error("sourceDraftId, sourceDraftToken, or sourceDraftPath is required."), { code: "missing_source_draft" });
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
        const id = parseFrontMatter(markdown).id || path.basename(candidatePath, ".md");
        return sourceDraftId ? id === sourceDraftId : buildWorkDraftActionToken(id) === sourceDraftToken;
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

function resolveTask(input: { taskToken?: string; taskId?: string }, rootPath: string): {
  id: string;
  relativePath: string;
  absolutePath: string;
  markdown: string;
  meta: Record<string, string>;
} {
  const tasksDir = getTasksDir(rootPath);
  const taskToken = String(input.taskToken || "").trim();
  const taskId = String(input.taskId || "").trim();
  if (!taskToken && !taskId) {
    throw Object.assign(new Error("taskToken or taskId is required."), { code: "missing_work_task" });
  }
  if (!fs.existsSync(tasksDir)) {
    throw Object.assign(new Error("No work tasks exist in Mira state root."), { code: "work_task_not_found" });
  }
  const absolutePath = fs.readdirSync(tasksDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => path.resolve(tasksDir, fileName))
    .find((candidatePath) => {
      if (!isInside(rootPath, candidatePath)) return false;
      const markdown = fs.readFileSync(candidatePath, "utf8");
      const id = parseFrontMatter(markdown).id || path.basename(candidatePath, ".md");
      return taskId ? id === taskId : buildWorkTaskActionToken(id) === taskToken;
    });
  if (!absolutePath || !isInside(rootPath, absolutePath) || !isInside(tasksDir, absolutePath)) {
    throw Object.assign(new Error("Work task was not found inside Mira state root."), { code: "work_task_not_found" });
  }
  const markdown = fs.readFileSync(absolutePath, "utf8");
  const meta = parseFrontMatter(markdown);
  if (meta.schema !== "mira.work_task.v0") {
    throw Object.assign(new Error("Source file is not a Mira work task."), { code: "invalid_work_task" });
  }
  return {
    id: meta.id || path.basename(absolutePath, ".md"),
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    markdown,
    meta,
  };
}

function resolveLinkedDraftFromTask(task: { meta: Record<string, string> }, rootPath: string): {
  requestPreview: string;
  draftPreview: string;
  editableDraft: string;
} | null {
  const relativePath = String(task.meta.source_draft_relative_path || "").trim();
  const expectedSha = String(task.meta.source_draft_sha256 || "").trim();
  if (!relativePath) return null;
  const draftsDir = getDraftsDir(rootPath);
  const absolutePath = path.resolve(rootPath, relativePath);
  if (!isInside(rootPath, absolutePath) || !isInside(draftsDir, absolutePath) || !fs.existsSync(absolutePath)) return null;
  const markdown = fs.readFileSync(absolutePath, "utf8");
  if (expectedSha && crypto.createHash("sha256").update(markdown, "utf8").digest("hex") !== expectedSha) return null;
  const requestPreview = previewSection(extractSection(markdown, "Request"), 1200);
  const draftPreview = previewSection(extractSection(markdown, "Draft"), 3000);
  return {
    requestPreview,
    draftPreview,
    editableDraft: extractSection(markdown, "Draft") || draftPreview,
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

  const display = buildTaskDisplay(markdown);
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
    preview: display.preview,
    displayTitle: display.displayTitle,
    taskPreview: display.taskPreview,
    checklistPreview: display.checklistPreview,
  };
}

export function listWorkTasks(env: NodeJS.ProcessEnv = process.env, options: { includeInternal?: boolean } = {}): WorkTaskListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.work_task_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      taskCount: 0,
      pendingCount: 0,
      reviewedCount: 0,
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
      stateRootPath: options.includeInternal ? rootPath : null,
      taskCount: 0,
      pendingCount: 0,
      reviewedCount: 0,
      tasks: [],
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
    };
  }

  const reviewMap = latestReviewByTask(rootPath);
  const tasks = fs.readdirSync(tasksDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => {
      const absolutePath = path.resolve(tasksDir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      const markdown = fs.readFileSync(absolutePath, "utf8");
      const meta = parseFrontMatter(markdown);
      const display = buildTaskDisplay(markdown);
      const id = meta.id || path.basename(fileName, ".md");
      const review = reviewMap.get(id) || null;
      const item = {
        actionToken: buildWorkTaskActionToken(id),
        status: review?.status || "pending_review" as WorkTaskStatus,
        createdAt: meta.created_at || null,
        reviewedAt: review?.reviewedAt || null,
        preview: display.preview,
        displayTitle: display.displayTitle,
        taskPreview: display.taskPreview,
        checklistPreview: display.checklistPreview,
        sourceDraftLinked: Boolean(meta.source_draft_id),
      };
      if (!options.includeInternal) return item;
      return {
        ...item,
        id,
        kind: "draft_intake_task" as const,
        relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
        absolutePath,
        sourceDraftId: meta.source_draft_id || null,
        sourceDraftRelativePath: meta.source_draft_relative_path || null,
        sourceDraftSha256: meta.source_draft_sha256 || null,
      };
    })
    .filter((task): task is NonNullable<typeof task> => Boolean(task))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const pendingCount = tasks.filter((task) => task.status === "pending_review").length;

  return {
    ok: true,
    protocol: "mira.work_task_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    taskCount: tasks.length,
    pendingCount,
    reviewedCount: tasks.length - pendingCount,
    tasks,
    externalSend: false,
    crmMutation: false,
    runtimeExecutesExternalAction: false,
  };
}

export function getWorkTaskReviewDetail(input: { taskToken?: string; taskId?: string }, env: NodeJS.ProcessEnv = process.env): WorkTaskReviewDetailResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before work tasks can be read."), {
      code: "state_root_not_ready",
    });
  }
  const rootPath = path.resolve(stateRoot.path);
  const task = resolveTask(input, rootPath);
  const display = buildTaskDisplay(task.markdown);
  const review = latestReviewByTask(rootPath).get(task.id) || null;
  const linkedDraft = resolveLinkedDraftFromTask(task, rootPath);
  return {
    ok: true,
    protocol: "mira.work_task_review_detail.v0",
    task: {
      actionToken: buildWorkTaskActionToken(task.id),
      status: review?.status || "pending_review",
      createdAt: task.meta.created_at || null,
      reviewedAt: review?.reviewedAt || null,
      displayTitle: display.displayTitle,
      taskPreview: display.taskPreview,
      checklistPreview: display.checklistPreview,
      preview: display.preview,
    },
    linkedDraft: linkedDraft ? {
      displayTitle: "Linked draft",
      requestPreview: linkedDraft.requestPreview,
      draftPreview: linkedDraft.draftPreview,
      editableDraft: linkedDraft.editableDraft,
    } : null,
    review,
    externalSend: false,
    crmMutation: false,
    runtimeExecutesExternalAction: false,
  };
}

export function createWorkTaskReview(input: {
  taskToken?: string;
  taskId?: string;
  decision?: unknown;
  editedDraftText?: string | null;
  note?: string | null;
}, env: NodeJS.ProcessEnv = process.env): WorkTaskReviewResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before work review can be written."), {
      code: "state_root_not_ready",
    });
  }
  const rootPath = path.resolve(stateRoot.path);
  const task = resolveTask(input, rootPath);
  const decision = normalizeDecision(input.decision);
  const editedDraftText = typeof input.editedDraftText === "string" ? input.editedDraftText.trim() : "";
  if (decision === "edit" && !editedDraftText) {
    throw Object.assign(new Error("Edited draft text is required for edit decisions."), { code: "empty_review_edit" });
  }
  const reviewsDir = getReviewsDir(rootPath);
  if (!isInside(rootPath, reviewsDir)) {
    throw Object.assign(new Error("Work review destination escaped Mira state root."), { code: "unsafe_work_review_path" });
  }
  const reviewedAt = new Date().toISOString();
  const reviewId = `work-review-${reviewedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const absolutePath = path.resolve(reviewsDir, `${reviewId}-${slugify(task.id)}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Work review file escaped Mira state root."), { code: "unsafe_work_review_path" });
  }
  const record: WorkTaskReviewRecord = {
    protocol: "mira.work_task_review.v0",
    reviewId,
    taskId: task.id,
    taskToken: buildWorkTaskActionToken(task.id),
    decision,
    status: statusFromDecision(decision),
    reviewedAt,
    note: typeof input.note === "string" && input.note.trim() ? input.note.trim() : null,
    editedDraftText: editedDraftText || null,
    externalSend: false,
    crmMutation: false,
    runtimeExecutesExternalAction: false,
  };
  fs.mkdirSync(reviewsDir, { recursive: true });
  const handle = fs.openSync(absolutePath, "wx");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(handle);
  }
  return {
    ok: true,
    protocol: "mira.work_task_review_write.v0",
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    review: record,
    externalSend: false,
    crmMutation: false,
    runtimeExecutesExternalAction: false,
  };
}
