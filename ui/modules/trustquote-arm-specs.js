'use strict';

const TRUSTQUOTE_PROJECT_PATH = 'D:\\projects\\TrustQuote';
const TRUSTQUOTE_ARM_COMMAND = 'codex --yolo';

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
      write: ['readiness_notes', 'missing_arm_status'],
      cannot: ['customer_message', 'money_write', 'schedule_mutation', 'delete_archive', 'refund_reversal', 'production_repair'],
    },
    startupLines: [
      'TrustQuote arm role: Lead.',
      'Work in D:\\projects\\TrustQuote.',
      'Use SquidRun evidence and current local files only. Do not claim production/deploy/readiness without proof.',
      'Coordinate as a TrustQuote app arm inside Squid Room; this is not the main SquidRun Builder pane.',
    ],
  },
  {
    armKey: 'schedule-dispatch',
    paneId: 'trustquote-schedule-dispatch',
    role: 'trustquote-schedule-dispatch',
    routeTarget: 'trustquote-schedule-dispatch',
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
      'Coordinate as a TrustQuote app arm inside Squid Room; this is not the main SquidRun Oracle pane.',
    ],
  },
  {
    armKey: 'app',
    paneId: 'trustquote-app',
    role: 'trustquote-app',
    routeTarget: 'trustquote-app',
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
      'Coordinate as a TrustQuote app arm inside Squid Room; this is not the main SquidRun Builder pane.',
    ],
  },
  {
    armKey: 'invoice',
    paneId: 'trustquote-invoice',
    role: 'trustquote-invoice',
    routeTarget: 'trustquote-invoice',
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
  TRUSTQUOTE_PROJECT_PATH,
  buildTrustQuoteArmStartupMessage,
  getTrustQuoteArmPaneIds,
  getTrustQuoteDayToDayArmSpecs,
};
