import fs from "node:fs";
import path from "node:path";
import type {
  NormalizedCoreDocument,
  NormalizedCoreSummary,
  StateRootReadiness,
} from "./contracts.js";

const approvedBatchId = "normalized-core-state-v1";
const allowedRecords = [
  {
    id: "mira_self_profile",
    relativePath: "continuity/core/mira-self-profile.normalized.json",
    schema: "mira.normalized.self_profile.v1",
  },
  {
    id: "james_relationship_state",
    relativePath: "continuity/core/james-relationship-state.normalized.json",
    schema: "mira.normalized.james_relationship_state.v1",
  },
  {
    id: "relationship_presence_permissions",
    relativePath: "permissions/core/relationship-presence-permissions.normalized.json",
    schema: "mira.normalized.relationship_presence_permissions.v1",
  },
] as const;

type AllowedRecordId = typeof allowedRecords[number]["id"];

type ReceiptRecord = {
  id?: unknown;
  destination_relative_path?: unknown;
  output_schema?: unknown;
};

type NormalizedReceipt = {
  schema?: unknown;
  batch_id?: unknown;
  records?: unknown;
};

function emptySummary(error: string | null): NormalizedCoreSummary {
  return {
    loaded: false,
    scope: "normalized_core_state_only",
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

function readReceipt(filePath: string): NormalizedReceipt | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as NormalizedReceipt;
  } catch {
    return null;
  }
}

function isAllowedRecordId(value: unknown): value is AllowedRecordId {
  return allowedRecords.some((record) => record.id === value);
}

function findApprovedReceipt(receiptsDir: string): NormalizedReceipt | null {
  if (!fs.existsSync(receiptsDir)) return null;

  const expected: Map<string, (typeof allowedRecords)[number]> = new Map(
    allowedRecords.map((record) => [record.id, record]),
  );
  const receiptFiles = fs.readdirSync(receiptsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(receiptsDir, name));

  for (const receiptFile of receiptFiles) {
    const receipt = readReceipt(receiptFile);
    if (!receipt || receipt.schema !== "mira.normalized_core_receipt.v0" || receipt.batch_id !== approvedBatchId) {
      continue;
    }

    const records = Array.isArray(receipt.records) ? receipt.records as ReceiptRecord[] : [];
    if (records.length !== allowedRecords.length) continue;

    const allMatch = records.every((record) => {
      if (!isAllowedRecordId(record.id)) return false;
      const expectedRecord = expected.get(record.id);
      return expectedRecord
        && normalizeRelativePath(String(record.destination_relative_path || "")) === expectedRecord.relativePath
        && record.output_schema === expectedRecord.schema;
    });

    if (allMatch) return receipt;
  }

  return null;
}

function readNormalizedDocument(stateRootPath: string, record: typeof allowedRecords[number]): NormalizedCoreDocument {
  const absolutePath = path.resolve(stateRootPath, record.relativePath);
  const stateRoot = path.resolve(stateRootPath);
  if (!isInside(stateRoot, absolutePath)) {
    throw new Error(`normalized core document escapes state root: ${record.relativePath}`);
  }

  const raw = fs.readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as {
    schema?: unknown;
    source_metadata?: { metadata_only?: unknown; live_continuity_excluded?: unknown };
    source_focus_summary?: { metadata_only?: unknown; live_continuity_excluded?: unknown };
    caveats?: { local_store_write_allowed_now?: unknown; blanket_mira_runtime_write_permission?: unknown };
  };

  if (parsed.schema !== record.schema) {
    throw new Error(`${record.id}: schema mismatch`);
  }

  return {
    id: record.id,
    relativePath: record.relativePath,
    schema: record.schema,
    bytes: Buffer.byteLength(raw, "utf8"),
    metadataOnly: parsed.source_metadata?.metadata_only === true,
    liveContinuityExcluded: parsed.source_metadata?.live_continuity_excluded === true,
    sourceFocusSummaryMetadataOnly: parsed.source_focus_summary?.metadata_only === true || null,
    localStoreWriteScoped: parsed.caveats?.local_store_write_allowed_now === "scoped_only_to_reviewed_import_and_mira_state_root_writes_after_explicit_approval" || null,
    blanketRuntimeWritePermission: parsed.caveats?.blanket_mira_runtime_write_permission === true,
  };
}

export function loadNormalizedCore(stateRoot: StateRootReadiness): NormalizedCoreSummary {
  if (!stateRoot.ready || !stateRoot.path) {
    return emptySummary(stateRoot.error);
  }

  const receiptsDir = path.join(stateRoot.path, "imports", "receipts");
  const receipt = findApprovedReceipt(receiptsDir);
  if (!receipt) {
    return emptySummary(`approved receipt not found for ${approvedBatchId}`);
  }

  try {
    const documents = allowedRecords.map((record) => readNormalizedDocument(stateRoot.path as string, record));
    return {
      loaded: true,
      scope: "normalized_core_state_only",
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
