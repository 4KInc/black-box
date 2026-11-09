// The explorer's browser script (site/explorer.mjs builds the page). It reads the page's JSON
// block and shows it in AG Grid Community. Every value AG Grid shows comes from a function here,
// never a string expression, so the page needs no 'unsafe-eval'.
(() => {
  const data = JSON.parse(document.getElementById('xp-data').textContent);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (c) => (Number.isInteger(c) ? `$${(c / 100).toFixed(2)}` : '–');
  const LABEL = { MERCHANT: 'MERCHANT', AGENT: 'AGENT', USER: 'USER', NEEDS_A_HUMAN: 'NEEDS A HUMAN' };

  if (!window.agGrid) {
    $('xp-grid').innerHTML = '<p style="padding:16px">AG Grid did not load. Every case is also on the <a href="../bench/">Scenarios</a> page and every run on the <a href="../study/">Study</a> page.</p>';
    return;
  }
  const { createGrid, themeQuartz, colorSchemeDark, ModuleRegistry, AllCommunityModule } = window.agGrid;
  if (ModuleRegistry && AllCommunityModule) ModuleRegistry.registerModules([AllCommunityModule]);

  // The site's own palette and typefaces, so the grid looks like the rest of the recorder.
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();
  const theme = themeQuartz.withPart(colorSchemeDark).withParams({
    backgroundColor: token('--bg-1'), foregroundColor: token('--ink'), headerBackgroundColor: token('--bg-2'),
    headerTextColor: token('--ink-2'), borderColor: token('--rule'), rowHoverColor: token('--bg-2'),
    selectedRowBackgroundColor: token('--bg-3'), accentColor: token('--orange'), oddRowBackgroundColor: token('--bg'),
    fontFamily: token('--sans'), headerFontFamily: token('--display'), headerFontSize: 14, fontSize: 13,
    cellFontFamily: token('--mono'), wrapperBorderRadius: 0, borderRadius: 2,
  });

  const verdictCell = (p) => (p.value ? `<span class="xp-v ${esc(p.value)}">${esc(LABEL[p.value] ?? p.value)}</span>` : '');
  const yesNo = (good, bad) => (p) => (p.value === null || p.value === undefined ? '–' : p.value ? `<span class="xp-${good}">${esc(bad ? bad[0] : '✓')}</span>` : `<span class="xp-${good === 'ok' ? 'bad' : 'ok'}">${esc(bad ? bad[1] : '✗')}</span>`);
  const moneyCol = (field, headerName, width = 110) => ({ field, headerName, width, type: 'numericColumn', filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value) });

  const VIEWS = {
    scenarios: {
      rows: data.scenarios,
      verdicts: true,
      columns: [
        { field: 'id', headerName: 'Case', width: 90, pinned: 'left' },
        { field: 'verdict', headerName: 'Verdict', width: 160, pinned: 'left', cellRenderer: verdictCell },
        { field: 'rule', headerName: 'Rule', width: 80, filter: 'agNumberColumnFilter' },
        { field: 'title', headerName: 'Scenario', flex: 2, minWidth: 260 },
        { field: 'group', headerName: 'Group', width: 170 },
        { field: 'model', headerName: 'Agent model', width: 190 },
        { field: 'reason', headerName: 'Dispute reason', width: 150 },
        { field: 'outcome', headerName: 'PayPal action', width: 160 },
        moneyCol('budgetCents', 'Budget'),
        moneyCol('paidCents', 'Paid'),
        { field: 'fails', headerName: 'Record checks failed', width: 220 },
        { field: 'live', headerName: 'Live on PayPal', width: 130, cellRenderer: (p) => (p.value ? '<span class="xp-bad">● live</span>' : 'simulated') },
        { field: 'disputeId', headerName: 'Dispute ID', width: 170 },
        { field: 'pass', headerName: 'Bench', width: 100, pinned: 'right', cellRenderer: yesNo('ok', ['✓ right', '✗ wrong']) },
      ],
      detail: scenarioDetail,
    },
    cells: {
      rows: data.cells,
      columns: [
        { field: 'model', headerName: 'Model', width: 220, pinned: 'left' },
        { field: 'effect', headerName: 'Lie effect', width: 120, type: 'numericColumn', filter: 'agNumberColumnFilter',
          valueFormatter: (p) => (p.value === null ? '–' : `${p.value > 0 ? '+' : ''}${p.value}`) },
        { field: 'kind', headerName: 'Reading', width: 170 },
        { field: 'setup', headerName: 'Setup', flex: 1, minWidth: 240 },
        { field: 'lie', headerName: 'Hidden lie', flex: 2, minWidth: 300 },
        { field: 'who', headerName: 'Hidden by', width: 120 },
        { colId: 'withLie', headerName: 'Bought with lie', width: 140, valueGetter: (p) => `${p.data.lieBought}/${p.data.lieN}`, comparator: (a, b, x, y) => x.data.lieBought / (x.data.lieN || 1) - y.data.lieBought / (y.data.lieN || 1) },
        { colId: 'without', headerName: 'Bought without', width: 140, valueGetter: (p) => `${p.data.ctlBought}/${p.data.ctlN}`, comparator: (a, b, x, y) => x.data.ctlBought / (x.data.ctlN || 1) - y.data.ctlBought / (y.data.ctlN || 1) },
        moneyCol('priceCents', 'Price'),
        moneyCol('budgetCents', 'Budget'),
      ],
      detail: (r) => `<h3>${esc(r.model)}</h3><p class="hint">${esc(r.setup)}</p><dl class="xp-kv">
<dt>Hidden lie</dt><dd>${esc(r.lie)}</dd><dt>With the lie</dt><dd>bought ${r.lieBought} of ${r.lieN}</dd><dt>Without (control)</dt><dd>bought ${r.ctlBought} of ${r.ctlN}</dd>
<dt>Lie effect</dt><dd>${r.effect === null ? '–' : `${r.effect > 0 ? '+' : ''}${r.effect} points: ${esc(r.kind)}`}</dd></dl>
<p class="xp-note">Not a ranking: each provider ran at its own default settings. See the <a href="../study/">Study</a> page.</p>`,
    },
    runs: {
      rows: data.runs,
      columns: [
        { field: 'model', headerName: 'Model', width: 220, pinned: 'left' },
        { field: 'bought', headerName: 'Bought over budget', width: 160, cellRenderer: yesNo('bad', ['bought', 'stayed within']) },
        { field: 'condition', headerName: 'Page', width: 160 },
        { field: 'lie', headerName: 'Hidden lie', flex: 1, minWidth: 260 },
        { field: 'reason', headerName: 'The agent’s reason', flex: 2, minWidth: 340, tooltipField: 'reason' },
        { field: 'setup', headerName: 'Setup', width: 260 },
        moneyCol('priceCents', 'Price'),
        moneyCol('budgetCents', 'Budget'),
        { field: 'at', headerName: 'Run at', width: 200 },
      ],
      detail: (r) => `<h3>${esc(r.model)}</h3><p class="hint">${esc(r.setup)} · ${esc(r.condition)} · ${esc(r.at ?? '')}</p><dl class="xp-kv">
<dt>Hidden lie</dt><dd>${esc(r.lie)}</dd><dt>Price</dt><dd>${money(r.priceCents)} on a ${money(r.budgetCents)} budget</dd>
<dt>Bought it</dt><dd>${r.bought === null ? 'error' : r.bought ? 'yes, over budget' : 'no'}</dd><dt>Choice</dt><dd>${esc(r.choice ?? '–')}</dd>
<dt>The agent’s reason</dt><dd style="font-family:var(--sans);font-size:13px">${esc(r.reason)}</dd></dl>`,
    },
  };

  function scenarioDetail(r) {
    const kv = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '');
    return `<h3><span class="xp-v ${esc(r.verdict)}">${esc(LABEL[r.verdict])}</span> · ${esc(r.id)} · rule ${r.rule}</h3>
<p class="hint">${esc(r.title)}. ${esc(r.ruleText)}</p>
<dl class="xp-kv">
${kv('PayPal action', r.outcome + (r.held ? ' (held until the AI check answers)' : ''))}
${kv('Expected', r.expected)}
${kv('Dispute', r.disputeId ? `${r.disputeId}${r.live ? ' · live sandbox' : ' · simulated'}` : '')}
${kv('Order', r.orderId)}${kv('Capture', r.captureId)}
${r.executed.map((e) => kv('Sent to PayPal', e)).join('')}
${kv('Payout', r.payout)}
${kv('custom_id', r.customId)}
${kv('Record hash', r.recordHash)}
${kv('Signed page', r.pageUrl)}
${kv('Signature-Input', r.signatureInput)}
${kv('Signature', r.signature)}
${kv('Content-Digest', r.contentDigest)}
${kv('Body SHA-256', r.bodySha256)}
${kv('Shop key', r.keyid)}${kv('Signed at', r.signedAt)}
</dl>
<ul class="xp-lamps" aria-label="The 16 facts">${r.facts.map(([k, on]) => `<li class="${on ? 'on' : ''}">${esc(k)}</li>`).join('')}</ul>
<p class="xp-note"><a href="../bench/${encodeURIComponent(r.id)}/">Open the full case page →</a></p>`;
  }

  const pressed = new Set();
  let view = 'scenarios';
  const grid = createGrid($('xp-grid'), {
    theme,
    rowData: VIEWS.scenarios.rows,
    columnDefs: VIEWS.scenarios.columns,
    defaultColDef: { sortable: true, filter: true, floatingFilter: true, resizable: true },
    rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
    tooltipShowDelay: 300,
    isExternalFilterPresent: () => view === 'scenarios' && pressed.size > 0,
    doesExternalFilterPass: (node) => pressed.has(node.data.verdict),
    onSelectionChanged: () => {
      const [row] = grid.getSelectedRows();
      $('xp-detail').innerHTML = row ? VIEWS[view].detail(row) : '<p class="hint">Pick a row to see its details.</p>';
    },
    onModelUpdated: () => {
      const shown = grid?.getDisplayedRowCount?.() ?? 0;
      $('xp-count').textContent = `${shown.toLocaleString('en-US')} of ${VIEWS[view].rows.length.toLocaleString('en-US')} rows`;
    },
  });

  function show(next) {
    view = next;
    for (const b of document.querySelectorAll('.xp-tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === next));
    $('xp-chips').hidden = !VIEWS[next].verdicts;
    grid.setFilterModel(null);
    grid.setGridOption('columnDefs', VIEWS[next].columns);
    grid.setGridOption('rowData', VIEWS[next].rows);
    grid.onFilterChanged(); // the verdict chips apply to scenarios only
    $('xp-detail').innerHTML = '<p class="hint">Pick a row to see its details.</p>';
  }
  for (const b of document.querySelectorAll('.xp-tabs button')) b.addEventListener('click', () => show(b.dataset.tab));
  for (const b of document.querySelectorAll('#xp-chips button')) {
    b.addEventListener('click', () => {
      const v = b.dataset.v;
      if (pressed.has(v)) pressed.delete(v); else pressed.add(v);
      b.setAttribute('aria-pressed', String(pressed.has(v)));
      grid.onFilterChanged();
    });
  }
  $('xp-q').addEventListener('input', (e) => grid.setGridOption('quickFilterText', e.target.value));
})();
