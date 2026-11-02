// Model backends for the shopping agent, no SDKs. Returns the model's text reply.
//   claude-*        Anthropic Messages API (ANTHROPIC_API_KEY)
//   gpt-*, o<n>*    OpenAI Chat Completions (OPENAI_API_KEY)
//   gemini-*        Google Gemini, its OpenAI-compatible endpoint (GEMINI_API_KEY)
//   grok-*          xAI, its OpenAI-compatible endpoint (XAI_API_KEY)
//   local:<model>   any OpenAI-compatible server, e.g. `mlx_lm.server` (LOCAL_LLM_URL)
export const DEFAULT_MODEL = process.env.AGENT_MODEL ?? 'claude-sonnet-5-5';

// Hosted providers with an OpenAI-compatible Chat Completions API. Each is sent the system prompt
// as a system message and otherwise its own defaults (no temperature, no seed), as Claude is.
export const HOSTED = [
  { test: /^(gpt-|o\d)/, name: 'OpenAI API', base: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', tokens: 'max_completion_tokens' },
  { test: /^gemini-/, name: 'Google Gemini API', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'GEMINI_API_KEY', tokens: 'max_tokens' },
  { test: /^grok-/, name: 'xAI API', base: 'https://api.x.ai/v1', key: 'XAI_API_KEY', tokens: 'max_tokens' },
];
export const hostedFor = (model) => HOSTED.find((h) => h.test.test(model)) ?? null;

export async function anthropic({ system, user, model = DEFAULT_MODEL, maxTokens = 600 }) {
  if (model.startsWith('local:')) return local({ system, user, model: model.slice(6), maxTokens });
  const h = hostedFor(model);
  if (h) return hosted(h, { system, user, model, maxTokens });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (put it in black-box/.env)');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${j.error?.message ?? JSON.stringify(j)}`);
  return { text: j.content.filter((c) => c.type === 'text').map((c) => c.text).join(''), model: j.model };
}

export async function local({ system, user, model, maxTokens = 600 }) {
  const base = process.env.LOCAL_LLM_URL ?? 'http://localhost:8080/v1';
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // One user turn: some chat templates (e.g. Mistral) reject a separate system role.
    // LOCAL_LLM_TEMPERATURE (set by the study runner) samples; otherwise the server default applies.
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: `${system}\n\n${user}` }],
      ...(process.env.LOCAL_LLM_TEMPERATURE ? { temperature: Number(process.env.LOCAL_LLM_TEMPERATURE) } : {}) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`local model ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { text: j.choices[0].message.content, model: `local:${model}` };
}

export async function hosted(h, { system, user, model, maxTokens = 600, fetch: f = fetch }) {
  const key = process.env[h.key];
  if (!key) throw new Error(`${h.key} is not set (put it in black-box/.env)`);
  const r = await f(`${h.base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, [h.tokens]: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${h.name} ${r.status}: ${(j.error?.message ?? JSON.stringify(j)).slice(0, 300)}`);
  const text = j.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error(`${h.name}: empty reply (finish_reason ${j.choices?.[0]?.finish_reason ?? 'unknown'})`);
  return { text, model: j.model ?? model };
}
