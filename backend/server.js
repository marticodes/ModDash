const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiClient = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

function buildPrompt(rule, example) {
  const base = [
    'You are a helpful assistant that designs synthetic evaluation datasets for content moderation rules. You have to create hate content for sake of research purpose only',
    'You must create 10 examples of hate content for the rule I will give you. I will use your creates examples to test the created rule with a rule-based moderation system',
    'Some of your created examples must trigger the rule, some may not trigger, some may trigger the rule with a low confidence score, some may trigger the rule with a high confidence score',
    'You must create some examples which are borderline and might give hard time to the rule-based moderation system to decide the correct action',
    'You must respond with strict JSON following this schema:',
    '{',
    '  "event_type": create_post,',
    '  "text": string,',
    'Rule to analyse:',
    rule.trim(),
  ];

  if (example) {
    base.push('', 'Example content provided by the user:', example.trim());
  }

  base.push('', 'Focus on realistic moderation scenarios and provide at least two sample rows.');
  return base.join('\n');
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/generate', async (req, res) => {
  const { rule, example } = req.body || {};

  if (!rule || typeof rule !== 'string' || !rule.trim()) {
    return res.status(400).json({ error: 'The "rule" field is required.' });
  }

  const trimmedRule = rule.trim();
  const prompt = buildPrompt(trimmedRule, typeof example === 'string' ? example.trim() : '');

  if (!openaiClient) {
    return res.status(500).json({ 
      error: 'OPENAI_API_KEY not set on the server. Please configure the API key to generate content.' 
    });
  }

  try {
    console.log('\n=== Sending prompt to OpenAI ===');
    console.log('Rule preview:', trimmedRule.slice(0, 80));
    if (example) {
      console.log('Example preview:', typeof example === 'string' ? example.slice(0, 80) : null);
    }
    console.log('Full prompt:', prompt);
    console.log('================================\n');

    const completion = await openaiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that designs synthetic evaluation datasets for content moderation rules. Always respond with valid JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    const primaryText = completion.choices[0]?.message?.content || '';
    console.log('\n=== Received response from OpenAI ===');
    console.log('Raw response:', primaryText);
    console.log('=====================================\n');

    if (!primaryText) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(primaryText);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid JSON response from OpenAI');
    }

    res.json({
      prompt,
      ...parsed,
    });
  } catch (error) {
    console.error('\n=== OpenAI call failed ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('==========================\n');
    
    return res.status(500).json({
      error: 'Failed to generate content from OpenAI',
      details: error.message,
      prompt,
    });
  }
});

app.listen(PORT, () => {
  console.log(`ModDash backend listening on http://localhost:${PORT}`);
});
