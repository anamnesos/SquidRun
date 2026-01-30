/**
 * Built-in agent skills marketplace catalog
 * Provides curated skills for common agent capabilities.
 */

const BUILTIN_CREATED_AT = '2026-01-30T00:00:00.000Z';

const BUILTIN_SKILLS = [
  {
    id: 'skill-architecture',
    name: 'Systems Architecture',
    description: 'Design resilient systems, define boundaries, and evaluate tradeoffs.',
    category: 'Strategy',
    tags: ['architecture', 'planning', 'systems'],
    capabilities: ['system design', 'dependency mapping', 'risk analysis'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-routing',
    name: 'Task Routing',
    description: 'Route tasks to the best agent based on skills and context.',
    category: 'Coordination',
    tags: ['routing', 'coordination', 'allocation'],
    capabilities: ['agent matching', 'load balancing', 'handoff planning'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-frontend',
    name: 'Frontend Engineering',
    description: 'Deliver polished UI with responsive layouts and interactions.',
    category: 'Engineering',
    tags: ['frontend', 'ui', 'ux'],
    capabilities: ['layout composition', 'component styling', 'interaction design'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-backend',
    name: 'Backend Engineering',
    description: 'Build reliable services, APIs, and background processes.',
    category: 'Engineering',
    tags: ['backend', 'api', 'services'],
    capabilities: ['IPC design', 'data persistence', 'runtime diagnostics'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-testing',
    name: 'Test Automation',
    description: 'Create robust test suites and coverage strategies.',
    category: 'Quality',
    tags: ['testing', 'quality', 'automation'],
    capabilities: ['test planning', 'edge case coverage', 'CI validation'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-debugging',
    name: 'Debugging',
    description: 'Investigate issues, isolate root causes, and propose fixes.',
    category: 'Quality',
    tags: ['debugging', 'analysis', 'reliability'],
    capabilities: ['log tracing', 'reproduction steps', 'root cause analysis'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-research',
    name: 'Research',
    description: 'Synthesize sources, compare approaches, and summarize insights.',
    category: 'Discovery',
    tags: ['research', 'analysis', 'strategy'],
    capabilities: ['competitive analysis', 'trend synthesis', 'risk scanning'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-documentation',
    name: 'Documentation',
    description: 'Produce clear specs, handoffs, and user-facing docs.',
    category: 'Operations',
    tags: ['docs', 'handoff', 'communication'],
    capabilities: ['spec writing', 'release notes', 'handoff summaries'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-security',
    name: 'Security',
    description: 'Harden systems with encryption, auth, and auditing.',
    category: 'Security',
    tags: ['security', 'auth', 'encryption'],
    capabilities: ['threat modeling', 'access control', 'audit trails'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-performance',
    name: 'Performance Optimization',
    description: 'Analyze bottlenecks and improve throughput.',
    category: 'Optimization',
    tags: ['performance', 'profiling', 'optimization'],
    capabilities: ['profiling', 'latency tuning', 'resource efficiency'],
    version: '1.0.0',
    author: 'Hivemind',
  },
  {
    id: 'skill-devops',
    name: 'DevOps & Delivery',
    description: 'Automate builds, deployments, and infrastructure workflows.',
    category: 'Operations',
    tags: ['devops', 'deployment', 'ci/cd'],
    capabilities: ['pipeline design', 'release automation', 'infra monitoring'],
    version: '1.0.0',
    author: 'Hivemind',
  },
];

function getBuiltInSkills() {
  return BUILTIN_SKILLS.map(skill => ({
    ...skill,
    builtIn: true,
    createdAt: skill.createdAt || BUILTIN_CREATED_AT,
    updatedAt: skill.updatedAt || BUILTIN_CREATED_AT,
  }));
}

module.exports = { getBuiltInSkills };
