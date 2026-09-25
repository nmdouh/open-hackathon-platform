'use strict';

const { HttpError } = require('./errors');

// Minimal client for any OpenAI-compatible chat completions endpoint
// (hosted providers, Azure OpenAI proxies, vLLM, Ollama, LM Studio, ...).
// The API key never leaves the server.
function llmEnabled(config) {
  return Boolean(config.llm && config.llm.endpoint && config.llm.model);
}

async function chat(config, messages, { temperature = 0.3, maxTokens = 1200 } = {}) {
  if (!llmEnabled(config)) throw new HttpError(503, 'AI_NOT_CONFIGURED', 'The AI assistant is not configured');
  const headers = { 'content-type': 'application/json' };
  if (config.llm.apiKey) headers.authorization = `Bearer ${config.llm.apiKey}`;
  let res;
  try {
    res = await fetch(config.llm.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.llm.model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(config.llm.timeoutMs || 45000),
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new HttpError(502, timeout ? 'AI_TIMEOUT' : 'AI_UNREACHABLE', 'The AI service did not respond');
  }
  if (res.status === 429) throw new HttpError(503, 'AI_BUSY', 'The AI service is busy, try again shortly');
  if (!res.ok) throw new HttpError(502, 'AI_ERROR', `The AI service answered ${res.status}`);
  const data = await res.json().catch(() => null);
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string') throw new HttpError(502, 'AI_BAD_RESPONSE', 'Unexpected AI response');
  return content;
}

// Models often wrap JSON in prose or code fences; take the outermost object.
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

module.exports = { llmEnabled, chat, extractJson };
