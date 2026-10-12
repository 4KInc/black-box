// Anthropic Messages API, no SDK. Returns the model's text reply.
export const DEFAULT_MODEL = process.env.AGENT_MODEL ?? 'claude-sonnet-5-5';

export async function anthropic({ system, user, model = DEFAULT_MODEL, maxTokens = 600 }) {
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
