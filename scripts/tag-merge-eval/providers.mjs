// Model adapters for the eval. Each takes the tag vocabulary and returns an
// array of { canonical, tags: [name...], confidence }. fetch-based, no deps.
// Keys come from the environment; nothing is hard-coded.

import { systemInstruction, buildUserPrompt, RESPONSE_SCHEMA } from './prompt.mjs';

function parseGroups(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const obj = JSON.parse(t);
  const groups = Array.isArray(obj?.groups) ? obj.groups : [];
  return groups.map((g) => ({
    canonical: g.canonical,
    tags: Array.isArray(g.tags) ? g.tags : [],
    confidence: Number(g.confidence) || 0,
  }));
}

// Gemini's responseSchema uses UPPERCASE type names (OpenAPI subset).
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (s && typeof s === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : toGeminiSchema(v);
    }
    return out;
  }
  return s;
}

export async function runGemini(tags, { model = 'gemini-2.5-flash', apiKey, temperature = 0.1 }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction() }] },
      contents: [{ role: 'user', parts: [{ text: buildUserPrompt(tags) }] }],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(RESPONSE_SCHEMA),
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text ?? '').join('') ?? '';
  return parseGroups(text);
}

export async function runAnthropic(tags, { model, apiKey, temperature = 0.1 }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!model) throw new Error('Anthropic model id required (--model)');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature,
      system:
        systemInstruction() +
        '\n\nRespond with ONLY a JSON object of the form {"groups":[{"canonical":string,"tags":[string],"confidence":number}]}. No prose, no code fences.',
      messages: [{ role: 'user', content: buildUserPrompt(tags) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.content?.map((b) => b?.text ?? '').join('') ?? '';
  return parseGroups(text);
}

export const PROVIDERS = {
  gemini: (tags, opts) => runGemini(tags, { ...opts, apiKey: process.env.GEMINI_API_KEY }),
  anthropic: (tags, opts) => runAnthropic(tags, { ...opts, apiKey: process.env.ANTHROPIC_API_KEY }),
};
