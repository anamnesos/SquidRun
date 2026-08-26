'use strict';

const EXAMPLEAPP_PROJECT_PATH = 'D:\\projects\\ExampleApp';
const EXAMPLEAPP_ARM_COMMAND = 'codex --yolo';
const EXAMPLEAPP_HM_SEND_COMMAND = 'node D:\\projects\\squidrun\\ui\\scripts\\hm-send.js';
const EXAMPLEAPP_HM_SEND_SCOPE_NOTE = 'These Squid Room arm panes already run with SQUIDRUN_PROFILE=main and SQUIDRUN_WINDOW_KEY=squid-room; do not add an explicit exampleapp target-profile flag.';

const EXAMPLEAPP_DAY_TO_DAY_ARM_SPECS = Object.freeze([
  {
    armKey: 'lead',
    paneId: 'exampleapp-lead',
    role: 'exampleapp-lead',
    routeTarget: 'exampleapp-lead',
    armKind: 'lead',
    displayName: 'ExampleApp Lead',
    label: 'ExampleApp Lead',
    roleLabel: 'Lead',
    commandSourcePaneId: '2',
    workingDir: EXAMPLEAPP_PROJECT_PATH,
    command: EXAMPLEAPP_ARM_COMMAND,
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
      'ExampleApp arm role: Lead.',
      'Work in D:\\projects\\ExampleApp.',
      'Use SquidRun evidence and current local files only. Do not claim production/deploy/readiness without proof.',
      'You are this app\'s funnel. Collect your worker arms\' status and send ONE consolidated update to the Architect with the roster/status.',
      `Send the one consolidated update UP with: ${EXAMPLEAPP_HM_SEND_COMMAND} architect --stdin --role exampleapp-lead`,
      'Pass the Architect\'s instructions DOWN to the right worker. The Architect talks to you, not the swarm.',
      `Pass a message DOWN with: ${EXAMPLEAPP_HM_SEND_COMMAND} exampleapp-app --stdin --role exampleapp-lead (or target exampleapp-invoice / exampleapp-schedule-dispatch).`,
      EXAMPLEAPP_HM_SEND_SCOPE_NOTE,
      'Coordinate as a ExampleApp app arm inside Squid Room; this is not the main SquidRun Builder pane.',
    ],
  },
  {
    armKey: 'schedule-dispatch',
    paneId: 'exampleapp-schedule-dispatch',
    role: 'exampleapp-schedule-dispatch',
    routeTarget: 'exampleapp-schedule-dispatch',
    reportsTo: 'exampleapp-lead',
    armKind: 'domain',
    displayName: 'Schedule Dispatch',
    label: 'Schedule Dispatch',
    roleLabel: 'Schedule Dispatch',
    commandSourcePaneId: '3',
    workingDir: EXAMPLEAPP_PROJECT_PATH,
    command: EXAMPLEAPP_ARM_COMMAND,
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
      'ExampleApp arm role: Schedule Dispatch.',
      'Work in D:\\projects\\ExampleApp.',
      'Focus on ExampleApp calendar, dispatch, schedule, dashboard, workflow, and work-state evidence when assigned.',
      'Before creating a client/customer for any schedule entry or job, ALWAYS search existing customers first - match on EMAIL + address/unit, not name alone (different units/tenants under the same property manager share an email but are separate records). Link to the right existing record; never create a duplicate, and never collapse different units by name. Operator should never have to say "existing client".',
      `Report your status and work to your LEAD with: ${EXAMPLEAPP_HM_SEND_COMMAND} exampleapp-lead --stdin --role exampleapp-schedule-dispatch. Do not report directly to the Architect.`,
      EXAMPLEAPP_HM_SEND_SCOPE_NOTE,
      'Coordinate as a ExampleApp app arm inside Squid Room; this is not the main SquidRun Oracle pane.',
    ],
  },
  {
    armKey: 'app',
    paneId: 'exampleapp-app',
    role: 'exampleapp-app',
    routeTarget: 'exampleapp-app',
    reportsTo: 'exampleapp-lead',
    armKind: 'domain',
    displayName: 'ExampleApp App',
    label: 'ExampleApp App',
    roleLabel: 'ExampleApp App',
    commandSourcePaneId: '2',
    workingDir: EXAMPLEAPP_PROJECT_PATH,
    command: EXAMPLEAPP_ARM_COMMAND,
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
      'ExampleApp arm role: ExampleApp App.',
      'Work in D:\\projects\\ExampleApp.',
      'Focus on ExampleApp app runtime, dashboard/UI, browser proof, data/API seams, and workflow-state evidence when assigned.',
      `Report your status and work to your LEAD with: ${EXAMPLEAPP_HM_SEND_COMMAND} exampleapp-lead --stdin --role exampleapp-app. Do not report directly to the Architect.`,
      EXAMPLEAPP_HM_SEND_SCOPE_NOTE,
      'Coordinate as a ExampleApp app arm inside Squid Room; this is not the main SquidRun Builder pane.',
    ],
  },
  {
    armKey: 'invoice',
    paneId: 'exampleapp-invoice',
    role: 'exampleapp-invoice',
    routeTarget: 'exampleapp-invoice',
    reportsTo: 'exampleapp-lead',
    armKind: 'domain',
    displayName: 'Invoice',
    label: 'Invoice',
    roleLabel: 'Invoice',
    commandSourcePaneId: '2',
    workingDir: EXAMPLEAPP_PROJECT_PATH,
    command: EXAMPLEAPP_ARM_COMMAND,
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
      'ExampleApp arm role: Invoice.',
      'Work in D:\\projects\\ExampleApp.',
      'Focus on ExampleApp invoice, quote, document, payment, and money-flow evidence when assigned.',
      `Report your status and work to your LEAD with: ${EXAMPLEAPP_HM_SEND_COMMAND} exampleapp-lead --stdin --role exampleapp-invoice. Do not report directly to the Architect.`,
      EXAMPLEAPP_HM_SEND_SCOPE_NOTE,
      'Coordinate as a ExampleApp app arm inside Squid Room; this is not the main SquidRun Builder pane.',
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

function buildExampleAppArmStartupMessage(spec = {}) {
  return cloneList(spec.startupLines).join('\n');
}

function getExampleAppDayToDayArmSpecs() {
  return EXAMPLEAPP_DAY_TO_DAY_ARM_SPECS.map((spec) => ({
    ...spec,
    dataSources: cloneList(spec.dataSources),
    permissions: clonePermissions(spec.permissions),
    startupLines: cloneList(spec.startupLines),
    startupMessage: buildExampleAppArmStartupMessage(spec),
  }));
}

function getExampleAppArmPaneIds() {
  return EXAMPLEAPP_DAY_TO_DAY_ARM_SPECS.map((spec) => spec.paneId);
}

module.exports = {
  EXAMPLEAPP_ARM_COMMAND,
  EXAMPLEAPP_DAY_TO_DAY_ARM_SPECS,
  EXAMPLEAPP_HM_SEND_COMMAND,
  EXAMPLEAPP_HM_SEND_SCOPE_NOTE,
  EXAMPLEAPP_PROJECT_PATH,
  buildExampleAppArmStartupMessage,
  getExampleAppArmPaneIds,
  getExampleAppDayToDayArmSpecs,
};
