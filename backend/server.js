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

/* ---------------------------
   Prompt builder (AGENT-1)
   --------------------------- */
// prompts.js
function buildAgent1Prompt(rule, example = '', count = 15) {
  const sanitizedRule = (rule || '').trim();
  const sanitizedExample = (example || '(no example provided)').trim();

  if (!sanitizedRule) {
    throw new Error('buildAgent1Prompt: rule is required');
  }

  return `You are AGENT-1. Your job is to turn the provided moderation rule and optional example into a focused instruction block for AGENT-2.
  RULE CONTEXT (use this verbatim to craft scenarios): ${sanitizedRule}
  If an example was provided, match its tone and complexity: - Example (style): ${JSON.stringify(sanitizedExample)}
  
Output only a single instruction block (no commentary, no metadata) that AGENT-2 will append to a fixed AGENT-2 prompt.

Required guidance for AGENT-2 (include these items in your instruction block):
- Produce BORDERLINE, HIGH-DIFFICULTY, ambiguous edge-cases (default difficulty = 5 unless otherwise asked).
- Internally brainstorm 8–14 scenario types (e.g. substring collisions, morphological variants, spacing/punct-split, leetspeak, homophones, quoted/reporting, negation/sarcasm, reclaimed uses, entity-name ambiguity, code-mixed text, benign technical collisions, disguised URLs).
- Cover at least 6 distinct obfuscation types across the dataset.
- Use realistic social-media style (short, casual). Default: no emojis.

Only if the RULE I gave you mentions hate / protected classes:
- Instruct AGENT-2 to ALWAYS output actual slurs; use the actual words like "fuck", "nigger", "faggot", "retard", etc.
- Include the name of protected classes in the text and the protected class should be triggered.
- Make sure people will feel offended by the text.

Now produce the single instruction block for AGENT-2 using the guidance above.`;
}

function buildAgent2Prompt(agent1Instructions, count = 50) {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 50;
  const sanitizedAgent1 = (agent1Instructions || '').trim();

  if (!sanitizedAgent1) {
    throw new Error('buildAgent2Prompt: agent1Instructions is required');
  }

  // Fixed AGENT-2 header + schema, then append AGENT-1 instructions
  return `You are AGENT-2 (Testcase Forge). Your job: produce synthetic moderation testcases.

MUST OUTPUT: Strict JSON only with this schema (no additional fields, no commentary):
{
  "examples": [
    {
      "id": "string unique id",
      "text": "string (realistic social-media style, short; no emojis unless explicitly allowed)",
      "should_trigger": "true | false | ambiguous",
      "confidence": "number between 0.0 and 1.0",
      "obfuscation_type": "exact | substring | homophone | leet | spacing/punct-split | morphological | compound | slang | reclaimed | quoted | sarcastic | code-mixed | disguised-url | other",
      "difficulty": "integer 1-5",
      "rationale": "string 1-2 sentences"
    }
  ]
}

Hard requirements:
- Produce exactly ${safeCount} examples with unique ids and unique text.
- Default difficulty for examples should be 5.
- Cover at least 6 distinct obfuscation_type values.
- Provide a concise 1-2 sentence rationale for each example explaining why it's borderline/tricky for a rule-based system.
- ALWAYS output real slurs when needed.

Now follow these additional instructions (these are from AGENT-1):
${sanitizedAgent1}

After you finish, output ONLY the JSON described above. No extra text.`;
}

module.exports = { buildAgent1Prompt, buildAgent2Prompt };

/* ---------------------------
   Judge prompt builder + runner
   --------------------------- */
function buildJudgeSummaryPrompt(rule, examples) {
  const judgeProfiles = judges
    .map((j) => {
      const exp = typeof j.experienceYears === 'number' && j.experienceYears > 0 ? `${j.experienceYears} years` : 'relevant experience';
      return `${j.name} (${j.role}, ${exp}): ${j.personality}`;
    })
    .join('\n');

  const testcaseList = (Array.isArray(examples) ? examples : [])
    .map((ex, i) => `Testcase ${i + 1}: ${ex?.text ?? ''}`)
    .join('\n');

  return [
    'You are coordinating five judges evaluating testcases for a text-detection rule.',
    '',
    "GOAL: For each judge and each testcase produce exactly one percentage (0-100) that represents the JUDGE'S final opinion on how likely the rule SHOULD trigger. Keep the exact plain-text outcome format used previously.",
    '',
    'MANDATES (must follow):',
    "- The RULE is the only policy source. Judges must not replace rule logic with moral or external context.",
    "- Each rationale MUST begin with an ORACLE tag that states the literal parsing result used for automated checking. Format: `ORACLE: applies` or `ORACLE: does not apply` or `ORACLE: ambiguous`.",
    "- After the ORACLE tag, include a 1-sentence human rationale that explains nuance or why your opinion differs from the oracle.",
    "- The single percent you output is the judge's final opinion (0-100). For clear-cut literal matches prefer >=70, for clear-cut non-matches prefer <=30.",
    '',
    'OUTPUT FORMAT (plain text, follow this EXACT pattern):',
    'Judge: <Name>',
    "- Testcase 1: <0-100>% - ORACLE: <applies|does not apply|ambiguous> - <1-sentence rationale>",
    "- Testcase 2: <0-100>% - ORACLE: <applies|does not apply|ambiguous> - <1-sentence rationale>",
    '',
    'EXTRA RULE PARSING DEFAULTS (apply unless stated in rationale):',
    '- case_sensitive: false',
    '- match_type: token (whole-word token match) unless you explicitly write "override: substring" in the rationale',
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
  ].join('\n');
}

async function runJudgeSummary(rule, examples) {
  if (!openaiClient) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const prompt = buildJudgeSummaryPrompt(rule, examples);

  const completion = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You simulate a panel of judges for text detection research. Respond with concise plain text.' },
      { role: 'user', content: prompt },
    ],
  });

  const content = completion.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response from judge summary');
  return content;
}

/* ---------------------------
   Routes
   --------------------------- */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});


app.post('/generate', async (req, res) => {
  try {
    const { rule, example, count } = req.body || {};
    if (!rule || typeof rule !== 'string' || !rule.trim()) {
      return res.status(400).json({ error: 'The "rule" field is required.' });
    }
    if (!openaiClient) {
      return res.status(500).json({ error: 'OPENAI_API_KEY not set.' });
    }

    // 1) Build AGENT-1 prompt and call AGENT-1
    const agent1Input = buildAgent1Prompt(rule, example || '', count || 15);
    const agent1Resp = await openaiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are AGENT-1. Output only the instruction block for AGENT-2.' },
        { role: 'user', content: agent1Input },
      ],
    });

    const agent1Text = agent1Resp.choices?.[0]?.message?.content?.trim();
    if (!agent1Text) throw new Error('Empty response from Agent1');

    // 2) Compose AGENT-2 prompt (fixed schema + AGENT-1 instructions)
    const agent2Input = buildAgent2Prompt(agent1Text, count || 15);
    const agent2Resp = await openaiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are AGENT-2. Output strict JSON only.' },
        { role: 'user', content: agent2Input },
      ],
    });

    const agent2Text = agent2Resp.choices?.[0]?.message?.content?.trim();
    if (!agent2Text) throw new Error('Empty response from Agent2');
    console.log("AGENT-1 OUTPUT:\n", agent1Text);


    // Parse and return
    const parsed = JSON.parse(agent2Text);
    if (!parsed || !Array.isArray(parsed.examples)) throw new Error('Agent2 output missing examples array');

    return res.json({ prompts: { agent1: agent1Input, agent2: agent2Input }, ...parsed });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
    return res.status(500).json({ error: 'OPENAI_API_KEY not set on the server.' });
  }

  try {
    const judgeSummary = await runJudgeSummary(rule.trim(), examples);
    return res.json({ judges, judgeSummary });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to evaluate testcases', details: err.message });
  }
});

/* ---------------------------
   Start server
   --------------------------- */
app.listen(PORT, () => {
  console.log(`ModDash backend listening on http://localhost:${PORT}`);
});