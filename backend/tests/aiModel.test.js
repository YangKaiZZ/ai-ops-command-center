const test = require('node:test');
const assert = require('node:assert/strict');

const { modelSettings, isConfigured, completionOptions } = require('../src/services/aiModel');

test('no key at all means no model', () => {
  assert.equal(modelSettings({}), null);
  assert.equal(modelSettings({ AI_API_KEY: '  ', DEEPSEEK_API_KEY: '' }), null);
  assert.equal(isConfigured({}), false);
});

test('an AI_API_KEY alone means OpenAI with gpt-5-nano at low reasoning', () => {
  const s = modelSettings({ AI_API_KEY: 'sk-test' });
  assert.equal(s.provider, 'openai');
  assert.equal(s.name, 'OpenAI');
  assert.equal(s.model, 'gpt-5-nano');
  assert.equal(s.baseURL, 'https://api.openai.com/v1');
  assert.equal(s.reasoningEffort, 'low');
  assert.deepEqual(completionOptions(s), { model: 'gpt-5-nano', reasoning_effort: 'low' });
  assert.equal(isConfigured({ AI_API_KEY: 'sk-test' }), true);
});

test('blank settings passed through by docker compose fall back to the defaults', () => {
  const s = modelSettings({ AI_API_KEY: 'k', AI_PROVIDER: '', AI_MODEL: '', AI_BASE_URL: '', AI_REASONING_EFFORT: '' });
  assert.equal(s.provider, 'openai');
  assert.equal(s.model, 'gpt-5-nano');
  assert.equal(s.baseURL, 'https://api.openai.com/v1');
  assert.equal(s.reasoningEffort, 'low');
});

test('the model, reasoning effort and endpoint can be overridden', () => {
  const s = modelSettings({
    AI_API_KEY: 'k',
    AI_MODEL: 'gpt-5-mini',
    AI_REASONING_EFFORT: 'MEDIUM',
    AI_BASE_URL: 'http://localhost:9999/v1',
  });
  assert.equal(s.model, 'gpt-5-mini');
  assert.equal(s.reasoningEffort, 'medium');
  assert.equal(s.baseURL, 'http://localhost:9999/v1');
});

test('an unknown reasoning effort is ignored', () => {
  assert.equal(modelSettings({ AI_API_KEY: 'k', AI_REASONING_EFFORT: 'extreme' }).reasoningEffort, 'low');
});

test('models outside the gpt-5 family get no reasoning_effort', () => {
  const s = modelSettings({ AI_API_KEY: 'k', AI_PROVIDER: 'deepseek' });
  assert.equal(s.name, 'DeepSeek');
  assert.equal(s.model, 'deepseek-flash');
  assert.equal(s.reasoningEffort, null);
  assert.deepEqual(completionOptions(s), { model: 'deepseek-flash' });
});

test('an older DEEPSEEK_API_KEY still works, as DeepSeek', () => {
  const s = modelSettings({ DEEPSEEK_API_KEY: 'ds-key', DEEPSEEK_BASE_URL: 'http://localhost:1/v1' });
  assert.equal(s.provider, 'deepseek');
  assert.equal(s.apiKey, 'ds-key');
  assert.equal(s.baseURL, 'http://localhost:1/v1');
  assert.equal(s.model, 'deepseek-flash');
});

test('AI_API_KEY wins over the older key', () => {
  const s = modelSettings({ AI_API_KEY: 'new', DEEPSEEK_API_KEY: 'old' });
  assert.equal(s.apiKey, 'new');
  assert.equal(s.provider, 'openai');
});

test('an unknown provider needs an endpoint and a model of its own', () => {
  assert.equal(isConfigured({ AI_API_KEY: 'k', AI_PROVIDER: 'other' }), false);
  assert.equal(isConfigured({ AI_API_KEY: 'k', AI_PROVIDER: 'other', AI_BASE_URL: 'http://x/v1', AI_MODEL: 'm' }), true);
});
