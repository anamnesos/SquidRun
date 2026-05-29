import path from "node:path";
import type { StateRootBucket, StateRootReadiness } from "./contracts.js";

export const requiredStateRootBuckets: StateRootBucket[] = [
  {
    id: "continuity",
    relativePath: "continuity",
    purpose: "Reviewed Mira continuity state after explicit import.",
  },
  {
    id: "conversation_evidence",
    relativePath: "conversation-evidence",
    purpose: "Reviewed transcript or eval evidence, not raw memory by default.",
  },
  {
    id: "permissions",
    relativePath: "permissions",
    purpose: "Mira-owned local presence and permission boundaries.",
  },
  {
    id: "acceptance",
    relativePath: "acceptance",
    purpose: "Mira product acceptance contracts.",
  },
  {
    id: "imports",
    relativePath: "imports",
    purpose: "Import receipts and reviewed migration metadata.",
  },
  {
    id: "bridge",
    relativePath: "bridge",
    purpose: "Mira-owned bridge receive/reply records and local parity evidence.",
  },
];

function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean);
}

function isInsideSquidRunPrivateRoot(resolvedPath: string): boolean {
  return pathSegments(resolvedPath).some((segment) => segment.toLowerCase() === ".squidrun");
}

export function getStateRootReadiness(env: NodeJS.ProcessEnv = process.env): StateRootReadiness {
  const rawRoot = env.MIRA_STATE_ROOT;

  if (!rawRoot || !rawRoot.trim()) {
    return {
      configured: false,
      ready: false,
      path: null,
      error: "MIRA_STATE_ROOT is required before Mira runtime state can be used.",
      requiredBuckets: requiredStateRootBuckets,
      importsLoaded: false,
    };
  }

  const resolvedRoot = path.resolve(rawRoot);
  if (isInsideSquidRunPrivateRoot(resolvedRoot)) {
    return {
      configured: true,
      ready: false,
      path: resolvedRoot,
      error: "MIRA_STATE_ROOT must not point inside .squidrun.",
      requiredBuckets: requiredStateRootBuckets,
      importsLoaded: false,
    };
  }

  return {
    configured: true,
    ready: true,
    path: resolvedRoot,
    error: null,
    requiredBuckets: requiredStateRootBuckets,
    importsLoaded: false,
  };
}
