const DOMAIN_CAPABILITY_REGISTRY = Object.freeze({
  legal: Object.freeze({
    label: 'Legal',
    intro: 'Here is what we can do for you right now.',
    capabilities: Object.freeze([
      Object.freeze({
        id: 'legal_issue_map',
        label: 'Map the legal issue',
        summary: 'Cross-check the facts, identify likely claims or defenses, and surface missing risks or deadlines.',
      }),
      Object.freeze({
        id: 'legal_draft_letters',
        label: 'Draft letters and complaints',
        summary: 'Prepare dispute letters, demand letters, complaint drafts, or plain-language summaries of your position.',
      }),
      Object.freeze({
        id: 'legal_evidence_packet',
        label: 'Build an evidence packet',
        summary: 'Organize a timeline, exhibits, screenshots, and a checklist so nothing important gets missed.',
      }),
      Object.freeze({
        id: 'legal_support_search',
        label: 'Find support paths',
        summary: 'Look for filing paths, agencies, legal-aid options, and practical next-step checklists.',
      }),
    ]),
  }),
  financial: Object.freeze({
    label: 'Financial',
    intro: 'Here is what we can do for you right now.',
    capabilities: Object.freeze([
      Object.freeze({
        id: 'financial_scenario_model',
        label: 'Model the situation',
        summary: 'Break down balances, payment scenarios, tradeoffs, and near-term cash impact.',
      }),
      Object.freeze({
        id: 'financial_dispute_docs',
        label: 'Draft dispute and hardship documents',
        summary: 'Prepare hardship letters, debt dispute drafts, application notes, or negotiation scripts.',
      }),
      Object.freeze({
        id: 'financial_program_search',
        label: 'Search programs and options',
        summary: 'Look for relief programs, restructuring options, assistance routes, and deadlines.',
      }),
      Object.freeze({
        id: 'financial_checklist',
        label: 'Build a document checklist',
        summary: 'Create the paperwork checklist and evidence bundle needed for disputes or applications.',
      }),
    ]),
  }),
  medical: Object.freeze({
    label: 'Medical',
    intro: 'Here is what we can do for you right now.',
    capabilities: Object.freeze([
      Object.freeze({
        id: 'medical_timeline',
        label: 'Build a symptom and care timeline',
        summary: 'Turn scattered details into a clean timeline of symptoms, visits, medications, and changes.',
      }),
      Object.freeze({
        id: 'medical_questions',
        label: 'Prepare questions and summaries',
        summary: 'Draft concise visit summaries and question lists for clinicians or caregivers.',
      }),
      Object.freeze({
        id: 'medical_records',
        label: 'Organize records and evidence',
        summary: 'Assemble bills, imaging, lab results, and notes into a reusable packet.',
      }),
      Object.freeze({
        id: 'medical_appeals',
        label: 'Support appeals and logistics',
        summary: 'Draft insurance appeal notes, prior-auth support summaries, and follow-up checklists.',
      }),
    ]),
  }),
  general: Object.freeze({
    label: 'Real-world',
    intro: 'Here is what we can do for you right now.',
    capabilities: Object.freeze([
      Object.freeze({
        id: 'general_research',
        label: 'Research the problem',
        summary: 'Break down the issue, cross-check assumptions, and identify what still needs verification.',
      }),
      Object.freeze({
        id: 'general_documents',
        label: 'Draft helpful documents',
        summary: 'Prepare letters, summaries, checklists, or structured notes you can actually use.',
      }),
      Object.freeze({
        id: 'general_evidence',
        label: 'Organize the evidence',
        summary: 'Build a timeline and evidence pack so the facts stay clear and portable.',
      }),
    ]),
  }),
});

function toText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeList(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => toText(value)).filter(Boolean)));
}

function resolveCapabilityDomain(domain) {
  const normalized = toText(domain, 'general').toLowerCase();
  return DOMAIN_CAPABILITY_REGISTRY[normalized] ? normalized : 'general';
}

function buildContextSummary({ institutions = [], moneyAmounts = [] } = {}) {
  const parts = [];
  const normalizedInstitutions = normalizeList(institutions);
  const normalizedAmounts = normalizeList(moneyAmounts);
  if (normalizedInstitutions.length > 0) {
    parts.push(`Context: ${normalizedInstitutions.slice(0, 2).join(', ')}`);
  }
  if (normalizedAmounts.length > 0) {
    parts.push(`Amounts mentioned: ${normalizedAmounts.slice(0, 2).join(', ')}`);
  }
  return parts;
}

function buildShortNotice(plan) {
  const labels = (plan.actions || []).slice(0, 3).map((action) => action.label.toLowerCase());
  if (labels.length === 0) {
    return 'Here is what we can do for you right now.';
  }
  if (labels.length === 1) {
    return `Here is what we can do: ${labels[0]}.`;
  }
  if (labels.length === 2) {
    return `Here is what we can do: ${labels[0]} and ${labels[1]}.`;
  }
  return `Here is what we can do: ${labels[0]}, ${labels[1]}, and ${labels[2]}.`;
}

function buildCapabilityPlan(input = {}) {
  const domain = resolveCapabilityDomain(input.domain);
  const template = DOMAIN_CAPABILITY_REGISTRY[domain] || DOMAIN_CAPABILITY_REGISTRY.general;
  const actions = (template.capabilities || []).map((capability) => ({
    id: capability.id,
    label: capability.label,
    summary: capability.summary,
  }));
  const context = buildContextSummary(input);

  const markdown = [
    template.intro,
    ...context,
    ...actions.map((action) => `- ${action.label}: ${action.summary}`),
  ].join('\n');

  return {
    domain,
    domainLabel: template.label,
    intro: template.intro,
    actions,
    context,
    shortNotice: buildShortNotice({ actions }),
    markdown,
  };
}

module.exports = {
  DOMAIN_CAPABILITY_REGISTRY,
  buildCapabilityPlan,
  buildContextSummary,
  buildShortNotice,
  resolveCapabilityDomain,
};
