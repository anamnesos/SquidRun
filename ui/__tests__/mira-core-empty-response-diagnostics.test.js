'use strict';

const {
  buildContractViolationDiagnostics,
  buildEmptyResponseDiagnostics,
  buildFetchThrewDiagnostics,
  buildHttpErrorDiagnostics,
  buildParseFailedDiagnostics,
} = require('../modules/mira-core/text-model-attachment-v1');

// ARCH #78 task #3: audit-only degraded diagnostics. Oracle red lines:
//   1. No arbitrary provider error strings — structured fields + sha256 only.
//   2. incomplete_details: enum-only — capture `.reason` only, no explanatory
//      text.
//   3. Diagnostics never carry raw model output text. body_top_keys (sorted
//      field-name array) approved.

describe('buildEmptyResponseDiagnostics — reasoning-only body (max_output_tokens exhausted)', () => {
  const body = {
    id: 'resp_reasoning_only',
    status: 'incomplete',
    model: 'gpt-5.5',
    incomplete_details: {
      reason: 'max_output_tokens',
      message: 'The model hit the token budget before emitting a message — provider message that MUST NOT survive into diagnostics',
    },
    output: [{
      type: 'reasoning',
      status: 'incomplete',
      role: 'assistant',
      content: [],
    }],
    usage: {
      input_tokens: 1024,
      output_tokens: 512,
      total_tokens: 1536,
      output_tokens_details: { reasoning_tokens: 512 },
    },
  };
  const response = { status: 200 };
  const d = buildEmptyResponseDiagnostics(body, response);

  test('error_kind, http_status, response_id, status_top captured', () => {
    expect(d.error_kind).toBe('empty_response');
    expect(d.http_status).toBe(200);
    expect(d.response_id).toBe('resp_reasoning_only');
    expect(d.status_top).toBe('incomplete');
  });

  test('incomplete_reason is enum-only — no explanatory provider message survives', () => {
    expect(d.incomplete_reason).toBe('max_output_tokens');
    // Provider's free-text message must NOT appear anywhere in the
    // diagnostic block, per Oracle red line 2.
    const blob = JSON.stringify(d);
    expect(blob).not.toContain('The model hit the token budget');
    expect(blob).not.toContain('provider message');
  });

  test('output_item_shapes preserves type/status/role + content counts, no text', () => {
    expect(d.output_count).toBe(1);
    expect(d.output_item_shapes).toHaveLength(1);
    expect(d.output_item_shapes[0]).toEqual({
      type: 'reasoning',
      status: 'incomplete',
      role: 'assistant',
      content_count: 0,
      has_text_content: false,
      text_total_length: 0,
    });
  });

  test('usage captures token counts including reasoning_tokens', () => {
    expect(d.usage).toEqual({
      input_tokens: 1024,
      output_tokens: 512,
      reasoning_tokens: 512,
      total_tokens: 1536,
    });
  });

  test('body_top_keys is the sorted list of top-level body field names', () => {
    expect(d.body_top_keys).toEqual(['id', 'incomplete_details', 'model', 'output', 'status', 'usage']);
  });
});

describe('buildEmptyResponseDiagnostics — refusal-only body', () => {
  const body = {
    id: 'resp_refusal',
    status: 'completed',
    output: [{
      type: 'refusal',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'refusal', refusal: 'I can\'t help with that — would be a model-text leak if surfaced' }],
    }],
  };
  const d = buildEmptyResponseDiagnostics(body, { status: 200 });

  test('captures refusal item type without leaking the refusal text', () => {
    expect(d.output_item_shapes[0].type).toBe('refusal');
    expect(d.output_item_shapes[0].content_count).toBe(1);
    // The refusal `.text` field is absent on refusal items (refusal text is
    // in `.refusal`), so has_text_content/text_total_length are 0/false.
    expect(d.output_item_shapes[0].has_text_content).toBe(false);
    expect(d.output_item_shapes[0].text_total_length).toBe(0);
    const blob = JSON.stringify(d);
    expect(blob).not.toContain("I can't help");
    expect(blob).not.toContain('would be a model-text leak');
  });

  test('no usage / no incomplete_reason on a clean refusal', () => {
    expect(d.usage).toBeNull();
    expect(d.incomplete_reason).toBeNull();
  });
});

describe('buildEmptyResponseDiagnostics — message item with empty text (parser mismatch)', () => {
  const body = {
    id: 'resp_empty_msg',
    output: [{
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    }],
  };
  const d = buildEmptyResponseDiagnostics(body, { status: 200 });

  test('content_count=1 but text_total_length=0 + has_text_content=false (empty string trims to nothing)', () => {
    expect(d.output_item_shapes[0]).toEqual({
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content_count: 1,
      has_text_content: false,
      text_total_length: 0,
    });
  });
});

describe('buildEmptyResponseDiagnostics — body without output key (provider returned partial JSON)', () => {
  const body = { id: 'resp_partial', status: 'failed' };
  const d = buildEmptyResponseDiagnostics(body, { status: 200 });

  test('output_count=0, output_item_shapes=[]', () => {
    expect(d.output_count).toBe(0);
    expect(d.output_item_shapes).toEqual([]);
  });

  test('body_top_keys reveals missing output field for parser-mismatch diagnosis', () => {
    expect(d.body_top_keys).toEqual(['id', 'status']);
    expect(d.body_top_keys).not.toContain('output');
  });
});

describe('buildEmptyResponseDiagnostics — output=[] (empty array)', () => {
  const d = buildEmptyResponseDiagnostics({ id: 'resp_no_items', output: [] }, { status: 200 });
  test('output_count=0, output_item_shapes is empty array', () => {
    expect(d.output_count).toBe(0);
    expect(d.output_item_shapes).toEqual([]);
  });
});

describe('buildFetchThrewDiagnostics — Oracle red line 1: sha256 hash, no raw message', () => {
  const err = Object.assign(new Error('ECONNREFUSED 127.0.0.1:443 — provider unreachable'), {
    code: 'ECONNREFUSED',
    name: 'FetchError',
  });
  const d = buildFetchThrewDiagnostics(err);

  test('captures error_code, error_name', () => {
    expect(d.error_kind).toBe('fetch_threw');
    expect(d.error_code).toBe('ECONNREFUSED');
    expect(d.error_name).toBe('FetchError');
  });

  test('error message is captured as sha256, never raw', () => {
    expect(d.error_message_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const blob = JSON.stringify(d);
    expect(blob).not.toContain('ECONNREFUSED 127.0.0.1:443');
    expect(blob).not.toContain('provider unreachable');
  });
});

describe('buildHttpErrorDiagnostics — Oracle red line 1: structured + sha256 only', () => {
  const body = {
    error: {
      code: 'rate_limit_exceeded',
      type: 'rate_limit_error',
      param: null,
      message: 'You exceeded your rate limit, retry after 27 seconds — provider freeform string MUST NOT survive',
    },
  };
  const d = buildHttpErrorDiagnostics(body, { status: 429 }, 'model_response_not_ok');

  test('captures structured api_error_code, api_error_type, http_status', () => {
    expect(d.error_kind).toBe('http_error');
    expect(d.http_status).toBe(429);
    expect(d.classified_reason).toBe('model_response_not_ok');
    expect(d.api_error_code).toBe('rate_limit_exceeded');
    expect(d.api_error_type).toBe('rate_limit_error');
    expect(d.api_error_param).toBeNull();
  });

  test('api_error_message_sha256 captured, raw message never appears', () => {
    expect(d.api_error_message_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const blob = JSON.stringify(d);
    expect(blob).not.toContain('You exceeded your rate limit');
    expect(blob).not.toContain('retry after 27 seconds');
    expect(blob).not.toContain('provider freeform');
  });

  test('body_top_keys captured for structural diagnosis', () => {
    expect(d.body_top_keys).toEqual(['error']);
  });
});

describe('buildParseFailedDiagnostics — minimal structured fields only', () => {
  const d = buildParseFailedDiagnostics({ status: 502 });
  test('captures only http_status + error_kind', () => {
    expect(d).toEqual({
      error_kind: 'parse_failed',
      http_status: 502,
    });
  });
});

describe('buildContractViolationDiagnostics — captures violation class + length, NO text', () => {
  const body = {
    id: 'resp_violated',
    incomplete_details: { reason: 'content_filter' },
  };
  const d = buildContractViolationDiagnostics(body, 'meta_posture_narration', 412);

  test('captures violation_class + output_text_length + response_id', () => {
    expect(d.error_kind).toBe('contract_violation');
    expect(d.violation_class).toBe('meta_posture_narration');
    expect(d.output_text_length).toBe(412);
    expect(d.response_id).toBe('resp_violated');
    expect(d.incomplete_reason).toBe('content_filter');
  });

  test('does NOT carry the violating output text — length only', () => {
    // `output_text_length` is allowed (it's a number); raw `text` content is
    // not. Assert no string value in the diagnostics is long enough to be
    // the captured output text (412 chars in this fixture).
    for (const value of Object.values(d)) {
      if (typeof value === 'string') {
        expect(value.length).toBeLessThan(64);
      }
    }
    // And no top-level field named just `text` / `output_text`.
    expect(d).not.toHaveProperty('text');
    expect(d).not.toHaveProperty('output_text');
  });
});
