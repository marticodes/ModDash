const ruleField = document.querySelector('#rule');
const exampleField = document.querySelector('#example');
const generateButton = document.querySelector('#generate');
const resultPanel = document.querySelector('#result-panel');
const datasetPanel = document.querySelector('#dataset-panel');

const API_BASE = window.__MODDASH_API_BASE__ || 'http://127.0.0.1:3001';

function setPanelContent(panel, nodes) {
  panel.innerHTML = '';
  panel.removeAttribute('data-placeholder');
  const list = Array.isArray(nodes) ? nodes : [nodes];
  list.forEach((node) => panel.append(node));
}

function setPanelPlaceholder(panel, text) {
  panel.textContent = '';
  if (text) {
    panel.dataset.placeholder = text;
  } else {
    delete panel.dataset.placeholder;
  }
}

function createParagraph(text) {
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  return paragraph;
}

function createPreformatted(text) {
  const pre = document.createElement('pre');
  pre.textContent = text;
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordBreak = 'break-word';
  return pre;
}

function createTableElement(table) {
  const container = document.createElement('article');
  container.className = 'dataset-table';

  const heading = document.createElement('h3');
  heading.textContent = table.name;
  container.append(heading);

  if (table.description) {
    container.append(createParagraph(table.description));
  }

  if (Array.isArray(table.columns) && table.columns.length) {
    const columnList = document.createElement('dl');
    columnList.className = 'columns';

    table.columns.forEach((column) => {
      const title = document.createElement('dt');
      title.textContent = `${column.name} (${column.type})`;
      columnList.append(title);

      if (column.description) {
        const detail = document.createElement('dd');
        detail.textContent = column.description;
        columnList.append(detail);
      }
    });

    container.append(columnList);
  }

  if (Array.isArray(table.sampleRows) && table.sampleRows.length) {
    const tableElement = document.createElement('table');
    tableElement.className = 'sample-rows';
    const headerRow = document.createElement('tr');

    const keys = Object.keys(table.sampleRows[0]);
    keys.forEach((key) => {
      const th = document.createElement('th');
      th.textContent = key;
      headerRow.append(th);
    });

    tableElement.append(headerRow);

    table.sampleRows.forEach((row) => {
      const tr = document.createElement('tr');
      keys.forEach((key) => {
        const td = document.createElement('td');
        td.textContent = row[key] ?? '';
        tr.append(td);
      });
      tableElement.append(tr);
    });

    container.append(tableElement);
  }

  return container;
}

function createJudgeRoster(judges) {
  const roster = document.createElement('div');
  roster.className = 'judge-roster';

  judges.forEach((judge) => {
    const card = document.createElement('article');
    card.className = 'judge-card';

    const name = document.createElement('strong');
    name.textContent = judge.name;
    card.append(name);

    const meta = document.createElement('p');
    const experience = judge.experienceYears ? `${judge.experienceYears} yrs exp` : 'Perspective';
    meta.className = 'judge-meta';
    meta.textContent = `${judge.role} · ${experience}`;
    card.append(meta);

    if (judge.personality) {
      const desc = document.createElement('p');
      desc.textContent = judge.personality;
      card.append(desc);
    }
  });

  return roster;
}

function parseJudgeSummary(summaryText) {
  if (!summaryText) {
    return [];
  }

  const judgesData = [];
  let currentJudge = null;

  summaryText.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    if (line.toLowerCase().startsWith('judge:')) {
      const name = line.slice(line.indexOf(':') + 1).trim();
      if (name) {
        currentJudge = { name, verdicts: [] };
        judgesData.push(currentJudge);
      }
      return;
    }

    if (!currentJudge) {
      return;
    }

    const verdictMatch = line.match(/^-?\s*Testcase\s+(\d+):\s*([\d.]+)%\s*-\s*(.+)$/i);
    if (verdictMatch) {
      currentJudge.verdicts.push({
        testcaseId: Number(verdictMatch[1]),
        percentage: Number(verdictMatch[2]),
        rationale: verdictMatch[3].trim(),
      });
    } else {
      currentJudge.verdicts.push({
        testcaseId: null,
        percentage: null,
        rationale: line,
      });
    }
  });

  return judgesData;
}

function createJudgeSummaryCards(summaryText) {
  const parsedJudges = parseJudgeSummary(summaryText);
  if (!parsedJudges.length) {
    return createPreformatted(summaryText);
  }

  const grid = document.createElement('div');
  grid.className = 'judge-summary-grid';

  parsedJudges.forEach((judge) => {
    const card = document.createElement('article');
    card.className = 'judge-summary-card';

    const name = document.createElement('h4');
    name.textContent = judge.name;
    card.append(name);

    if (Array.isArray(judge.verdicts) && judge.verdicts.length) {
      const list = document.createElement('ul');
      list.className = 'judge-summary-list';

      judge.verdicts.forEach((verdict) => {
        const item = document.createElement('li');

        if (typeof verdict.testcaseId === 'number') {
          const header = document.createElement('div');
          header.className = 'judge-summary-row';

          const label = document.createElement('span');
          label.className = 'testcase-label';
          label.textContent = `Testcase ${verdict.testcaseId}`;
          header.append(label);

          if (typeof verdict.percentage === 'number' && Number.isFinite(verdict.percentage)) {
            const score = document.createElement('span');
            score.className = 'testcase-score';
            score.textContent = `${verdict.percentage}%`;
            header.append(score);
          }

          item.append(header);
        }

        if (verdict.rationale) {
          const rationale = document.createElement('p');
          rationale.className = 'testcase-rationale';
          rationale.textContent = verdict.rationale;
          item.append(rationale);
        }

        list.append(item);
      });

      card.append(list);
    }

    grid.append(card);
  });

  return grid;
}

async function handleGenerate() {
  const rule = ruleField.value.trim();
  const example = exampleField.value.trim();

  if (!rule) {
    alert('Please enter a rule before generating a dataset.');
    return;
  }

  generateButton.disabled = true;
  generateButton.textContent = 'Generating...';

  setPanelPlaceholder(resultPanel, 'Working on it...');
  setPanelPlaceholder(datasetPanel, 'Working on it...');

  try {
    const response = await fetch(`${API_BASE}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rule, example: example || null }),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Request failed with status ${response.status}`);
    }

    const payload = await response.json();

    const summaryNodes = [];
    if (payload.notes) {
      summaryNodes.push(createParagraph(payload.notes));
    }

    if (payload.usedFallback) {
      const warning = document.createElement('p');
      warning.className = 'fallback-note';
      warning.textContent = 'Fallback dataset used (no live GPT response).';
      summaryNodes.push(warning);
    }

    if (Array.isArray(payload.judges) && payload.judges.length) {
      const heading = document.createElement('h3');
      heading.textContent = 'Judge Panel';
      summaryNodes.push(heading, createJudgeRoster(payload.judges));
    }

    const judgeSummaryText = typeof payload.judgeSummary === 'string' ? payload.judgeSummary.trim() : '';
    if (judgeSummaryText) {
      const heading = document.createElement('h3');
      heading.textContent = 'Judge Summary';
      summaryNodes.push(heading, createJudgeSummaryCards(judgeSummaryText));
    } else {
      summaryNodes.push(createParagraph('Judge summary was unavailable. Check the server logs for details.'));
    }

    setPanelContent(resultPanel, summaryNodes);

    if (Array.isArray(payload.tables) && payload.tables.length) {
      const tableNodes = payload.tables.map(createTableElement);
      setPanelContent(datasetPanel, tableNodes);
    } else {
      setPanelPlaceholder(datasetPanel, 'No dataset information was returned.');
    }
  } catch (error) {
    console.error(error);
    setPanelContent(resultPanel, createParagraph('Something went wrong while generating the dataset.'));
    setPanelPlaceholder(datasetPanel, 'Unable to generate dataset.');
  } finally {
    generateButton.disabled = false;
    generateButton.textContent = 'Generate';
  }
}

generateButton.addEventListener('click', () => {
  handleGenerate();
});

[ruleField, exampleField].forEach((field) => {
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleGenerate();
    }
  });
});
