const { OpenAI } = require('openai');

// The model behind the agent and Chat: any API that speaks OpenAI's Chat
// Completions with tool calling. Chosen in .env:
//   AI_API_KEY          the provider's key (set it to switch provider)
//   AI_PROVIDER         openai (default) or deepseek; picks the defaults below
//   AI_MODEL            e.g. gpt-5-nano (openai's default)
//   AI_BASE_URL         only for another OpenAI-compatible endpoint (and tests)
//   AI_REASONING_EFFORT for reasoning models (gpt-5 family): minimal|low|medium|high
// Without AI_API_KEY, an older .env's DEEPSEEK_API_KEY still works (DeepSeek).
//
// OpenAI doesn't use API data for training (unless you opt in) and keeps abuse
// logs up to 30 days; DeepSeek may train on it and stores it in China. The
// dashboard names the provider in use (GET /api/auth/config -> ai).
const PROVIDERS = {
  openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-5-nano' },
  // deepseek-chat was retired (2026-07-24); deepseek-flash is its successor.
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' },
};

// Hidden reasoning is billed as output, so the gpt-5 family runs at `low`
// unless AI_REASONING_EFFORT says otherwise.
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

// { provider, name, apiKey, baseURL, model, reasoningEffort }, or null when no key is set.
function modelSettings(env = process.env) {
  const key = (env.AI_API_KEY || '').trim();
  const legacyKey = (env.DEEPSEEK_API_KEY || '').trim();
  if (!key && !legacyKey) return null;

  const provider = key ? (env.AI_PROVIDER || 'openai').trim().toLowerCase() : 'deepseek';
  const preset = PROVIDERS[provider] || { name: provider, baseURL: '', model: '' };
  const baseURL = (key ? env.AI_BASE_URL : env.DEEPSEEK_BASE_URL) || preset.baseURL;
  const model = (env.AI_MODEL || '').trim() || preset.model;
  const effort = (env.AI_REASONING_EFFORT || '').trim().toLowerCase();
  const reasoningEffort = REASONING_EFFORTS.includes(effort) ? effort : /^gpt-5/.test(model) ? 'low' : null;
  return { provider, name: preset.name, apiKey: key || legacyKey, baseURL, model, reasoningEffort };
}

function isConfigured(env = process.env) {
  const settings = modelSettings(env);
  return Boolean(settings && settings.baseURL && settings.model);
}

function createLLMClient() {
  const settings = modelSettings();
  if (!settings || !settings.baseURL || !settings.model) {
    // Not worth retrying: the job queue gives up on this one straight away.
    throw Object.assign(new Error('No AI model is set up (AI_API_KEY in .env) - skipping the LLM call'), { retryable: false });
  }
  return new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    timeout: 60 * 1000, // per model call; the SDK's default of 10 minutes would hold a job slot far too long
  });
}

// What every chat.completions.create call adds to its messages and tools.
function completionOptions(settings = modelSettings()) {
  return { model: settings.model, ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}) };
}

// For the dashboard: which provider reads the seller's data (no key, no URL).
function publicInfo() {
  const settings = modelSettings();
  return settings ? { provider: settings.provider, name: settings.name, model: settings.model } : null;
}

module.exports = { PROVIDERS, modelSettings, isConfigured, createLLMClient, completionOptions, publicInfo };
