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

    if (payload.prompt) {
      const promptLabel = document.createElement('h3');
      promptLabel.textContent = 'Prompt prepared for GPT';
      summaryNodes.push(promptLabel, createPreformatted(payload.prompt));
    }

    if (payload.usedFallback) {
      const warning = document.createElement('p');
      warning.className = 'fallback-note';
      warning.textContent = 'Fallback dataset used (no live GPT response).';
      summaryNodes.push(warning);
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
