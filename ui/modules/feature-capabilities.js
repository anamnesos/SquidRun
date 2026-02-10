/**
 * Feature Capability Registry
 * Computes backend feature availability from environment API keys.
 */

function hasKey(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getFeatureCapabilities(env = process.env) {
  const openaiAvailable = hasKey(env.OPENAI_API_KEY);
  const recraftAvailable = hasKey(env.RECRAFT_API_KEY);

  return {
    imageGenAvailable: recraftAvailable || openaiAvailable,
    voiceTranscriptionAvailable: openaiAvailable,
    recraftAvailable,
    openaiAvailable,
  };
}

module.exports = {
  getFeatureCapabilities,
  hasKey,
};
