const OpenAI = require('openai');

const DEFAULT_SYSTEM_PROMPT =
  'You are an expert email marketer specializing in subject line optimization. ' +
  'Your goal is to write one single alternative email subject line that could beat ' +
  'the current winning subject line in an A/B open-rate test. The new subject line ' +
  'should be compelling, curiosity-driven, and different in approach from the winner. ' +
  'Return ONLY the subject line text — no quotes, no explanation, no extra text.';

async function generateChallengerSubject({
  apiKey,
  model = 'gpt-4o-mini',
  systemPrompt,
  currentWinner,
}) {
  if (!apiKey) {
    const err = new Error('OpenAI API key not configured. An admin needs to set it in /admin.');
    err.userFacing = true;
    throw err;
  }
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `The current winning subject line is: "${currentWinner}"\n\nWrite one alternative subject line that might beat it in open rate.`,
      },
    ],
    temperature: 0.9,
  });
  const text = completion.choices?.[0]?.message?.content || '';
  return text.replace(/^["']|["']$/g, '').trim();
}

module.exports = { generateChallengerSubject, DEFAULT_SYSTEM_PROMPT };
