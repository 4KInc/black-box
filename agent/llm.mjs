// Model backends for the shopping agent, no SDKs. Returns the model's text reply.
//   claude-*        Anthropic Messages API (ANTHROPIC_API_KEY)
//   local:<model>   any OpenAI-compatible server, e.g. `mlx_lm.server` (LOCAL_LLM_URL)
export const DEFAULT_MODEL = process.env.AGENT_MODEL ?? 'claude-sonnet-5-5';

export async function anthropic({ system, user, model = DEFAULT_MODEL, maxTokens = 600 }) {
  if (model.startsWith('local:')) return local({ system, user, model: model.slice(6), maxTokens });
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
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: `${system}\n\n${user}` }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`local model ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { text: j.choices[0].message.content, model: `local:${model}` };
}
