const fs = require('fs');
const os = require('os');
const path = require('path');

describe('modelPromptReceipt contract', () => {
  let tempDir;
  let receipt;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-receipts-'));
    process.env.SQUIDRUN_MODEL_PROMPT_RECEIPT_DIR = tempDir;
    jest.resetModules();
    receipt = require('../modules/model-prompt-receipt');
  });

  afterEach(() => {
    delete process.env.SQUIDRUN_MODEL_PROMPT_RECEIPT_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.resetModules();
  });

  test('records a semantic prompt_submit receipt with in-band status', () => {
    const result = receipt.appendModelPromptReceipt({
      runtime: 'codex',
      hookEventName: 'UserPromptSubmit',
      payload: {
        prompt: 'hello\n[SQUIDRUN_RECEIPT event=prompt_submit deliveryId=delivery-1 messageId=hm-1]',
      },
    }, { now: '2026-06-12T23:00:00.000Z' });

    expect(result.ok).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.receipt).toEqual(expect.objectContaining({
      semanticEvent: 'prompt_submit',
      status: 'prompt_submitted.in_band',
      runtime: 'codex',
      versionFloor: '0.139.0',
      deliveryId: 'delivery-1',
      messageId: 'hm-1',
      payloadDropped: true,
    }));
    expect(receipt.getModelPromptReceipt('hm-1').deliveryId).toBe('delivery-1');
  });

  test('keeps first receipt and counts duplicate deliveryId receipts', () => {
    const payload = {
      prompt: 'first\n[SQUIDRUN_RECEIPT event=prompt_submit deliveryId=delivery-dup messageId=hm-first]',
    };
    const first = receipt.appendModelPromptReceipt({
      runtime: 'claude',
      hookEventName: 'UserPromptSubmit',
      payload,
    }, { now: '2026-06-12T23:00:00.000Z' });

    const duplicate = receipt.appendModelPromptReceipt({
      runtime: 'claude',
      hookEventName: 'UserPromptSubmit',
      payload: {
        prompt: 'second\n[SQUIDRUN_RECEIPT event=prompt_submit deliveryId=delivery-dup messageId=hm-second]',
      },
    }, { now: '2026-06-12T23:01:00.000Z' });

    const state = receipt.readState();
    expect(first.receipt.messageId).toBe('hm-first');
    expect(duplicate.status).toBe('duplicate_ignored');
    expect(duplicate.receipt.messageId).toBe('hm-first');
    expect(state.duplicateCounts['delivery-dup']).toBe(1);
    expect(state.stats.duplicateReceiptCount).toBe(1);
  });

  test('rejects unproven runtime hook mappings and missing markers', () => {
    const wrongMapping = receipt.appendModelPromptReceipt({
      runtime: 'gemini',
      hookEventName: 'UserPromptSubmit',
      payload: {
        prompt: '[SQUIDRUN_RECEIPT event=prompt_submit deliveryId=delivery-g messageId=hm-g]',
      },
    });
    const missingMarker = receipt.appendModelPromptReceipt({
      runtime: 'gemini',
      hookEventName: 'BeforeAgent',
      payload: {
        prompt: 'plain prompt',
      },
    });

    expect(wrongMapping.status).toBe('mapping_mismatch');
    expect(missingMarker.status).toBe('marker_missing');
  });

  test('receipt proof outranks accepted.unverified in ACK overlays', () => {
    receipt.appendModelPromptReceipt({
      runtime: 'gemini',
      hookEventName: 'BeforeAgent',
      payload: {
        prompt: 'marked\n[SQUIDRUN_RECEIPT event=prompt_submit deliveryId=hm-overlay messageId=hm-overlay]',
      },
    });

    const ack = receipt.applyModelPromptReceiptToAck({
      type: 'send-ack',
      messageId: 'hm-overlay',
      ok: true,
      accepted: true,
      queued: true,
      verified: false,
      status: 'accepted.unverified',
    }, {
      messageId: 'hm-overlay',
      deliveryId: 'hm-overlay',
    });

    expect(ack.status).toBe('prompt_submitted.in_band');
    expect(ack.verified).toBe(true);
    expect(ack.modelPromptReceipt).toEqual(expect.objectContaining({
      status: 'prompt_submitted.in_band',
      payloadDropped: true,
    }));
  });

  test('installs ignored hook wiring idempotently for fresh clones', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-hook-install-'));
    try {
      fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.codex', 'hooks.json'), JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: 'startup|resume|clear|compact',
            hooks: [{ type: 'command', command: 'bash session-start.sh' }],
          }],
        },
      }), 'utf8');
      fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), JSON.stringify({
        permissions: { defaultMode: 'bypassPermissions' },
        hooks: {},
      }), 'utf8');
      fs.writeFileSync(path.join(projectRoot, '.gemini', 'settings.json'), JSON.stringify({
        hooks: {},
      }), 'utf8');

      const first = receipt.installModelPromptReceiptHooks({ projectRoot });
      const second = receipt.installModelPromptReceiptHooks({ projectRoot });
      const codex = JSON.parse(fs.readFileSync(path.join(projectRoot, '.codex', 'hooks.json'), 'utf8'));
      const claude = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.json'), 'utf8'));
      const gemini = JSON.parse(fs.readFileSync(path.join(projectRoot, '.gemini', 'settings.json'), 'utf8'));

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(JSON.stringify(codex)).toContain('model-prompt-receipt-adapter.js');
      expect(JSON.stringify(codex)).toContain('--trust-check-only');
      expect(JSON.stringify(claude)).toContain('model-prompt-receipt-adapter.js');
      expect(JSON.stringify(gemini)).toContain('BeforeAgent');
      expect(JSON.stringify(gemini)).toContain('model-prompt-receipt-adapter.js');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
