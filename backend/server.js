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

function buildPrompt(rule, example, count) {
  const safeCount = Number.isFinite(count) && count > 0 ? count : 15;

  const base = [
    'You are a helpful assistant that designs synthetic evaluation datasets for content moderation rules. Your goal is to create realistic, BORDERLINE social-media posts that test the edges of the given moderation rule.',
    `Produce exactly ${safeCount} examples (no more, no less).`,
    '',
    'OUTPUT FORMAT: Respond with strict JSON only, matching this schema:',
    '{',
    '  "examples": [',
    '    {',
    '      "id": "string unique id",',
    '      "text": "string (the post text, social-media style, no emojis)",',
    '      "should_trigger": "one of: true, false, ambiguous",',
    '      "confidence": "number between 0.0 and 1.0 (model-estimated confidence that rule would trigger)",',
    '      "obfuscation_type": "one of: exact, substring, homophone, leet, spacing/punct-split, morphological, compound, slang, reclaimed, quoted, sarcastic, code-mixed, other",',
    '      "target_is_protected": "boolean or null if ambiguous",',
    '      "difficulty": "integer 1-5 (1=easy, 5=very hard to moderate)",',
    '      "rationale": "brief explanation (1-2 sentences) why this is borderline or tricky for the rule-based system"',
    '    }',
    '  ]',
    '}',
    '',
    'INSTRUCTIONS — generate BORDERLINE and HARD cases. To do that, follow this two-step generation process BEFORE emitting the JSON:',
    '1) FIRST produce (internally) a short list of distinct borderline scenario types that are relevant to the rule. Examples of scenario types you should consider (but do not limit yourself):',
    '   - substring (target string occurs as part of another word or token)',
    '   - morphological/inflectional variant (prefixes, suffixes, gerunds, participles)',
    '   - spacing / punctuation splitting (e.g., d.o.g, do g, dog-)',
    '   - repeated letters or elongated forms (dooog, dooggg)',
    '   - leetspeak (d0g, dOg, d@g)',
    '   - homophone / near-homophone',
    '   - compound words and concatenations (doghouse, dogwalker)',
    '   - slang / reclaimed uses (slang where the target is a person, not an animal)',
    '   - quoting or reporting speech (\"they said "dog"\")',
    '   - negation/irony (\"not a dog\") and sarcastic uses',
    '   - ambiguous named entity (a person named Dog, a product named Dog)',
    '   - code-mixing / other languages where the token appears but meaning differs',
    '   - benign technical term, e.g., protein name, place, or hobby that contains the string',
    '   - false positives caused by punctuation, hashtags, or usernames (#doggo, @doglover)',
    '',
    '2) THEN for each scenario, craft realistic social-media-style posts that exemplify the scenario and are as ambiguous/edge-case as possible. Aim for a balanced mix across:',
    '   - should_trigger: roughly 30% true, 10% false, 60% ambiguous',
    '   - obfuscation types: cover at least 6 different types listed above',
    '   - target_is_protected: include both protected and non-protected targets where relevant, and mark null if genuinely ambiguous',
    '',
    'ADDITIONAL GUIDELINES:',
    '- Keep posts short (one or two sentences typical for social media). No emojis, no images.',
    '- Use natural, realistic phrasing and community tone. Avoid contrived nonsense like repeated punctuation beyond realistic emphasis.',
    '- Do NOT invent extreme slurs or explicit hateful content. The goal is subtle boundary cases, not shock content.',
    '- For each example include a concise rationale explaining why this case is hard for a rule-based system (1-2 sentences).',
    '- Use unique ids (e.g., "case-01") and do not repeat texts.',
    '',
    'Rule to analyze:',
    rule.trim()
  ];

  if (example) {
    base.push(
      '',
      'Example content provided by the user. New examples should be similar in difficulty to moderate:',
      example.trim()
    );
  }

  base.push('', 'Focus on realistic moderation scenarios and on producing explicit rationales and metadata for each example.');
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
      'You are coordinating five judges evaluating testcases for a text-detection rule.',
      '',
      'GOAL: For each judge and each testcase produce exactly one percentage (0-100) that represents the JUDGE\'S final opinion on how likely the rule SHOULD trigger. Keep the exact plain-text outcome format used previously.',
      '',
      'MANDATES (must follow):',
      '- The RULE is the only policy source. Judges must not replace rule logic with moral or external context.',
      '- Each rationale MUST begin with an ORACLE tag that states the literal parsing result used for automated checking. Format: `ORACLE: applies` or `ORACLE: does not apply` or `ORACLE: ambiguous`.',
      '- After the ORACLE tag, include a 1-sentence human rationale that explains nuance or why your opinion differs from the oracle.',
      '- The single percent you output is the judge\'s final opinion (0-100). It should reflect human nuance and may differ from the oracle, but if you differ, your rationale MUST explain the discrepancy (e.g., quoting/quotation, reclaimed slang, compound word).',
      '- For clear-cut literal matches (oracle deterministic match) prefer percentages ≥ 70. For clear-cut non-matches prefer ≤ 30. For borderline/ambiguous cases prefer values in the range 20–80.',
      '',
      'OUTPUT FORMAT (plain text, follow this EXACT pattern):',
      'Judge: <Name>',
      '- Testcase 1: <0-100>% - ORACLE: <applies|does not apply|ambiguous> - <1-sentence rationale and any discrepancy note>',
      '- Testcase 2: <0-100>% - ORACLE: <applies|does not apply|ambiguous> - <1-sentence rationale and any discrepancy note>',
      '',
      'EXTRA RULE PARSING DEFAULTS (apply unless explicitly stated in rationale):',
      '- case_sensitive: false',
      '- match_type: token (whole-word token match; NOT substring) unless you explicitly write "override: substring" in the rationale',
      '- punctuation splitting (d.o.g) does NOT count as match by default',
      '- hashtags/usernames COUNT as match by default',
      '- quoted text COUNT as match by default',
      '',
      'JUDGE PROFILES (do not modify):',
      judgeProfiles,
      '',
      `Rule to consider:\n${rule}`,
      '',
      'Testcases:',
      testcaseList,
      '',
      'Important: Keep output plain text only and follow the pattern exactly. Each rationale must start with the ORACLE tag so automation can parse it.',
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
  const { rule, example, count } = req.body || {};

  if (!rule || typeof rule !== 'string' || !rule.trim()) {
    return res.status(400).json({ error: 'The "rule" field is required.' });
  }

  const trimmedRule = rule.trim();
  const requestedCount = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : 15;
  const prompt = buildPrompt(
    trimmedRule,
    typeof example === 'string' ? example.trim() : '',
    requestedCount
  );

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

app.post('/evaluate', async (req, res) => {
  const { rule, examples } = req.body || {};

  if (!rule || typeof rule !== 'string' || !rule.trim()) {
    return res.status(400).json({ error: 'The "rule" field is required.' });
  }

  if (!Array.isArray(examples) || !examples.length) {
    return res.status(400).json({ error: 'At least one testcase is required for evaluation.' });
  }

  if (!openaiClient) {
    return res.status(500).json({
      error: 'OPENAI_API_KEY not set on the server. Please configure the API key to run evaluations.',
    });
  }

  const trimmedRule = rule.trim();

  try {
    const judgeSummary = await runJudgeSummary(trimmedRule, examples);
    console.log('\n=== Judge panel summary (evaluate endpoint) ===');
    console.log(judgeSummary);
    console.log('==============================================\n');

    res.json({
      judges,
      judgeSummary,
    });
  } catch (error) {
    console.error('\n=== Judge summary failed (evaluate endpoint) ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('===============================================\n');

    return res.status(500).json({
      error: 'Failed to evaluate testcases with judges',
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`ModDash backend listening on http://localhost:${PORT}`);
});
