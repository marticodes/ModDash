const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

function buildPrompt(rule, example) {
  const base = [
    'You are a helpful assistant that designs synthetic evaluation datasets for content moderation rules.',
    'You must respond with strict JSON following this schema:',
    '{',
    '  "notes": string,',
    '  "tables": [',
    '    {',
    '      "name": string,',
    '      "description": string,',
    '      "columns": [ { "name": string, "type": string, "description": string } ],',
    '      "sampleRows": [ { string: string } ]',
    '    }',
    '  ]',
    '}',
    '',
    'Rule to analyse:',
    rule.trim(),
  ];

  if (example) {
    base.push('', 'Example content provided by the user:', example.trim());
  }

  base.push('', 'Focus on realistic moderation scenarios and provide at least two sample rows.');
  return base.join('\n');
}

function createFallbackTables(rule, example) {
  const trimmedRule = rule.trim();
  const shortRule = trimmedRule.length > 120 ? `${trimmedRule.slice(0, 117)}...` : trimmedRule;
  const ruleTagline = shortRule.replace(/\s+/g, ' ').trim();

  const baseNotes =
    'Generated locally without calling GPT. Set OPENAI_API_KEY before starting the server to enable live completions.';

  const columns = [
    {
      name: 'message',
      type: 'text',
      description: 'User provided text or scenario that should be moderated.',
    },
    {
      name: 'decision',
      type: "enum('allow','review','flag')",
      description: 'How the moderation system should respond to the content.',
    },
    {
      name: 'rationale',
      type: 'text',
      description: 'Explanation tying the decision back to the moderation rule.',
    },
  ];

  const rows = [];

  if (example) {
    rows.push({
      message: example,
      decision: 'review',
      rationale: 'User-supplied example queued for validation against the rule.',
    });
  }

  rows.push(
    {
      message: `This content intentionally violates the rule: ${ruleTagline}.`,
      decision: 'flag',
      rationale: 'Direct violation crafted to trigger the policy.',
    },
    {
      message: 'Benign message demonstrating compliant behaviour with polite language.',
      decision: 'allow',
      rationale: 'Does not conflict with the moderation guidance.',
    },
    {
      message: 'Borderline scenario requiring human review to interpret nuance.',
      decision: 'review',
      rationale: 'Ambiguous tone relative to the policy; needs escalation.',
    }
  );

  return {
    notes: `${baseNotes} Target rule: ${ruleTagline}.`,
    tables: [
      {
        name: 'moderation_cases',
        description: 'Synthetic cases assembled to exercise the requested moderation rule.',
        columns,
        sampleRows: rows,
      },
    ],
  };
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

  // Placeholder for future GPT integration. The deterministic fallback keeps the UI functional.
  const payload = createFallbackTables(trimmedRule, typeof example === 'string' ? example.trim() : '');

  res.json({
    prompt,
    ...payload,
    usedFallback: true,
  });
});

app.listen(PORT, () => {
  console.log(`ModDash backend listening on http://localhost:${PORT}`);
});
