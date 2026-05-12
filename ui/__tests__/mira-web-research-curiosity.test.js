'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_WEB_RESEARCH_CURIOSITY_SCHEMA,
  readMiraWebResearchCuriosity,
} = require('../modules/mira-web-research-curiosity');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-web-research-'));
}

describe('Mira web research curiosity', () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  test('reads compact local research artifacts and strips raw URL queries', () => {
    projectRoot = tempProject();
    const researchDir = path.join(projectRoot, 'workspace', 'research');
    fs.mkdirSync(researchDir, { recursive: true });
    fs.writeFileSync(path.join(researchDir, 'ai-market-research.md'), [
      '# AI Market Research',
      '',
      'Relevant sources include https://example.com/report?token=secret#private and https://news.example.org/deep/path?q=hidden.',
      '',
      'The notes summarize saved research context without needing a live crawl.',
    ].join('\n'), 'utf8');

    const result = readMiraWebResearchCuriosity({}, { projectRoot });

    expect(result.schema).toBe(MIRA_WEB_RESEARCH_CURIOSITY_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('web_research_artifacts_read_only');
    expect(result.result_count).toBe(1);
    expect(result.results[0]).toEqual(expect.objectContaining({
      source_bucket: 'workspace_research',
      path: 'workspace/research/ai-market-research.md',
      title: 'AI Market Research',
      domains: expect.arrayContaining(['example.com', 'news.example.org']),
      safe_urls: expect.arrayContaining([
        'https://example.com/report',
        'https://news.example.org/deep/path',
      ]),
    }));
    expect(JSON.stringify(result)).not.toMatch(/token=secret|q=hidden|#private|\?/);
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      internal_only: true,
      read_only: true,
      network_performed: false,
      browser_mutation_performed: false,
      raw_query_strings_exposed: false,
      external_send_performed: false,
    }));
  });

  test('reports unavailable when no research artifacts exist', () => {
    projectRoot = tempProject();
    const result = readMiraWebResearchCuriosity({}, { projectRoot });

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('unavailable_in_this_runtime');
    expect(result.reason).toBe('web_research_artifacts_missing');
    expect(result.result_count).toBe(0);
    expect(result.no_mutation_performed).toBe(true);
  });
});
