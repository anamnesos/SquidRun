'use strict';

const fs = require('fs');
const path = require('path');
const {
  upsertArmRegistryManifest,
  evaluateArmRegistryReadiness,
  migrateArmRegistryManifestScope,
  buildCanonicalAppRoomSessionId,
} = require('./arm-registry');
const {
  getExampleAppDayToDayArmSpecs,
} = require('../exampleapp-arm-specs');

const EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA = 'squidrun.exampleapp_arm_registry_seed.v0';
const EXAMPLEAPP_APP_ROOM_ID = 'exampleapp';
const EXAMPLEAPP_PROPOSAL_SOURCE_REF = 'docs/exampleapp-arm-set-proposal.md';

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function toMs(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  return fallback;
}

function resolveProjectRoot(value = null) {
  return path.resolve(value || path.join(__dirname, '..', '..', '..'));
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveMainSessionId(options = {}) {
  const opts = asObject(options);
  const explicitMain = toOptionalString(opts.mainSessionId || opts.main_session_id, null);
  if (explicitMain) return explicitMain.replace(/:exampleapp$/i, '');

  const explicitSession = toOptionalString(opts.sessionId || opts.session_id || opts.sessionScopeId || opts.session_scope_id, null);
  if (explicitSession) return explicitSession.replace(/:exampleapp$/i, '');

  const explicitNumber = Number(opts.sessionNumber ?? opts.session_number);
  if (Number.isInteger(explicitNumber) && explicitNumber > 0) return `app-session-${explicitNumber}`;

  const projectRoot = resolveProjectRoot(opts.projectRoot);
  const appStatusPath = toOptionalString(opts.appStatusPath || opts.app_status_path, path.join(projectRoot, '.squidrun', 'app-status.json'));
  const appStatus = readJsonFile(appStatusPath);
  const statusSession = Number(appStatus?.session ?? appStatus?.sessionNumber ?? appStatus?.session_number);
  if (Number.isInteger(statusSession) && statusSession > 0) return `app-session-${statusSession}`;

  return 'app-session-current';
}

function resolveExampleAppSessionId(options = {}) {
  const explicitSession = toOptionalString(options.sessionId || options.session_id || options.sessionScopeId || options.session_scope_id, null);
  if (explicitSession) {
    return /:exampleapp$/i.test(explicitSession) ? explicitSession : `${explicitSession}:exampleapp`;
  }
  return `${resolveMainSessionId(options)}:exampleapp`;
}

function resolveExampleAppManifestSessionId() {
  return buildCanonicalAppRoomSessionId(EXAMPLEAPP_APP_ROOM_ID);
}

function exampleAppDayToDayArms() {
  return getExampleAppDayToDayArmSpecs().map((spec) => ({
    armKey: spec.armKey,
    role: spec.role,
    paneId: spec.paneId,
    routeTarget: spec.routeTarget,
    armKind: spec.armKind,
    displayName: spec.displayName,
    dataSources: spec.dataSources,
    permissions: spec.permissions,
    metadata: spec.reportsTo ? { reportsTo: spec.reportsTo } : {},
    checkInObligation: {
      required: true,
      proofKind: 'startup_check_in',
    },
  }));
}

function exampleAppBuildModeArms() {
  return [
    {
      armKey: 'dev-qa',
      role: 'exampleapp-dev-qa',
      paneId: 'exampleapp-dev-qa',
      routeTarget: 'exampleapp-dev-qa',
      armKind: 'summoned',
      displayName: 'Dev/QA',
      desiredByDefault: false,
      mode: 'build-fix',
      permissions: {
        read: ['repo', 'tests', 'logs', 'browser_proof'],
        draft: ['fix_plan', 'verification_plan'],
        cannot: ['production_customer_mutation', 'customer_message', 'money_write'],
      },
    },
  ];
}

function buildExampleAppArmRegistryManifest(options = {}) {
  const opts = asObject(options);
  const mainSessionId = resolveMainSessionId(opts);
  const sessionId = resolveExampleAppManifestSessionId(opts);
  const readinessSessionId = resolveExampleAppSessionId({ ...opts, mainSessionId });
  const nowMs = toMs(opts.nowMs, Date.now());

  return {
    schema: EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA,
    appRoomId: EXAMPLEAPP_APP_ROOM_ID,
    sessionId,
    mainSessionId,
    leadRole: 'exampleapp-lead',
    leadPaneId: 'exampleapp-lead',
    routeTarget: EXAMPLEAPP_APP_ROOM_ID,
    metadata: {
      source: 'exampleapp_arm_set_proposal',
      sourceRef: EXAMPLEAPP_PROPOSAL_SOURCE_REF,
      seededBy: 'exampleapp-arm-registry-seed',
      seededAtMs: nowMs,
      manifestScope: 'app_room',
      readinessSessionId,
      desiredMode: 'day-to-day',
      readinessTruth: 'missing_until_role_checkins_exist',
      buildModeArms: exampleAppBuildModeArms(),
    },
    arms: exampleAppDayToDayArms(),
  };
}

function seedExampleAppArmRegistry(options = {}) {
  const opts = asObject(options);
  const nowMs = toMs(opts.nowMs, Date.now());
  const manifest = buildExampleAppArmRegistryManifest({ ...opts, nowMs });
  const readinessSessionId = manifest.metadata.readinessSessionId;

  if (opts.dryRun === true) {
    return {
      ok: true,
      status: 'dry_run',
      schema: EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA,
      manifest,
      readOnly: true,
      sideEffects: {
        registryWrites: 0,
        checkinsCreated: 0,
        applyRequestsCreated: 0,
        watchdogsCreated: 0,
      },
    };
  }

  const migration = migrateArmRegistryManifestScope({
    appRoomId: EXAMPLEAPP_APP_ROOM_ID,
    toSessionId: manifest.sessionId,
    ...(opts.fromSessionId || opts.from_session_id ? { fromSessionId: opts.fromSessionId || opts.from_session_id } : {}),
  }, {
    dbPath: opts.dbPath,
    nowMs,
    role: opts.role || 'builder',
    paneId: opts.paneId || opts.pane_id || 'builder',
    source: 'exampleapp-arm-registry-seed',
  });
  if (!migration.ok) {
    return {
      ...migration,
      schema: EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA,
      manifest,
    };
  }

  const seedResult = upsertArmRegistryManifest(manifest, { dbPath: opts.dbPath, nowMs, hardDeleteMissingArms: true });
  if (!seedResult.ok) {
    return {
      ...seedResult,
      schema: EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA,
      manifest,
    };
  }

  const evaluation = opts.evaluate === false
    ? null
    : evaluateArmRegistryReadiness({
      appRoomId: EXAMPLEAPP_APP_ROOM_ID,
      sessionId: readinessSessionId,
    }, { dbPath: opts.dbPath, nowMs });

  return {
    ok: Boolean(evaluation ? evaluation.ok : seedResult.ok),
    status: evaluation?.ok ? 'seeded_and_evaluated' : seedResult.status,
    schema: EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA,
    manifest,
    migration,
    seed: seedResult,
    evaluation,
    registry: evaluation?.registry || seedResult.registry || null,
    sideEffects: {
      registryWrites: 1,
      checkinsCreated: 0,
      applyRequestsCreated: 0,
      watchdogsCreated: 0,
    },
  };
}

module.exports = {
  EXAMPLEAPP_APP_ROOM_ID,
  EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA,
  EXAMPLEAPP_PROPOSAL_SOURCE_REF,
  buildExampleAppArmRegistryManifest,
  resolveExampleAppManifestSessionId,
  resolveMainSessionId,
  resolveExampleAppSessionId,
  seedExampleAppArmRegistry,
  exampleAppBuildModeArms,
  exampleAppDayToDayArms,
};
