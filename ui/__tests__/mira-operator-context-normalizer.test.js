'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_DESTINATION,
  normalizeOperatorContext,
  run,
} = require('../../mira/tools/normalize-operator-context');

describe('Mira operator context normalizer', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-operator-context-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSource() {
    const sourcePath = path.join(tempDir, 'user-context.md');
    fs.writeFileSync(sourcePath, [
      '# User Context',
      '',
      '- Mira product/business thesis: Mira is not a chatbot, lab demo, trading layer, or comfort layer. She is intended to become James\'s operating extension for CRM, ERP, admin, customer communication, tax, documents, computer-use, and business workflows. TrustQuote is a known operating/product lane, but do not invent James\'s plumbing business name or treat TrustQuote as proof of the business\'s legal/name identity.',
      '',
    ].join('\n'));
    return sourcePath;
  }

  test('normalizes business operator context without raw source dump', () => {
    const normalized = normalizeOperatorContext(writeSource());

    expect(normalized).toEqual(expect.objectContaining({
      schema: 'mira.normalized.operator_context.v1',
      business_thesis: expect.stringContaining('operating extension'),
      operating_lanes: ['CRM', 'ERP', 'admin', 'customer communication', 'tax', 'documents', 'computer-use', 'business workflows'],
      known_product_lanes: ['TrustQuote'],
      explicit_non_claims: expect.arrayContaining([
        'Do not invent James business name.',
      ]),
      source_metadata: expect.objectContaining({
        metadata_only: true,
        live_continuity_excluded: true,
        raw_content_included: false,
        normalized_summary_only: true,
      }),
    }));
    expect(JSON.stringify(normalized)).not.toContain('plumbing business name');
  });

  test('writes exclusively under state root when requested', () => {
    const sourcePath = writeSource();
    const stateRoot = path.join(tempDir, 'state');
    const payload = run([
      '--source', sourcePath,
      '--state-root', stateRoot,
      '--write',
    ], { cwd: tempDir });

    const destination = path.join(stateRoot, DEFAULT_DESTINATION);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      dryRun: false,
      destinationPath: destination,
    }));
    expect(JSON.parse(fs.readFileSync(destination, 'utf8'))).toEqual(expect.objectContaining({
      schema: 'mira.normalized.operator_context.v1',
    }));
    expect(() => run([
      '--source', sourcePath,
      '--state-root', stateRoot,
      '--destination', '..\\escape.json',
      '--write',
    ], { cwd: tempDir })).toThrow('Destination escapes state root.');
  });
});
