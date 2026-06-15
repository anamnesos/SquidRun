'use strict';

const TRUSTQUOTE_PROJECT_PATH = 'D:\\projects\\TrustQuote';
const TRUSTQUOTE_ARM_COMMAND = 'codex --yolo';
const TRUSTQUOTE_HM_SEND_COMMAND = 'node D:\\projects\\squidrun\\ui\\scripts\\hm-send.js';
const TRUSTQUOTE_HM_SEND_SCOPE_NOTE = 'These Squid Room arm panes already run with SQUIDRUN_PROFILE=main and SQUIDRUN_WINDOW_KEY=squid-room; do not add an explicit trustquote target-profile flag.';

const TRUSTQUOTE_DAY_TO_DAY_ARM_SPECS = Object.freeze([
  {
    armKey: 'lead',
    paneId: 'trustquote-lead',
    role: 'trustquote-lead',
    routeTarget: 'trustquote-lead',
    armKind: 'lead',
    displayName: 'TrustQuote Lead',
    label: 'TrustQuote Lead',
    roleLabel: 'Lead',
    commandSourcePaneId: '2',
    workingDir: TRUSTQUOTE_PROJECT_PATH,
    command: TRUSTQUOTE_ARM_COMMAND,
    dataSources: [
      'arm-registry',
      'readiness-proof',
      'domain-summaries',
      'approval-state',
      'business-rulebook',
    ],
    permissions: {
      read: ['readiness', 'domain_summaries', 'approval_state', 'business_rules'],
      write: ['readiness_notes', 'missing_arm_status', 'worker_status_summary'],
      cannot: ['customer_message', 'money_write', 'schedule_mutation', 'delete_archive', 'refund_reversal', 'production_repair'],
    },
    startupLines: [
      'TrustQuote arm role: Lead.',
      'Work in D:\\projects\\TrustQuote.',
      'Use SquidRun evidence and current local files only. Do not claim production/deploy/readiness without proof.',
      'You are this app\'s funnel. Collect your worker arms\' status and send ONE consolidated update to the Architect with the roster/status.',
      `Send the one consolidated update UP with: ${TRUSTQUOTE_HM_SEND_COMMAND} architect --stdin --role trustquote-lead`,
      'Pass the Architect\'s instructions DOWN to the right worker. The Architect talks to you, not the swarm.',
      `Pass a message DOWN with: ${TRUSTQUOTE_HM_SEND_COMMAND} trustquote-app --stdin --role trustquote-lead (or target trustquote-invoice / trustquote-schedule-dispatch).`,
      TRUSTQUOTE_HM_SEND_SCOPE_NOTE,
      'Coordinate as a TrustQuote app arm inside Squid Room; this is not the main SquidRun Builder pane.',
    ],
  },
  {
    armKey: 'schedule-dispatch',
    paneId: 'trustquote-schedule-dispatch',
    role: 'trustquote-schedule-dispatch',
    routeTarget: 'trustquote-schedule-dispatch',
    reportsTo: 'trustquote-lead',
    armKind: 'domain',
    displayName: 'Schedule Dispatch',
    label: 'Schedule Dispatch',
    roleLabel: 'Schedule Dispatch',
    commandSourcePaneId: '3',
    workingDir: TRUSTQUOTE_PROJECT_PATH,
    command: TRUSTQUOTE_ARM_COMMAND,
    dataSources: [
      'calendar-events',
      'appointment-packets',
      'job-packets',
      'customers',
      'properties',
      'field-notes',
      'materials',
      'media-metadata',
    ],
    permissions: {
      read: ['schedule', 'jobs', 'customers', 'properties', 'field_context'],
      draft: ['schedule_change', 'job_note', 'missing_info_prompt', 'address_recommendation'],
      cannot: ['money_write', 'customer_message_send', 'delete_archive'],
    },
    startupLines: [
      'TrustQuote arm role: Schedule Dispatch.',
      'Work in D:\\projects\\TrustQuote.',
      'Focus on TrustQuote calendar, dispatch, schedule, dashboard, workflow, and work-state evidence when assigned.',
      'Before creating a client/customer for any schedule entry or job, ALWAYS search existing customers first and link to the existing record - never create a duplicate. James should never have to say "existing client".',
      `Report your status and work to your LEAD with: ${TRUSTQUOTE_HM_SEND_COMMAND} trustquote-lead --stdin --role trustquote-schedule-dispatch. Do not report directly to the Architect.`,
      TRUSTQUOTE_HM_SEND_SCOPE_NOTE,
      'Coordinate as a TrustQuote app arm inside Squid Room; this is not the main SquidRun Oracle pane.',
    ],
  },
  {
    armKey: 'app',
    paneId: 'trustquote-app',
    role: 'trustquote-app',
    routeTarget: 'trustquote-app',
    reportsTo: 'trustquote-lead',
    armKind: 'domain',
    displayName: 'TrustQuote App',
    label: 'TrustQuote App',
    roleLabel: 'TrustQuote App',
    commandSourcePaneId: '2',
    workingDir: TRUSTQUOTE_PROJECT_PATH,
    command: TRUSTQUOTE_ARM_COMMAND,
    dataSources: [
      'app-ui',
      'dashboard',
      'workflow-state',
      'api-routes',
      'database-records',
      'browser-proof',
      'runtime-logs',
    ],
    permissions: {
      read: ['repo', 'app_runtime', 'dashboard', 'workflow_state', 'api_routes', 'database_records', 'browser_proof', 'runtime_logs'],
      draft: ['fix_plan', 'ui_change', 'verification_plan', 'workflow_state_note'],
      cannot: ['production_deploy', 'customer_message_send', 'money_write_without_approval', 'schedule_mutation_without_approval', 'delete_archive'],
    },
    startupLines: [
      'TrustQuote arm role: TrustQuote App.',
      'Work in D:\\projects\\TrustQuote.',
      'Focus on TrustQuote app runtime, dashboard/UI, browser proof, data/API seams, and workflow-state evidence when assigned.',
      `Report your status and work to your LEAD with: ${TRUSTQUOTE_HM_SEND_COMMAND} trustquote-lead --stdin --role trustquote-app. Do not report directly to the Architect.`,
      TRUSTQUOTE_HM_SEND_SCOPE_NOTE,
      'Coordinate as a TrustQuote app arm inside Squid Room; this is not the main SquidRun Builder pane.',
    ],
  },
  {
    armKey: 'invoice',
    paneId: 'trustquote-invoice',
    role: 'trustquote-invoice',
    routeTarget: 'trustquote-invoice',
    reportsTo: 'trustquote-lead',
    armKind: 'domain',
    displayName: 'Invoice',
    label: 'Invoice',
    roleLabel: 'Invoice',
    commandSourcePaneId: '2',
    workingDir: TRUSTQUOTE_PROJECT_PATH,
    command: TRUSTQUOTE_ARM_COMMAND,
    dataSources: [
      'jobs',
      'active-invoices',
      'quotes',
      'payments',
      'refunds',
      'expenses',
      'pricebook',
      'warranties',
      'business-settings',
    ],
    permissions: {
      read: ['jobs', 'quotes', 'payments', 'warranties', 'pricebook', 'business_settings'],
      draft: ['invoice_contract', 'proposal', 'payment_entry', 'reminder', 'warranty_suggestion'],
      cannot: ['customer_message_send', 'money_write_without_approval', 'refund_reversal', 'delete_archive'],
    },
    startupLines: [
      'TrustQuote arm role: Invoice.',
      'Work in D:\\projects\\TrustQuote.',
      'Focus on TrustQuote invoice, quote, document, payment, and money-flow evidence when assigned.',
      `Report your status and work to your LEAD with: ${TRUSTQUOTE_HM_SEND_COMMAND} trustquote-lead --stdin --role trustquote-invoice. Do not report directly to the Architect.`,
      TRUSTQUOTE_HM_SEND_SCOPE_NOTE,
      'Coordinate as a TrustQuote app arm inside Squid Room; this is not the main SquidRun Builder pane.',
    ],
  },
]);

function cloneList(list = []) {
  return Array.isArray(list) ? list.slice() : [];
}

function clonePermissions(permissions = {}) {
  const cloned = {};
  for (const [key, value] of Object.entries(permissions || {})) {
    cloned[key] = cloneList(value);
  }
  return cloned;
}

function buildTrustQuoteArmStartupMessage(spec = {}) {
  return cloneList(spec.startupLines).join('\n');
}

function getTrustQuoteDayToDayArmSpecs() {
  return TRUSTQUOTE_DAY_TO_DAY_ARM_SPECS.map((spec) => ({
    ...spec,
    dataSources: cloneList(spec.dataSources),
    permissions: clonePermissions(spec.permissions),
    startupLines: cloneList(spec.startupLines),
    startupMessage: buildTrustQuoteArmStartupMessage(spec),
  }));
}

function getTrustQuoteArmPaneIds() {
  return TRUSTQUOTE_DAY_TO_DAY_ARM_SPECS.map((spec) => spec.paneId);
}

module.exports = {
  TRUSTQUOTE_ARM_COMMAND,
  TRUSTQUOTE_DAY_TO_DAY_ARM_SPECS,
  TRUSTQUOTE_HM_SEND_COMMAND,
  TRUSTQUOTE_HM_SEND_SCOPE_NOTE,
  TRUSTQUOTE_PROJECT_PATH,
  buildTrustQuoteArmStartupMessage,
  getTrustQuoteArmPaneIds,
  getTrustQuoteDayToDayArmSpecs,
};
