import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hosted, hostedFor } from '../llm.mjs';

test('GPT, Gemini and Grok models go to their own provider; others do not', () => {
  assert.deepEqual(['gpt-5', 'o4-mini', 'gemini-2.5-pro', 'grok-4', 'muse-spark-1.3'].map((m) => hostedFor(m).name), ['OpenAI API', 'OpenAI API', 'Google Gemini API', 'xAI API', 'Meta Model API']);
  assert.equal(hostedFor('muse-wonder-1.0').tokens, 'max_completion_tokens');
  for (const m of ['claude-opus-5-5', 'local:mlx-community/Qwen2.5-7B-Instruct-4bit', 'ollama']) assert.equal(hostedFor(m), null);
});

test('a hosted call sends the system prompt as a system message, with the key, and no sampling settings', async () => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ model: 'gpt-5-2026', choices: [{ message: { content: '{"sku":null}' } }] }) }; };
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const out = await hosted(hostedFor('gpt-5'), { system: 'S', user: 'U', model: 'gpt-5', fetch: f });
    assert.deepEqual(out, { text: '{"sku":null}', model: 'gpt-5-2026' });
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { model: 'gpt-5', max_completion_tokens: 600, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
  } finally { delete process.env.OPENAI_API_KEY; }
});

test('a hosted call fails clearly without its key, on an API error, and on an empty reply', async () => {
  delete process.env.XAI_API_KEY;
  await assert.rejects(hosted(hostedFor('grok-4'), { system: 'S', user: 'U', model: 'grok-4' }), /XAI_API_KEY is not set/);
  process.env.XAI_API_KEY = 'k';
  try {
    const err = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'model not found' } }) });
    await assert.rejects(hosted(hostedFor('grok-4'), { system: 'S', user: 'U', model: 'grok-4', fetch: err }), /xAI API 404: model not found/);
    const empty = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) });
    await assert.rejects(hosted(hostedFor('grok-4'), { system: 'S', user: 'U', model: 'grok-4', fetch: empty }), /empty reply \(finish_reason length\)/);
  } finally { delete process.env.XAI_API_KEY; }
});
