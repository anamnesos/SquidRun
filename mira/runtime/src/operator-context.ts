import fs from "node:fs";
import path from "node:path";
import type { StateRootReadiness } from "./contracts.js";

export type OperatorContextSummary = {
  loaded: boolean;
  schema: "mira.normalized.operator_context.v1";
  relativePath: "context/operator/operator-context.normalized.json";
  metadataOnly: true;
  liveContinuityExcluded: true;
  businessThesis: string | null;
  operatingLanes: string[];
  knownProductLanes: string[];
  explicitNonClaims: string[];
  error: string | null;
};

type OperatorContextDocument = {
  schema?: unknown;
  business_thesis?: unknown;
  operating_lanes?: unknown;
  known_product_lanes?: unknown;
  explicit_non_claims?: unknown;
  source_metadata?: {
    metadata_only?: unknown;
    live_continuity_excluded?: unknown;
  };
};

const relativePath = "context/operator/operator-context.normalized.json";

function emptySummary(error: string | null): OperatorContextSummary {
  return {
    loaded: false,
    schema: "mira.normalized.operator_context.v1",
    relativePath,
    metadataOnly: true,
    liveContinuityExcluded: true,
    businessThesis: null,
    operatingLanes: [],
    knownProductLanes: [],
    explicitNonClaims: [],
    error,
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

export function loadOperatorContext(stateRoot: StateRootReadiness): OperatorContextSummary {
  if (!stateRoot.ready || !stateRoot.path) {
    return emptySummary(stateRoot.error);
  }

  const stateRootPath = path.resolve(stateRoot.path);
  const absolutePath = path.resolve(stateRootPath, relativePath);
  if (!isInside(stateRootPath, absolutePath)) {
    return emptySummary("operator context path escapes state root");
  }
  if (!fs.existsSync(absolutePath)) {
    return emptySummary(`operator context not found at ${relativePath}`);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as OperatorContextDocument;
    if (parsed.schema !== "mira.normalized.operator_context.v1") {
      return emptySummary("operator context schema mismatch");
    }
    if (parsed.source_metadata?.metadata_only !== true || parsed.source_metadata?.live_continuity_excluded !== true) {
      return emptySummary("operator context must remain metadata-only and live-continuity-excluded");
    }

    return {
      loaded: true,
      schema: "mira.normalized.operator_context.v1",
      relativePath,
      metadataOnly: true,
      liveContinuityExcluded: true,
      businessThesis: typeof parsed.business_thesis === "string" ? parsed.business_thesis : null,
      operatingLanes: asStringArray(parsed.operating_lanes),
      knownProductLanes: asStringArray(parsed.known_product_lanes),
      explicitNonClaims: asStringArray(parsed.explicit_non_claims),
      error: null,
    };
  } catch (error) {
    return emptySummary(error instanceof Error ? error.message : String(error));
  }
}
