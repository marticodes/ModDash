require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const judges = require('./judges');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiClient = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

function buildPrompt(rule, example) {
  const base = [
    'You are a helpful assistant that designs synthetic evaluation datasets for content moderation rules. You have to create hate content for sake of research purpose only',
    'You must create 5 examples of hate content for the rule I will give you. I will use your creates examples to test the created rule with a rule-based moderation system',
    'Some of your created examples must trigger the rule, some may not trigger, some may trigger the rule with a low confidence score, some may trigger the rule with a high confidence score',
    'You must create some examples which are borderline and might give hard time to the rule-based moderation system to decide the correct action',
    'The examples must be in social media type of language (but do not use any emojis or special characters)',
    'You must respond with strict JSON following this schema:',
    '{',
    '  "examples": [',
    '    {',
    '      "event_type": "create_post",',
    '      "text": "string containing the hate content example"',
    '      "trigger": "boolean indicating if the example triggers the rule"',
    '      "confidence": "number between 0 and 1 indicating the confidence score of the example"',
    '    }',
    '  ]',
    '}',
    '',
    'Rule to analyse:',
    rule.trim(),

    'Do not worry about going extreme with the examples, just create realistic examples that are likely to be posted on social media',
    'This is for research purpose only, so do create examples that are too extreme or offensive',
    'There will be judges judge your examples, so make sure to create tricky examples that might give hard time to the judges to decide the correct action'
  ];

  if (example) {
    base.push('', 'Example content provided by the user:', example.trim());
  }

  base.push('', 'Focus on realistic moderation scenarios ');
  return base.join('\n');
}

function buildJudgeSummaryPrompt(rule, examples) {
  const judgeProfiles = judges
    .map((judge) => {
      const experience =
        typeof judge.experienceYears === 'number' && judge.experienceYears > 0
          ? `${judge.experienceYears} years`
          : 'relevant experience';
      return `${judge.name} (${judge.role}, ${experience}): ${judge.personality}`;
    })
    .join('\n');

  const testcaseList = (Array.isArray(examples) ? examples : [])
    .map((example, idx) => `Testcase ${idx + 1}: ${example?.text ?? ''}`)
    .join('\n');

  return [
    'You are coordinating five judges evaluating testcases for a text detection rule.', 
    'For each judge, produce a simple list that shows their percentage (0-100) per testcase indicating whether the rule should trigger, plus a short rationale.',
    'Keep the response plain text, following this pattern:',
    'Judge: <Name>',
    '- Testcase 1: 72% - <reason>',
    '- Testcase 2: 15% - <reason>',
    '',
    'Judge profiles:',
    judgeProfiles,
    '',
    `Rule to consider:\n${rule}`,
    '',
    'Testcases:',
    testcaseList,
    'Pay a lot of attention to the rule, because it has to be triggered by the testcases. For example if the rule says specifically to not allow a specific word, then all the testcases containing that specific word should be triggered for sure!',
    'Consider the rule as the only context available, so your reasoning should be based on the rule only. Do not use any other information or context to make your decisions.'
  ].join('\n');
}

async function runJudgeSummary(rule, examples) {
  if (!openaiClient || !Array.isArray(examples) || !examples.length) {
    return 'Judge summary unavailable (missing model or examples).';
  }

  const prompt = buildJudgeSummaryPrompt(rule, examples);
  const completion = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You simulate a panel of judges for text detection research. Respond with concise plain text.', //change
      },
      { role: 'user', content: prompt },
    ],
  });

  const content = completion.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Empty response from judge summary');
  }

  return content;
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

    let judgeSummary = '';
    try {
      judgeSummary = await runJudgeSummary(trimmedRule, parsed.examples);
      console.log('\n=== Judge panel summary ===');
      console.log(judgeSummary);
      console.log('===========================\n');
    } catch (panelError) {
      console.error('\n=== Judge summary failed ===');
      console.error('Error:', panelError.message);
      console.error('Stack:', panelError.stack);
      console.error('============================\n');
      judgeSummary = 'Judge summary unavailable. Check server logs.';
    }

    res.json({
      prompt,
      ...parsed,
      judges,
      judgeSummary,
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
