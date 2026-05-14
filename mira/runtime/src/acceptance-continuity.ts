import fs from "node:fs";
import path from "node:path";
import type {
  AcceptanceContinuityDocument,
  AcceptanceContinuitySummary,
  StateRootReadiness,
} from "./contracts.js";

const approvedBatchId = "acceptance-permission-contracts-v1";
const allowedRelativePaths = [
  "acceptance/mira-presence-runtime-acceptance-v0.md",
  "acceptance/mira-north-star-acceptance.md",
  "acceptance/mira-pc-embodiment-permission-v0.md",
] as const;

type ReceiptRecord = {
  destination_relative_path?: unknown;
};

type ImportReceipt = {
  schema?: unknown;
  batch_id?: unknown;
  records?: unknown;
};

function emptySummary(error: string | null): AcceptanceContinuitySummary {
  return {
    loaded: false,
    scope: "acceptance_docs_only",
    batchId: approvedBatchId,
    documentCount: 0,
    documents: [],
    continuityLoaded: false,
    runtimeSessionClaimAllowed: false,
    error,
  };
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function titleFromMarkdown(content: string): string | null {
  const heading = content.split(/\r?\n/).find((line) => /^#\s+\S/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : null;
}

function readReceipt(filePath: string): ImportReceipt | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ImportReceipt;
  } catch {
    return null;
  }
}

function findApprovedReceipt(receiptsDir: string): ImportReceipt | null {
  if (!fs.existsSync(receiptsDir)) return null;

  const allowedSet = new Set<string>(allowedRelativePaths);
  const receiptFiles = fs.readdirSync(receiptsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(receiptsDir, name));

  for (const receiptFile of receiptFiles) {
    const receipt = readReceipt(receiptFile);
    if (!receipt || receipt.schema !== "mira.import_receipt.v0" || receipt.batch_id !== approvedBatchId) {
      continue;
    }

    const receiptPaths = Array.isArray(receipt.records)
      ? receipt.records
        .map((record) => normalizeRelativePath(String((record as ReceiptRecord).destination_relative_path || "")))
        .filter(Boolean)
      : [];

    if (
      receiptPaths.length === allowedRelativePaths.length
      && receiptPaths.every((relativePath) => allowedSet.has(relativePath))
    ) {
      return receipt;
    }
  }

  return null;
}

function readAcceptanceDocument(stateRootPath: string, relativePath: string): AcceptanceContinuityDocument {
  const absolutePath = path.resolve(stateRootPath, relativePath);
  const acceptanceRoot = path.resolve(stateRootPath, "acceptance");
  if (!isInside(acceptanceRoot, absolutePath)) {
    throw new Error(`acceptance document escapes acceptance root: ${relativePath}`);
  }

  const content = fs.readFileSync(absolutePath, "utf8");
  return {
    relativePath,
    title: titleFromMarkdown(content),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

export function loadAcceptanceContinuity(stateRoot: StateRootReadiness): AcceptanceContinuitySummary {
  if (!stateRoot.ready || !stateRoot.path) {
    return emptySummary(stateRoot.error);
  }

  const receiptsDir = path.join(stateRoot.path, "imports", "receipts");
  const receipt = findApprovedReceipt(receiptsDir);
  if (!receipt) {
    return emptySummary(`approved receipt not found for ${approvedBatchId}`);
  }

  try {
    const documents = allowedRelativePaths.map((relativePath) => readAcceptanceDocument(stateRoot.path as string, relativePath));
    return {
      loaded: true,
      scope: "acceptance_docs_only",
      batchId: approvedBatchId,
      documentCount: documents.length,
      documents,
      continuityLoaded: false,
      runtimeSessionClaimAllowed: false,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptySummary(message);
  }
}
