'use strict';

const fs = require('fs');
const path = require('path');

const {
  PROFILE_ROOT_CONFIG_VERSION,
  getProfileProjectRootConfigPath,
} = require('../profile');
const {
  TRUSTQUOTE_PROJECT_PATH,
  TRUSTQUOTE_ROOM_ID,
  TRUSTQUOTE_WORKSTREAM_VERSION,
  makeTrustQuoteSessionScopeId,
} = require('./project-room-envelope');

const PREREQUISITE_CONTRACT_VERSION = 'squidrun.trustquote-work-room-prerequisites.v0';
const GENERATED_STARTUP_SOURCE_VERSION = 'squidrun.trustquote-startup-source.v0';
const GENERATED_TRUSTQUOTE_PLAYBOOK_FILE = 'TRUSTQUOTE-PLAYBOOK.md';

function toText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizeToPosix(value) {
  return toText(value, '').replace(/\\/g, '/');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveSquidrunRoot(options = {}) {
  return path.resolve(options.squidrunRoot || path.join(__dirname, '..', '..'));
}

function resolveMainSessionScopeId(options = {}) {
  const explicit = toText(options.mainSessionScopeId || options.sessionScopeId || options.session_id, '');
  if (explicit) return explicit;

  const squidrunRoot = resolveSquidrunRoot(options);
  const appStatus = readJsonFile(path.join(squidrunRoot, '.squidrun', 'app-status.json'));
  const sessionNumber = Number(appStatus?.session);
  if (Number.isInteger(sessionNumber) && sessionNumber > 0) {
    return `app-session-${sessionNumber}`;
  }
  return 'app-session-preview';
}

function buildGeneratedAgentsSource({ projectPath, sessionScopeId, generatedAt }) {
  return [
    '# TrustQuote SquidRun Work Room Startup Source',
    '',
    `Version: ${GENERATED_STARTUP_SOURCE_VERSION}`,
    `Generated: ${generatedAt}`,
    '',
    'Purpose:',
    '- Bind TrustQuote room agents to the TrustQuote workspace/profile/session before any live room route can render.',
    '',
    'Room identity:',
    `- Profile: ${TRUSTQUOTE_ROOM_ID}`,
    `- Workspace: ${normalizeToPosix(projectPath)}`,
    `- Session Scope: ${sessionScopeId}`,
    '',
    'Rules:',
    '- Work inside the TrustQuote workspace unless a room-scoped instruction explicitly says otherwise.',
    '- Treat SquidRun Main as coordinator context, not TrustQuote workspace authority.',
    '- Follow the TrustQuote CLAUDE.md and imported docs/claude modules for project-specific rules.',
    `- Read startup/${GENERATED_TRUSTQUOTE_PLAYBOOK_FILE} before answering TrustQuote workflow, invoice, quote, customer, deploy, env, webhook, Telegram, Vapi, or Upstash questions.`,
    '- Use .squidrun/link.json as the route/profile/session source of truth.',
    '- Do not claim a live TrustQuote tab or route until builder and oracle routes are healthy client_activity under this session.',
    '',
  ].join('\n');
}

function buildGeneratedRolesSource({ sessionScopeId }) {
  return [
    '# TrustQuote SquidRun Work Room Roles',
    '',
    `Version: ${GENERATED_STARTUP_SOURCE_VERSION}`,
    '',
    'Room roles:',
    '- Architect remains the main SquidRun coordinator unless a future proven room contract says otherwise.',
    '- Builder owns TrustQuote implementation inside the trustquote profile/session boundary.',
    '- Oracle owns TrustQuote investigation, verification, and review inside the trustquote profile/session boundary.',
    '',
    'Route boundary:',
    `- Required session scope: ${sessionScopeId}`,
    '- Required window/profile: trustquote',
    '- Handler-only/local-message routes do not prove a live TrustQuote work room.',
    '',
  ].join('\n');
}

function buildGeneratedPlaybookSource({ generatedAt }) {
  return [
    '# TrustQuote Workflow Playbook',
    '',
    `Version: ${GENERATED_STARTUP_SOURCE_VERSION}`,
    `Generated: ${generatedAt}`,
    '',
    'Use this as startup context for TrustQuote agents. It summarizes proven SquidRun and TrustQuote repo operating rules. Verify source files before writes.',
    '',
    'Source refs:',
    '- D:/projects/TrustQuote/lib/telegram/tools.ts',
    '- D:/projects/TrustQuote/docs/AGENT_SCRIPT_GUIDE.md',
    '- D:/projects/TrustQuote/features.md',
    '- D:/projects/TrustQuote/docs/SHAPE.md',
    '- D:/projects/squidrun/workspace/knowledge/trustquote-field-workflow.md',
    '- D:/projects/squidrun/workspace/knowledge/handoff-corrections.md',
    '',
    'Hard boundaries:',
    '- Use fake/local/demo data unless James explicitly asks for production data changes.',
    '- Do not send customer email, SMS, approval requests, Telegram messages, Vapi calls, Stripe charges, deploys, env changes, or webhook registrations without explicit approval.',
    '- Do not print secrets. Report env var names as present, missing, placeholder, or unusable only.',
    '- Ask when price, customer identity, send/charge/deploy intent, or real-world effect is ambiguous.',
    '',
    'Core model:',
    '- TrustQuote manages customers, properties, appointments, quotes/proposals, jobs/invoices, payments, warranties, media, dashboard review, and customer-safe public invoice previews.',
    '- The current schema and tool behavior source of truth is lib/telegram/tools.ts. Prefer MCP/Telegram tools such as book_job, create_estimate, convert_quote, update_invoice, record_payment, send_invoice, and email_existing_invoice over direct Firestore writes.',
    '- Direct firebase-admin writes are repair/last-resort work. If direct writes are unavoidable, dry-run or print the planned write first, dupe-check document numbers, mirror payments, read back, and report before/planned/after plainly.',
    '',
    'Invoices and payments:',
    '- Invoices are jobs documents. Proposals are quotes documents. Payments are mirrored in payments.',
    '- A valid job needs businessId, customerId, clientInfo, invoiceNumber, companyInfo, diagnosis, solution/work, jobTypes, subtotal, discount, total, paymentDates, paymentStatus, lastPaymentDate, createdAt, and updatedAt.',
    '- First invoice writes need the full display field set, including companyInfo.logoUrl, invoiceLabel, date, subtotal, totalPaid, balanceDue, status, isDeleted, isProposal, approved flags, reviewRequired, send flags, creator fields, type, tech fields, notes, customerNotes, internalNotes, solution, media/photo arrays, warranty fields, and source refs. Minimal writes can render without the company logo.',
    '- paymentStatus is computed from collected paymentDates with dateCollected. Do not hardcode paid/partial/unpaid against conflicting payment data.',
    '- Invoice/proposal numbers come from business counters. Direct writes must read/dupe-check and update the counter, or avoid direct writes.',
    '',
    'Field appointment completion:',
    '- calendar-events are appointments, not dashboard invoices.',
    '- Completing an appointment or writing completionNotes does not create an invoice. Correct completion creates/updates a linked jobs invoice and cross-links calendar-events/{eventId}.jobId, .invoiceId, .linkedJobId, and jobs/{jobId}.sourceEventId.',
    '- Use npm run complete:field-job for field appointment completion. Dry-run first. It requires --event-id, --amount, and --work; --apply is required for writes; --send-email is allowed only after apply and only when James explicitly asks to send.',
    '- Do not invent a price. If amount is missing, draft or ask. Do not put private staffing/worker-conflict notes in customer-facing fields.',
    '',
    'Quotes and customers:',
    '- Quotes/proposals live in quotes, use isProposal:true, and number from nextProposalNumber. convert_quote turns a proposal into a job invoice.',
    '- Customer lookup is by business-owned customer records, normalized phone/email/address keys, and directory/list tools. Do not assume the user doc contains the customer email.',
    '- Hard delete is blocked when customers/properties have linked jobs, quotes, payments, warranties, or events. Archive/soft-delete patterns preserve history.',
    '',
    'Dashboard and packets:',
    '- Dashboard invoice cards show active jobs/quotes and are the review surface for Job #, client, date, status, address, contact, tasks, media, balance, total, and actions.',
    '- Job packets live at /jobs/[jobId]/packet. Appointment packets live at /appointments/[eventId]/packet and route to linked job packets when a linked job exists.',
    '- Draft invoice creation from an appointment carries sourceEventId and should prevent duplicate jobs for an already linked event.',
    '- Customer-visible invoice photos use the public invoice media path. Internal job media and videos stay internal unless explicitly made customer-visible.',
    '',
    'Deploy, env, and webhooks:',
    '- Vercel project is trustquote; production URL is https://trustquote.app. Do not deploy, push, promote, roll back, register webhooks, or mutate production env without explicit approval.',
    '- Important env names include NEXT_PUBLIC_FIREBASE_*, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, RESEND_API_KEY, DEFAULT_FROM_EMAIL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TRUSTQUOTE_TELEGRAM_CHAT_ID, VAPI_WEBHOOK_SECRET, VAPI_ASSISTANT_ID, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ENCRYPTION_KEY, APP_URL, and NEXT_PUBLIC_ALLOWED_ORIGIN(S).',
    '- Telegram webhook endpoint is /api/telegram/webhook on the deployed HTTPS domain. Vapi webhook endpoint is /api/voice/vapi/webhook. Stripe has its own webhook secret.',
    '- Upstash Redis backs shared production rate limits when UPSTASH_REDIS_REST_URL and token are set; local/dev can fall back to in-memory rate limits.',
    '',
    'Verification defaults:',
    '- For code changes, run the narrow relevant tests first, then typecheck/lint/build when the touched surface warrants it.',
    '- For Firestore rules changes, run rules tests. For local UI proof, prefer emulator/dev:emu over production.',
    '- Report exactly what was changed, where the data lives, what was not sent/charged/deployed, and any pre-existing unrelated failures.',
    '',
  ].join('\n');
}

function buildStartupBundle({
  projectPath,
  linkPath,
  agentsPath,
  rolesPath,
  playbookPath,
  startupBundlePath,
  sessionScopeId,
  generatedAt,
}) {
  return [
    '# TrustQuote Startup Bundle',
    '',
    `Generated: ${generatedAt}`,
    `Session Scope: ${sessionScopeId}`,
    '',
    'Profile identity:',
    `- Profile: ${TRUSTQUOTE_ROOM_ID}`,
    `- Workspace: ${normalizeToPosix(projectPath)}`,
    `- Link: ${normalizeToPosix(linkPath)}`,
    '',
    'Authoritative source files:',
    `- ${normalizeToPosix(agentsPath)}`,
    `- ${normalizeToPosix(path.join(projectPath, 'CLAUDE.md'))}`,
    `- ${normalizeToPosix(rolesPath)}`,
    `- ${normalizeToPosix(playbookPath)}`,
    '',
    'Work-room routing contract:',
    '- Route scope: profileName=trustquote, windowKey=trustquote',
    `- Session scope: ${sessionScopeId}`,
    '- Required live routes before a TrustQuote tab can render: builder and oracle via client_activity.',
    '- Handler-only/local-message routes are not live room proof.',
    '',
    `Bundle path: ${normalizeToPosix(startupBundlePath)}`,
    '',
  ].join('\n');
}

function buildTrustQuoteWorkRoomPrerequisiteArtifacts(options = {}) {
  const squidrunRoot = resolveSquidrunRoot(options);
  const projectPath = path.resolve(options.projectPath || TRUSTQUOTE_PROJECT_PATH);
  const generatedAt = toText(options.generatedAt || options.now, '') || new Date().toISOString();
  const mainSessionScopeId = resolveMainSessionScopeId({ ...options, squidrunRoot });
  const sessionScopeId = makeTrustQuoteSessionScopeId(mainSessionScopeId);
  const profileRootConfigPath = getProfileProjectRootConfigPath(TRUSTQUOTE_ROOM_ID, squidrunRoot);
  const trustQuoteCoordDir = path.join(projectPath, '.squidrun');
  const workRoomDir = path.join(trustQuoteCoordDir, 'work-rooms', TRUSTQUOTE_ROOM_ID);
  const startupDir = path.join(workRoomDir, 'startup');
  const linkPath = path.join(trustQuoteCoordDir, 'link.json');
  const agentsPath = path.join(startupDir, 'AGENTS.md');
  const rolesPath = path.join(startupDir, 'ROLES.md');
  const playbookPath = path.join(startupDir, GENERATED_TRUSTQUOTE_PLAYBOOK_FILE);
  const workstreamPath = path.join(workRoomDir, 'current-workstream.json');
  const startupBundlePath = path.join(squidrunRoot, '.squidrun', 'runtime', 'window-teams', TRUSTQUOTE_ROOM_ID, 'startup-bundle.md');

  const profileRootContract = {
    version: PROFILE_ROOT_CONFIG_VERSION,
    profile: TRUSTQUOTE_ROOM_ID,
    roomId: TRUSTQUOTE_ROOM_ID,
    projectRoot: normalizeToPosix(projectPath),
    source: PREREQUISITE_CONTRACT_VERSION,
    generatedAt,
  };
  const link = {
    squidrun_root: normalizeToPosix(squidrunRoot),
    comms: {
      hm_send: normalizeToPosix(path.join(squidrunRoot, 'ui', 'scripts', 'hm-send.js')),
      hm_comms: normalizeToPosix(path.join(squidrunRoot, 'ui', 'scripts', 'hm-comms.js')),
    },
    workspace: normalizeToPosix(projectPath),
    session_id: sessionScopeId,
    role_targets: {
      architect: 'architect',
      builder: 'builder',
      oracle: 'oracle',
    },
    version: 1,
    profile: TRUSTQUOTE_ROOM_ID,
    room: {
      id: TRUSTQUOTE_ROOM_ID,
      sessionScopeId,
      contractVersion: PREREQUISITE_CONTRACT_VERSION,
    },
  };
  const workstream = {
    version: TRUSTQUOTE_WORKSTREAM_VERSION,
    roomId: TRUSTQUOTE_ROOM_ID,
    profile: TRUSTQUOTE_ROOM_ID,
    projectRoot: normalizeToPosix(projectPath),
    sessionScopeId,
    status: 'initialized_no_active_task',
    routeStatus: 'unproven',
    currentTask: null,
    sourceRefs: [
      normalizeToPosix(linkPath),
      normalizeToPosix(startupBundlePath),
    ],
    blockers: [
      'live_builder_route_missing',
      'live_oracle_route_missing',
    ],
    generatedAt,
  };

  return {
    version: PREREQUISITE_CONTRACT_VERSION,
    roomId: TRUSTQUOTE_ROOM_ID,
    profile: TRUSTQUOTE_ROOM_ID,
    projectPath: normalizeToPosix(projectPath),
    squidrunRoot: normalizeToPosix(squidrunRoot),
    mainSessionScopeId,
    sessionScopeId,
    paths: {
      profileRootConfigPath: normalizeToPosix(profileRootConfigPath),
      linkPath: normalizeToPosix(linkPath),
      agentsPath: normalizeToPosix(agentsPath),
      rolesPath: normalizeToPosix(rolesPath),
      playbookPath: normalizeToPosix(playbookPath),
      startupBundlePath: normalizeToPosix(startupBundlePath),
      workstreamPath: normalizeToPosix(workstreamPath),
    },
    profileRootContract,
    link,
    startupSources: {
      agents: buildGeneratedAgentsSource({ projectPath, sessionScopeId, generatedAt }),
      roles: buildGeneratedRolesSource({ sessionScopeId }),
      playbook: buildGeneratedPlaybookSource({ generatedAt }),
    },
    startupBundle: buildStartupBundle({
      projectPath,
      linkPath,
      agentsPath,
      rolesPath,
      playbookPath,
      startupBundlePath,
      sessionScopeId,
      generatedAt,
    }),
    workstream,
  };
}

function writeTextIfChanged(filePath, text, write) {
  const normalizedText = `${String(text || '').replace(/\s*$/u, '')}\n`;
  if (!write) return { path: normalizeToPosix(filePath), status: 'dry_run' };
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (previous === normalizedText) return { path: normalizeToPosix(filePath), status: 'unchanged' };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalizedText, 'utf8');
  return { path: normalizeToPosix(filePath), status: previous === null ? 'created' : 'updated' };
}

function writeJsonIfChanged(filePath, payload, write) {
  return writeTextIfChanged(filePath, JSON.stringify(payload, null, 2), write);
}

function isSameTrustQuoteWorkstreamScope(existing, next) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
  return toText(existing.version, '') === TRUSTQUOTE_WORKSTREAM_VERSION
    && toText(existing.roomId, '') === TRUSTQUOTE_ROOM_ID
    && toText(existing.profile, '') === TRUSTQUOTE_ROOM_ID
    && normalizeToPosix(existing.projectRoot || existing.workspace) === normalizeToPosix(next.projectRoot || next.workspace)
    && toText(existing.sessionScopeId || existing.session_id, '') === toText(next.sessionScopeId || next.session_id, '');
}

function isProvenTrustQuoteWorkstream(existing, next) {
  return isSameTrustQuoteWorkstreamScope(existing, next)
    && toText(existing.routeStatus, '').toLowerCase() === 'proven'
    && Array.isArray(existing.blockers)
    && existing.blockers.length === 0;
}

function writeWorkstreamIfChanged(filePath, payload, write) {
  if (write && fs.existsSync(filePath)) {
    const existing = readJsonFile(filePath);
    if (isProvenTrustQuoteWorkstream(existing, payload)) {
      return { path: normalizeToPosix(filePath), status: 'preserved_proven' };
    }
  }
  return writeJsonIfChanged(filePath, payload, write);
}

function materializeTrustQuoteWorkRoomPrerequisites(options = {}) {
  const write = options.write === true;
  const artifacts = buildTrustQuoteWorkRoomPrerequisiteArtifacts(options);
  const results = [
    {
      kind: 'profile_root_contract',
      ...writeJsonIfChanged(artifacts.paths.profileRootConfigPath, artifacts.profileRootContract, write),
    },
    {
      kind: 'profile_link',
      ...writeJsonIfChanged(artifacts.paths.linkPath, artifacts.link, write),
    },
    {
      kind: 'startup_source_agents',
      ...writeTextIfChanged(artifacts.paths.agentsPath, artifacts.startupSources.agents, write),
    },
    {
      kind: 'startup_source_roles',
      ...writeTextIfChanged(artifacts.paths.rolesPath, artifacts.startupSources.roles, write),
    },
    {
      kind: 'startup_source_playbook',
      ...writeTextIfChanged(artifacts.paths.playbookPath, artifacts.startupSources.playbook, write),
    },
    {
      kind: 'startup_bundle',
      ...writeTextIfChanged(artifacts.paths.startupBundlePath, artifacts.startupBundle, write),
    },
    {
      kind: 'workstream',
      ...writeWorkstreamIfChanged(artifacts.paths.workstreamPath, artifacts.workstream, write),
    },
  ];

  return {
    ok: true,
    write,
    artifacts,
    results,
  };
}

module.exports = {
  GENERATED_STARTUP_SOURCE_VERSION,
  GENERATED_TRUSTQUOTE_PLAYBOOK_FILE,
  PREREQUISITE_CONTRACT_VERSION,
  buildGeneratedPlaybookSource,
  buildTrustQuoteWorkRoomPrerequisiteArtifacts,
  materializeTrustQuoteWorkRoomPrerequisites,
  resolveMainSessionScopeId,
};
