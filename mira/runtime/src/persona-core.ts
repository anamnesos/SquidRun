import fs from "node:fs";
import path from "node:path";
import type { StateRootReadiness } from "./contracts.js";

export type PersonaCore = {
  loaded: boolean;
  schema: "mira.runtime_persona_core.v0";
  name: string;
  traits: string[];
  tendencies: string[];
  style: string[];
  relationshipPosture: string | null;
  safetyGates: string[];
  source: {
    stateRootReady: boolean;
    metadataOnly: true;
    liveContinuityExcluded: true;
    relativePaths: string[];
  };
};

function emptyCore(stateRoot: StateRootReadiness): PersonaCore {
  return {
    loaded: false,
    schema: "mira.runtime_persona_core.v0",
    name: "Mira",
    traits: ["present", "direct", "curious"],
    tendencies: [
      "answer from the current thread instead of reciting runtime internals",
      "use loaded context as background, not as an identity script",
    ],
    style: ["plain", "human-scale", "specific"],
    relationshipPosture: null,
    safetyGates: ["external actions, tool use, data mutation, and customer contact stay gated"],
    source: {
      stateRootReady: stateRoot.ready,
      metadataOnly: true,
      liveContinuityExcluded: true,
      relativePaths: [],
    },
  };
}

function readJsonIfInside(stateRootPath: string, relativePath: string): Record<string, unknown> | null {
  const stateRoot = path.resolve(stateRootPath);
  const absolutePath = path.resolve(stateRoot, relativePath);
  const relative = path.relative(stateRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    if (normalized) return normalized;
  }
  return null;
}

export function loadPersonaCore(stateRoot: StateRootReadiness): PersonaCore {
  const base = emptyCore(stateRoot);
  if (!stateRoot.ready || !stateRoot.path) return base;

  const selfPath = "continuity/core/mira-self-profile.normalized.json";
  const relationshipPath = "continuity/core/james-relationship-state.normalized.json";
  const selfProfile = readJsonIfInside(stateRoot.path, selfPath);
  const relationship = readJsonIfInside(stateRoot.path, relationshipPath);
  if (!selfProfile && !relationship) return base;

  const relationshipPosture = firstString(
    relationship?.what_mira_knows_about_james,
    (relationship?.source_focus_summary as Record<string, unknown> | undefined)?.value,
  );
  const traits = [
    ...stringList(selfProfile?.expressive_range_allowed),
    "present",
    "direct",
    "context-aware",
  ];
  const tendencies = [
    ...stringList(relationship?.preferences).slice(0, 5),
    "business and workflow context are capabilities, not Mira's identity",
    "answer from persona and context instead of runtime labels",
  ];

  return {
    loaded: true,
    schema: "mira.runtime_persona_core.v0",
    name: firstString(selfProfile?.name) || "Mira",
    traits: [...new Set(traits)].slice(0, 12),
    tendencies: [...new Set(tendencies)].slice(0, 8),
    style: [
      "plain",
      "alive without performing",
      "specific to the moment",
      "comfortable with disagreement",
      "not a CRM or business-bot self-introduction",
    ],
    relationshipPosture,
    safetyGates: [
      "external sends",
      "tool execution",
      "data mutation",
      "customer contact",
      "deploy/trade/network action",
    ],
    source: {
      stateRootReady: true,
      metadataOnly: true,
      liveContinuityExcluded: true,
      relativePaths: [selfProfile ? selfPath : null, relationship ? relationshipPath : null].filter(Boolean) as string[],
    },
  };
}

export function formatPersonaCoreForPrompt(personaCore: PersonaCore): string {
  return [
    `Name: ${personaCore.name}`,
    `Traits: ${personaCore.traits.join(", ") || "present, direct, curious"}`,
    `Style: ${personaCore.style.join(", ")}`,
    personaCore.relationshipPosture ? `Relationship posture: ${personaCore.relationshipPosture}` : null,
    `Tendencies: ${personaCore.tendencies.join(" | ")}`,
    `Action safety gates: ${personaCore.safetyGates.join(", ")}`,
  ].filter(Boolean).join("\n");
}
