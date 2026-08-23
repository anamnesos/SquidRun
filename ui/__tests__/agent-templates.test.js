const { getBuiltInTemplates } = require('../modules/agent-templates');

const RETIRED_SETTING_KEYS = Object.freeze([
  'notifications',
  'agentNotify',
  'autoNudge',
  'voiceLanguage',
  'userPreferredStyle',
  'templates',
  'mcpAutoConfig',
  'firmwareInjectionEnabled',
  'userName',
  'userExperienceLevel',
  'devMode',
]);

describe('built-in agent templates', () => {
  test('do not advertise retired settings', () => {
    getBuiltInTemplates().forEach((template) => {
      RETIRED_SETTING_KEYS.forEach((key) => {
        expect(template.config).not.toHaveProperty(key);
      });
    });
  });
});
