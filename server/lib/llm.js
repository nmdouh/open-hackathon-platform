'use strict';

const { HttpError } = require('./errors');

// Minimal client for any OpenAI-compatible chat completions endpoint
// (hosted providers, Azure OpenAI proxies, vLLM, Ollama, LM Studio, ...).
// `llm` is the effective configuration from lib/settings.js. The API key
// never leaves the server.
function llmEnabled(llm) {
  return Boolean(llm && llm.enabled && llm.endpoint && llm.model);
}

async function chat(llm, messages, { temperature = 0.3, maxTokens = 1200 } = {}) {
  if (!llmEnabled(llm)) throw new HttpError(503, 'AI_NOT_CONFIGURED', 'The AI assistant is not configured');
  const headers = { 'content-type': 'application/json' };
  if (llm.apiKey) headers.authorization = `Bearer ${llm.apiKey}`;
  let res;
  try {
    res = await fetch(llm.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: llm.model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(llm.timeoutMs || 45000),
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new HttpError(502, timeout ? 'AI_TIMEOUT' : 'AI_UNREACHABLE', 'The AI service did not respond');
  }
  if (res.status === 429) throw new HttpError(503, 'AI_BUSY', 'The AI service is busy, try again shortly');
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'AI_AUTH_FAILED', 'The AI service rejected the API key');
  if (res.status === 404) throw new HttpError(502, 'AI_NOT_FOUND', 'The AI endpoint or model was not found');
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
