require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');
const Database = require('better-sqlite3');
const judges = require('./judges');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const openaiApiKey = process.env.OPENAI_API_KEY;
// Configure OpenAI client with longer timeout for Agent 2 calls
const openaiClient = openaiApiKey ? new OpenAI({ 
  apiKey: openaiApiKey,
  timeout: 120000, // 120 seconds timeout for OpenAI API calls
  maxRetries: 2
}) : null;

// Increase server timeout for long-running requests (Render allows up to 30s on free tier, but we'll set higher for paid)
app.timeout = 120000; // 120 seconds

// CORS configuration - allow all origins and methods for Render deployment
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));

/* ---------------------------
   Prompt builder (AGENT-1)
   --------------------------- */
// prompts.js
function buildAgent1Prompt(rule, example = '') {
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

If the RULE I gave you mentions hate, slurs, protected classes, etc. you have to include:
- Instruct AGENT-2 to ALWAYS output actual slurs; use the actual words like fuck, arsehole, goddamn, bitch, twat, dumbass, cock, wanker, shit, bastard, piss, motherfucker, bloody, jackass, cunt, prick, hell, asshole, bollocks, dickhead, horseshit, slut, crap, fag, goddammit, ass, bugger, pussy, damned, arse, fucking, dammit, jackarse, dick, shithead, fatherfucker, bullsh*t, nigga, spastic, brotherfucker, kike, pigfucker, sisterfucker, tranny, godsdamn, cocksucker, faggot, dyke, arsehead, goddamned, nigra, dumb-ass, jack-ass, shite, goddamnit, sisterfuck, etc.
- Include the name of protected classes in the text and the protected class should be triggered.
- Make sure people will feel offended by the text.

Now produce the single instruction block for AGENT-2 using the guidance above.`;
}

function buildAgent2Prompt(agent1Instructions, count = 15) {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 15;
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
   JSON cleaning and parsing helper
   --------------------------- */
function cleanAndParseJSON(text) {
  // First, try to extract JSON from markdown code blocks if present
  let jsonText = text.trim();
  
  // Remove markdown code blocks if present
  const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim();
  }
  
  // Try direct parse first
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    console.log('Direct JSON parse failed, attempting to fix control characters...');
  }
  
  // Fix control characters in JSON strings using a state machine approach
  let fixedJson = '';
  let inString = false;
  let escapeNext = false;
  
  for (let i = 0; i < jsonText.length; i++) {
    const char = jsonText[i];
    const code = char.charCodeAt(0);
    
    if (escapeNext) {
      // We're escaping the next character, so just add it
      fixedJson += char;
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      // Escape character - mark next char as escaped
      fixedJson += char;
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      // Toggle string state
      inString = !inString;
      fixedJson += char;
      continue;
    }
    
    if (inString) {
      // We're inside a string - escape control characters
      if (code < 0x20 || code === 0x7F) {
        // Control character - escape it
        if (char === '\n') {
          fixedJson += '\\n';
        } else if (char === '\r') {
          fixedJson += '\\r';
        } else if (char === '\t') {
          fixedJson += '\\t';
        } else if (char === '\f') {
          fixedJson += '\\f';
        } else if (char === '\b') {
          fixedJson += '\\b';
        } else if (char === '\v') {
          fixedJson += '\\v';
        } else {
          // Other control characters - use unicode escape
          fixedJson += '\\u' + ('0000' + code.toString(16)).slice(-4);
        }
      } else {
        fixedJson += char;
      }
    } else {
      // Outside string - just copy
      fixedJson += char;
    }
  }
  
  // Try parsing the fixed JSON
  let parseError;
  try {
    return JSON.parse(fixedJson);
  } catch (e) {
    parseError = e;
    console.log('Fixed JSON parse also failed:', e.message);
    
    // Log context around error
    const errorPosition = e.message.match(/position (\d+)/);
    if (errorPosition) {
      const pos = parseInt(errorPosition[1]);
      const start = Math.max(0, pos - 200);
      const end = Math.min(fixedJson.length, pos + 200);
      console.log(`Error context around position ${pos}:`, fixedJson.substring(start, end));
    }
  }
  
  // If all else fails, throw with context
  const errorMessage = parseError?.message || 'Unknown parsing error';
  throw new Error(`Failed to parse JSON after cleaning attempts: ${errorMessage}`);
}

/* ---------------------------
   Judge prompt builder + runner
   --------------------------- */
function buildJudgeSummaryPrompt(rule, examples, serverContext = '') {
  const judgeProfiles = judges
    .map((j) => {
      const exp = typeof j.experienceYears === 'number' && j.experienceYears > 0 ? `${j.experienceYears} years` : 'relevant experience';
      return `${j.name} (${j.role}, ${exp}): ${j.personality}`;
    })
    .join('\n');

  const testcaseList = (Array.isArray(examples) ? examples : [])
    .map((ex, i) => `Testcase ${i + 1}: ${ex?.text ?? ''}`)
    .join('\n');

  const trimmedContext = (serverContext || '').trim();

  return [
    'You are coordinating five judges evaluating testcases for a text-detection rule.',
    '',
    "GOAL: For each judge and each testcase produce exactly one percentage (0-100) that represents the JUDGE'S final opinion on how likely the rule SHOULD trigger. Keep the exact plain-text outcome format used previously.",
    '',
    'MANDATES (must follow):',
    "- The RULE is the primary policy source. Server context can shape how strictly you apply the rule (e.g., a “bad words allowed” server may lead to more lenient scores), but you must still ground all judgments in the written rule.",
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
    trimmedContext
      ? `Server / community context (use this to calibrate strictness, but do not override the rule):\n${trimmedContext}\n`
      : 'Server / community context: (none provided)\n',
    '',
    'Testcases:',
    testcaseList,
  ].join('\n');
}

async function runJudgeSummary(rule, examples, serverContext = '') {
  if (!openaiClient) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const prompt = buildJudgeSummaryPrompt(rule, examples, serverContext);

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
// Root route for health checks
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'ModDash Backend' });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});


app.post('/generate', async (req, res) => {
  console.log('\n=== /generate endpoint called ===');
  console.log('Timestamp:', new Date().toISOString());
  
  // Note: Render free tier has a 30-second timeout limit that cannot be overridden
  // We'll try to complete within that time, but Agent 2 may timeout on complex requests
  // Consider: splitting into two endpoints, using background jobs, or upgrading Render plan
  
  try {
    const { rule, example, count } = req.body || {};
    console.log('Received inputs:');
    console.log('  - rule:', rule ? `${rule.substring(0, 100)}...` : '(empty)');
    console.log('  - example:', example ? `${example.substring(0, 100)}...` : '(none)');
    console.log('  - count:', count || 15);
    
    if (!rule || typeof rule !== 'string' || !rule.trim()) {
      console.log('ERROR: Rule is required but missing');
      return res.status(400).json({ error: 'The "rule" field is required.' });
    }
    if (!openaiClient) {
      console.log('ERROR: OpenAI client not initialized (OPENAI_API_KEY not set)');
      return res.status(500).json({ error: 'OPENAI_API_KEY not set.' });
    }

    // 1) Build AGENT-1 prompt and call AGENT-1
    console.log('\n--- Step 1: Building AGENT-1 prompt ---');
    const agent1Input = buildAgent1Prompt(rule, example || '', count || 15);
    console.log('AGENT-1 prompt length:', agent1Input.length, 'characters');
    console.log('AGENT-1 prompt preview:', agent1Input.substring(0, 200) + '...');
    
    console.log('Calling OpenAI API for AGENT-1...');
    const agent1StartTime = Date.now();
    const agent1Resp = await openaiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are AGENT-1. Output only the instruction block for AGENT-2.' },
        { role: 'user', content: agent1Input },
      ],
    });
    const agent1Duration = Date.now() - agent1StartTime;
    console.log(`AGENT-1 API call completed in ${agent1Duration}ms`);
    console.log('AGENT-1 response structure:', {
      choices: agent1Resp.choices?.length || 0,
      model: agent1Resp.model,
      usage: agent1Resp.usage
    });

    const agent1Text = agent1Resp.choices?.[0]?.message?.content?.trim();
    console.log('AGENT-1 response text length:', agent1Text?.length || 0);
    if (!agent1Text) {
      console.log('ERROR: Empty response from Agent1');
      throw new Error('Empty response from Agent1');
    }
    console.log('AGENT-1 OUTPUT (first 500 chars):\n', agent1Text.substring(0, 500));

    // 2) Compose AGENT-2 prompt (fixed schema + AGENT-1 instructions)
    console.log('\n--- Step 2: Building AGENT-2 prompt ---');
    const agent2Input = buildAgent2Prompt(agent1Text, count || 15);
    console.log('AGENT-2 prompt length:', agent2Input.length, 'characters');
    console.log('AGENT-2 prompt preview:', agent2Input.substring(0, 200) + '...');
    
    console.log('Calling OpenAI API for AGENT-2...');
    const agent2StartTime = Date.now();
    
    // Use streaming to get partial responses and avoid timeout
    // But for now, let's try with a longer timeout and better error handling
    let agent2Resp;
    try {
      agent2Resp = await Promise.race([
        openaiClient.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are AGENT-2. Output strict JSON only.' },
            { role: 'user', content: agent2Input },
          ],
          timeout: 90000, // 90 seconds for this specific call
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Agent 2 request timeout after 90 seconds')), 90000)
        )
      ]);
    } catch (timeoutError) {
      console.error('AGENT-2 timeout error:', timeoutError);
      // Return a more helpful error message
      return res.status(504).json({ 
        error: 'Request timeout',
        details: 'Agent 2 request took too long. This is likely due to Render\'s 30-second timeout limit on the free tier. Try reducing the testcase count or upgrade your Render plan.',
        suggestion: 'Consider reducing the count parameter or upgrading to Render\'s paid tier for longer timeouts.'
      });
    }
    const agent2Duration = Date.now() - agent2StartTime;
    console.log(`AGENT-2 API call completed in ${agent2Duration}ms`);
    console.log('AGENT-2 response structure:', {
      choices: agent2Resp.choices?.length || 0,
      model: agent2Resp.model,
      usage: agent2Resp.usage
    });

    const agent2Text = agent2Resp.choices?.[0]?.message?.content?.trim();
    console.log('AGENT-2 response text length:', agent2Text?.length || 0);
    if (!agent2Text) {
      console.log('ERROR: Empty response from Agent2');
      throw new Error('Empty response from Agent2');
    }
    console.log('AGENT-2 OUTPUT (first 1000 chars):\n', agent2Text.substring(0, 1000));

    // Parse and return
    console.log('\n--- Step 3: Parsing AGENT-2 response ---');
    let parsed;
    try {
      parsed = cleanAndParseJSON(agent2Text);
      console.log('JSON parsing successful');
      console.log('Parsed object keys:', Object.keys(parsed));
      console.log('Examples array length:', parsed.examples?.length || 0);
    } catch (parseError) {
      console.log('ERROR: Failed to parse JSON from AGENT-2');
      console.log('Parse error:', parseError.message);
      console.log('Raw response (first 2000 chars):', agent2Text.substring(0, 2000));
      
      // Log the area around the error position if available
      const errorPosition = parseError.message.match(/position (\d+)/);
      if (errorPosition) {
        const pos = parseInt(errorPosition[1]);
        const start = Math.max(0, pos - 200);
        const end = Math.min(agent2Text.length, pos + 200);
        console.log(`Error context around position ${pos}:`, agent2Text.substring(start, end));
      }
      
      throw new Error(`Failed to parse JSON from Agent2: ${parseError.message}`);
    }
    
    if (!parsed || !Array.isArray(parsed.examples)) {
      console.log('ERROR: Agent2 output missing examples array');
      console.log('Parsed object:', JSON.stringify(parsed, null, 2).substring(0, 500));
      throw new Error('Agent2 output missing examples array');
    }

    console.log('\n--- Step 4: Sending response to client ---');
    console.log('Total examples to return:', parsed.examples.length);
    const response = { prompts: { agent1: agent1Input, agent2: agent2Input }, ...parsed };
    console.log('Response keys:', Object.keys(response));
    console.log('=== /generate endpoint completed successfully ===\n');
    
    return res.json(response);
  } catch (err) {
    console.error('\n=== ERROR in /generate endpoint ===');
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    console.error('=== End of error ===\n');
    
    // Check if this is a timeout-related error
    const isTimeout = err.message && (
      err.message.includes('timeout') || 
      err.message.includes('ETIMEDOUT') ||
      err.message.includes('ECONNRESET')
    );
    
    if (isTimeout) {
      return res.status(504).json({ 
        error: 'Request timeout',
        details: 'The request took too long to complete. This is likely due to Render\'s 30-second timeout limit on the free tier. Try reducing the testcase count or upgrade your Render plan.',
        suggestion: 'Consider reducing the count parameter (currently 15) or upgrading to Render\'s paid tier for longer timeouts.'
      });
    }
    
    return res.status(500).json({ error: err.message });
  }
});

app.post('/evaluate', async (req, res) => {
  const { rule, examples, serverContext } = req.body || {};
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
    const judgeSummary = await runJudgeSummary(rule.trim(), examples, serverContext);
    return res.json({ judges, judgeSummary });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to evaluate testcases', details: err.message });
  }
});

/* ---------------------------
   Export current testcases to SQLite DB
   --------------------------- */
app.post('/export-db', (req, res) => {
  try {
    const { rule, testcases } = req.body || {};

    if (!Array.isArray(testcases) || testcases.length === 0) {
      return res.status(400).json({ error: 'No testcases were provided to export.' });
    }

    const dbPath = path.join(__dirname, 'db.db');
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS testcases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idx INTEGER NOT NULL,
        text TEXT NOT NULL,
        trigger INTEGER,
        confidence REAL,
        overall_score INTEGER,
        rule TEXT,
        raw_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      DELETE FROM testcases;
    `);

    const insert = db.prepare(`
      INSERT INTO testcases (
        idx, text, trigger, confidence, overall_score, rule, raw_json
      ) VALUES (
        @idx, @text, @trigger, @confidence, @overall_score, @rule, @raw_json
      );
    `);

    const rows = testcases.map((tc, index) => ({
      idx: typeof tc.index === 'number' ? tc.index : index + 1,
      text: tc.text || '',
      trigger: typeof tc.trigger === 'boolean' ? (tc.trigger ? 1 : 0) : null,
      confidence: typeof tc.confidence === 'number' ? tc.confidence : null,
      overall_score:
        tc.evaluation && typeof tc.evaluation.overallScore === 'number'
          ? tc.evaluation.overallScore
          : null,
      rule: typeof rule === 'string' && rule.trim() ? rule.trim() : null,
      raw_json: JSON.stringify(tc),
    }));

    const insertMany = db.transaction((batch) => {
      batch.forEach((row) => insert.run(row));
    });

    insertMany(rows);

    const { count } = db.prepare('SELECT COUNT(*) AS count FROM testcases;').get();
    db.close();

    return res.json({
      ok: true,
      message: 'Database exported successfully.',
      dbPath,
      count,
    });
  } catch (err) {
    console.error('Error exporting DB:', err);
    return res.status(500).json({ error: 'Failed to export DB', details: err.message });
  }
});

/* ---------------------------
   Start server
   --------------------------- */
app.listen(PORT, () => {
  console.log(`ModDash backend listening on http://localhost:${PORT}`);
});