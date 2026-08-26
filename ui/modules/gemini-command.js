const DEFAULT_GEMINI_MODEL_ID = 'gemini-3.1-pro-preview';
const GEMINI_MODEL_ENV_KEY = 'SQUIDRUN_GEMINI_MODEL';
const GEMINI_COMMAND_PATTERN = /(?:^|\s)gemini(?:\s|$)/i;
const GEMINI_MODEL_PATTERN = /(?:^|\s)(?:-m|--model)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i;
const GEMINI_INCLUDE_DIR_PATTERN = /(?:^|\s)--include-directories(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i;

function asNonEmptyString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sanitizeGeminiModelId(value) {
  const candidate = asNonEmptyString(value);
  if (!candidate) return '';
  if (!/^[A-Za-z0-9._/-]+$/.test(candidate)) return '';
  return candidate;
}

function parseGeminiModelFromCommand(command = '') {
  const text = asNonEmptyString(command);
  if (!text || !GEMINI_COMMAND_PATTERN.test(text)) return '';

  const match = text.match(GEMINI_MODEL_PATTERN);
  if (!match) return '';
  return sanitizeGeminiModelId(match[1] || match[2] || match[3] || '');
}

function parseGeminiIncludeDirectoryFromCommand(command = '') {
  const text = asNonEmptyString(command);
  if (!text || !GEMINI_COMMAND_PATTERN.test(text)) return '';

  const match = text.match(GEMINI_INCLUDE_DIR_PATTERN);
  if (!match) return '';
  return asNonEmptyString(match[1] || match[2] || match[3] || '');
}

function resolveGeminiModelId(options = {}) {
  const preferred = sanitizeGeminiModelId(options.preferredModel);
  if (preferred) return preferred;

  const fromCommand = parseGeminiModelFromCommand(options.existingCommand);
  if (fromCommand) return fromCommand;

  const fallback = sanitizeGeminiModelId(options.fallbackModel);
  if (fallback) return fallback;

  const fromEnv = sanitizeGeminiModelId(process.env[GEMINI_MODEL_ENV_KEY]);
  if (fromEnv) return fromEnv;

  return DEFAULT_GEMINI_MODEL_ID;
}

function hasGeminiCommand(command = '') {
  return GEMINI_COMMAND_PATTERN.test(asNonEmptyString(command));
}

function ensureGeminiModelFlag(command = '', options = {}) {
  const text = asNonEmptyString(command);
  if (!hasGeminiCommand(text)) return text;
  if (parseGeminiModelFromCommand(text)) return text;

  const modelId = resolveGeminiModelId({
    preferredModel: options.preferredModel,
    existingCommand: text,
    fallbackModel: options.fallbackModel,
  });
  return `${text} --model ${modelId}`.trim();
}

function buildGeminiCommand(options = {}) {
  const modelId = resolveGeminiModelId(options);
  return `gemini --yolo --model ${modelId}`;
}

module.exports = {
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_MODEL_ENV_KEY,
  hasGeminiCommand,
  ensureGeminiModelFlag,
  parseGeminiIncludeDirectoryFromCommand,
  parseGeminiModelFromCommand,
  resolveGeminiModelId,
  buildGeminiCommand,
};
