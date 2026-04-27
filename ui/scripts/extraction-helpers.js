const VALID_CATEGORIES = new Set(['fact', 'preference', 'workflow', 'system_state', 'observation']);

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(1, numeric));
}

function buildTranscriptFromPayload(payload = {}) {
  if (Array.isArray(payload.episodes) && payload.episodes.length > 0) {
    return payload.episodes
      .map((episode, index) => {
        const sender = normalizeText(episode?.senderRole || episode?.sender || 'unknown');
        const target = normalizeText(episode?.targetRole || episode?.target || 'unknown');
        const body = normalizeText(episode?.rawBody || episode?.message || '');
        if (!body) return null;
        return `${index + 1}. ${sender} -> ${target}: ${body}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  if (Array.isArray(payload.transcript)) {
    return payload.transcript.map((entry) => normalizeText(entry)).filter(Boolean).join('\n');
  }

  return normalizeText(payload.transcript || payload.summary || payload.text || '');
}

function buildExtractionPrompt(payload = {}) {
  const transcript = buildTranscriptFromPayload(payload);
  return [
    'You extract durable, structured facts from SquidRun transcripts.',
    'Return JSON only.',
    'Return an array of objects with exactly these keys: fact, category, confidence.',
    'Use category values from: fact, preference, workflow, system_state, observation.',
    'Confidence must be a number between 0 and 1.',
    'Keep only durable facts, stable preferences, established workflow rules, or concrete system state.',
    'Do not invent facts.',
    'Transcript:',
    transcript || '[empty transcript]',
  ].join('\n');
}

function validateExtractionArray(items) {
  if (!Array.isArray(items)) {
    throw new Error('extraction_output_not_array');
  }
  return items.map((item) => {
    const fact = normalizeText(item?.fact);
    const category = normalizeText(item?.category);
    const confidence = clampConfidence(item?.confidence);
    if (!fact) {
      throw new Error('extraction_item_missing_fact');
    }
    if (!category || !VALID_CATEGORIES.has(category)) {
      throw new Error(`extraction_item_invalid_category:${category || 'missing'}`);
    }
    if (confidence === null) {
      throw new Error('extraction_item_invalid_confidence');
    }
    return {
      fact,
      category,
      confidence,
    };
  });
}

function dedupeFacts(items) {
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const key = `${item.category}:${item.fact.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(item);
  }
  return normalized.slice(0, 32);
}

module.exports = {
  VALID_CATEGORIES,
  buildExtractionPrompt,
  buildTranscriptFromPayload,
  dedupeFacts,
  validateExtractionArray,
};
