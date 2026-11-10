// The explorer's browser script (site/explorer.mjs builds the page). It reads the page's JSON
// block and shows it in AG Grid Community. Every value AG Grid shows comes from a function here,
// never a string expression, so the page needs no 'unsafe-eval'. The view (tab, search, facets,
// column filters, picked row) lives in the URL's #, so a link opens the same view.
(() => {
  const data = JSON.parse(document.getElementById('xp-data').textContent);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (c) => (Number.isInteger(c) ? `$${(c / 100).toFixed(2)}` : '–');
  const signed = (c) => (Number.isInteger(c) ? `${c > 0 ? '+' : c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}` : '');
  const n = (x) => x.toLocaleString('en-US');
  const LABEL = { MERCHANT: 'Shop at fault', AGENT: 'Agent at fault', USER: 'Purchase stands', NEEDS_A_HUMAN: 'Needs a human' };
  const PICK = '<p class="hint">Pick a row to see its details.</p>';
  const VERDICT_TEXT = { MERCHANT: 'Shop at fault', AGENT: 'Agent at fault', USER: 'Purchase stands', NEEDS_A_HUMAN: 'Needs a human' };
  const FAMILY = { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', grok: 'Grok', muse: 'Muse', open: 'Open models' };

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
  const yesNo = (good, words) => (p) => (p.value === null || p.value === undefined ? '–' : p.value ? `<span class="xp-${good}">${esc(words[0])}</span>` : `<span class="xp-${good === 'ok' ? 'bad' : 'ok'}">${esc(words[1])}</span>`);
  const moneyCol = (field, headerName, width = 110) => ({ field, headerName, width, type: 'numericColumn', filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value) });
  const flowCol = (field, headerName) => ({ field, headerName, width: 130, type: 'numericColumn', filter: 'agNumberColumnFilter', valueFormatter: (p) => signed(p.value),
    cellClassRules: { 'xp-pos': (p) => p.value > 0, 'xp-neg': (p) => p.value < 0, 'xp-sum': (p) => p.node.rowPinned === 'bottom' } });
  const kv = (k, v) => (v || v === 0 ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '');
  const caseLink = (id) => `<p class="xp-note"><a href="../bench/${encodeURIComponent(id)}/">Open case ${esc(id)} →</a></p>`;

  // ---- every combination of the 16 facts, from the engine's rule number for each (built once, on first use)
  const D = data.decisions;
  const verdictOfRule = (rule) => D.ruleVerdict[rule];
  let decisionRows;
  const decisions = () => (decisionRows ??= Array.from({ length: D.rules.length }, (_, bits) => ({ bits, rule: Number(D.rules[bits]), bench: (D.benchAt[bits] ?? []).join(' ') })));
  const factOn = (bits, f) => Boolean((bits >> f.bit) & 1);
  const factGroups = [...new Set(D.facts.map((f) => f.group))].map((g) => ({
    headerName: g,
    children: D.facts.filter((f) => f.group === g).map((f) => ({
      colId: f.key, headerName: f.caption, headerTooltip: f.tip, width: 130,
      valueGetter: (p) => (p.data ? (factOn(p.data.bits, f) ? 'yes' : 'no') : ''),
      cellRenderer: (p) => (p.value ? `<span class="xp-lamp ${p.value === 'yes' ? 'on' : 'off'}">${p.value === 'yes' ? '● yes' : '○ no'}</span>` : ''),
      filterParams: { filterOptions: ['equals', 'notEqual'], maxNumConditions: 1 },
    })),
  }));
  const ruleCount = (rule) => D.rules.split('').filter((r) => Number(r) === rule).length;

  // A link to a view with exact-match column filters, e.g. one model's runs against one lie.
  const viewHref = (v, equals) => {
    const f = Object.fromEntries(Object.entries(equals).map(([k, value]) => [k, { filterType: 'text', type: 'equals', filter: value }]));
    return `#${new URLSearchParams({ v, f: JSON.stringify(f) })}`;
  };

  // ---- the ledger's total row: each side's net over the rows the filters leave
  const ledgerTotals = (api) => {
    const t = { step: 'Net, for the rows shown', buyerCents: 0, shopCents: 0, appCents: 0 };
    api.forEachNodeAfterFilter((node) => { for (const k of ['buyerCents', 'shopCents', 'appCents']) t[k] += node.data[k] ?? 0; });
    return [t];
  };

  // ---- facets: each view's chips, one group per facet. Within a group the chips are OR, across
  // groups AND. A chip's count is how many rows it would give, with every other filter as it is.
  const facet = (key, label, get, opts = {}) => ({ key, label, get, ...opts });
  const verdictFacet = (get) => facet('verdict', 'Verdict', get, { order: Object.keys(VERDICT_TEXT), text: (v) => VERDICT_TEXT[v] ?? v, colour: true });
  const RECORD_MASK = D.facts.filter((f) => f.group === 'The record').reduce((m, f) => m | (1 << f.bit), 0);

  const VIEWS = {
    scenarios: {
      rows: () => data.scenarios,
      key: (r) => r.id,
      facets: [
        verdictFacet((r) => r.verdict),
        facet('group', 'Group', (r) => r.group),
        facet('agent', 'Agent', (r) => FAMILY[r.family] ?? r.family),
        facet('paypal', 'PayPal', (r) => (r.live ? 'Live sandbox' : 'Simulated')),
      ],
      lead: 'Each scenario’s right answer is written down before the engine sees it. Pick one for its PayPal IDs, signatures and facts.',
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
        { field: 'settlement', headerName: 'Settlement (sandbox)', width: 320 },
        { field: 'pass', headerName: 'Bench', width: 100, pinned: 'right', cellRenderer: yesNo('ok', ['✓ right', '✗ wrong']) },
      ],
      detail: (r) => `<h3><span class="xp-v ${esc(r.verdict)}">${esc(LABEL[r.verdict])}</span> · ${esc(r.id)} · rule ${r.rule}</h3>
<p class="hint">${esc(r.title)}. ${esc(r.ruleText)}</p>
<dl class="xp-kv">
${kv('PayPal action', r.outcome + (r.held ? ' (held until the AI check answers)' : ''))}
${kv('Expected', r.expected)}
${kv('Dispute', r.disputeId ? `${r.disputeId}${r.live ? ' · live sandbox' : ' · simulated'}` : '')}
${kv('Order', r.orderId)}${kv('Capture', r.captureId)}
${r.executed.map((e) => kv('Black Box', e)).join('')}
${kv('Payout', r.payout)}
${kv('Settlement', r.settlement)}
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
<p class="xp-note"><a href="#v=decisions&amp;id=${r.bits}">See this exact combination of facts among all ${n(D.rules.length)} →</a></p>
${r.live ? `<p class="xp-note"><a href="${esc(viewHref('ledger', { caseId: r.id }))}">See the money in this dispute →</a></p>` : ''}
${caseLink(r.id)}`,
    },
    ledger: {
      rows: () => data.ledger,
      key: (r) => String(r.seq),
      facets: [
        verdictFacet((r) => r.verdict),
        facet('case', 'Dispute', (r) => r.caseId),
        facet('by', 'Done by', (r) => r.by),
        facet('money', 'Money', (r) => (r.buyerCents || r.shopCents || r.appCents ? 'Moves money' : 'No money moves')),
      ],
      totals: ledgerTotals,
      lead: 'Every step of the live sandbox disputes and what it did to each side’s money. The payment, the refunds, the fees and the payout are PayPal’s own figures. Filter to one dispute to see its net.',
      columns: [
        { field: 'caseId', headerName: 'Case', width: 90, pinned: 'left' },
        { field: 'disputeId', headerName: 'Dispute ID', width: 170 },
        { field: 'verdict', headerName: 'Verdict', width: 160, cellRenderer: verdictCell },
        { field: 'step', headerName: 'Step', flex: 2, minWidth: 300 },
        { headerName: 'Money, from each side', children: [flowCol('buyerCents', 'Buyer'), flowCol('shopCents', 'Shop'), flowCol('appCents', 'Shopping app')] },
        { field: 'by', headerName: 'Done by', width: 120 },
        { field: 'http', headerName: 'HTTP', width: 90, filter: 'agNumberColumnFilter' },
        { field: 'ref', headerName: 'PayPal reference', width: 230 },
        { field: 'at', headerName: 'Time (UTC)', width: 210 },
      ],
      detail: (r) => `<h3>${esc(r.step)}</h3><p class="hint">${esc(r.caseId)} · ${esc(r.disputeId)} · <span class="xp-v ${esc(r.verdict)}">${esc(LABEL[r.verdict])}</span> rule ${r.rule}</p>
<dl class="xp-kv">${kv('Time', r.at)}${kv('Done by', r.by)}${kv('Buyer', signed(r.buyerCents))}${kv('Shop', signed(r.shopCents))}${kv('Shopping app', signed(r.appCents))}
${kv('HTTP status', r.http)}${kv('PayPal reference', r.ref)}${kv('Order', r.orderId)}${kv('Capture', r.captureId)}${kv('What started Black Box', r.trigger)}</dl>
${caseLink(r.caseId)}`,
    },
    decisions: {
      rows: decisions,
      key: (r) => String(r.bits),
      facets: [
        verdictFacet((r) => verdictOfRule(r.rule)),
        facet('rule', 'Rule', (r) => `Rule ${r.rule}`, { order: [1, 2, 3, 4, 5, 6].map((k) => `Rule ${k}`) }),
        facet('record', 'The record', (r) => ((r.bits & RECORD_MASK) === RECORD_MASK ? 'Intact' : 'Broken'), { order: ['Intact', 'Broken'] }),
        facet('bench', 'Bench', (r) => (r.bench ? 'A bench case lands here' : 'No bench case')),
      ],
      lead: `All ${n(D.rules.length)} ways the 16 facts can come out, each judged by the engine itself, as the property test does. ${n(ruleCount(1))} have a broken record, and those all go to a person (rule 1). Type “no” under a fact to see what happens without it.`,
      columns: [
        { field: 'rule', headerName: 'Rule', width: 80, pinned: 'left', filter: 'agNumberColumnFilter' },
        { colId: 'verdict', headerName: 'Verdict', width: 160, pinned: 'left', valueGetter: (p) => (p.data ? verdictOfRule(p.data.rule) : ''), cellRenderer: verdictCell },
        ...factGroups,
        { field: 'bench', headerName: 'Bench cases here', width: 170, pinned: 'right' },
      ],
      detail: (r) => `<h3><span class="xp-v ${esc(verdictOfRule(r.rule))}">${esc(LABEL[verdictOfRule(r.rule)])}</span> · rule ${r.rule}</h3>
<p class="hint">${esc(D.ruleText[r.rule])}</p>
<ul class="xp-lamps" aria-label="The 16 facts">${D.facts.map((f) => `<li class="${factOn(r.bits, f) ? 'on' : ''}" title="${esc(f.tip)}">${esc(f.caption)}</li>`).join('')}</ul>
${r.bench ? `<p class="xp-note">Bench cases with exactly these facts: ${r.bench.split(' ').map((id) => `<a href="../bench/${encodeURIComponent(id)}/">${esc(id)}</a>`).join(', ')}</p>` : '<p class="xp-note">No bench case has exactly these facts.</p>'}`,
    },
    cells: {
      rows: () => data.cells,
      key: (r) => `${r.setup}|${r.model}|${r.lie}`,
      facets: [
        facet('agent', 'Agent', (r) => FAMILY[r.family] ?? r.family),
        facet('setup', 'Setup', (r) => r.setup),
        facet('who', 'Lie hidden by', (r) => r.who),
        facet('reading', 'Reading', (r) => r.kind || 'no runs'),
      ],
      lead: 'Each model against each hidden lie: how often it bought over budget with the lie on the page, and without it. Not a ranking: each provider ran at its own default settings.',
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
<p class="xp-note"><a href="${esc(viewHref('runs', { model: r.model, setup: r.setup, lie: r.lie }))}">See these ${r.lieN + r.ctlN} runs →</a></p>`,
    },
    runs: {
      rows: () => data.runs,
      key: (r) => `${r.setup}|${r.model}|${r.at}|${r.lie}|${r.condition}`,
      facets: [
        facet('agent', 'Agent', (r) => FAMILY[r.family] ?? r.family),
        facet('setup', 'Setup', (r) => r.setup),
        facet('page', 'Page', (r) => r.condition),
        facet('result', 'Result', (r) => (r.bought === null ? 'error' : r.bought ? 'Bought over budget' : 'Stayed within')),
      ],
      lead: 'Every run of the study, with the agent’s own reason. Search a phrase, such as “agent-channel”, to find every run that believed the hidden note.',
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

  let picked = {}; // facet key -> Set of chosen values
  let view = 'scenarios';
  let restoring = false;
  let grid = null;
  const chosen = () => Object.entries(picked).filter(([, set]) => set.size);
  const facetsOf = () => VIEWS[view].facets ?? [];
  // The facets a row fails, of those with chips chosen.
  const fails = (data) => facetsOf().filter((f) => picked[f.key]?.size && !picked[f.key].has(f.get(data)));
  grid = createGrid($('xp-grid'), {
    theme,
    rowData: [],
    columnDefs: [],
    defaultColDef: { sortable: true, filter: true, floatingFilter: true, resizable: true },
    rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
    tooltipShowDelay: 300,
    isExternalFilterPresent: () => chosen().length > 0,
    doesExternalFilterPass: (node) => fails(node.data).length === 0,
    onSelectionChanged: (e) => {
      const [row] = e.api.getSelectedRows();
      $('xp-detail').innerHTML = row ? VIEWS[view].detail(row) : PICK;
      saveView();
    },
    onFilterChanged: (e) => {
      countFacets(e.api);
      if (VIEWS[view].totals) e.api.setGridOption('pinnedBottomRowData', VIEWS[view].totals(e.api));
      saveView();
    },
    onModelUpdated: (e) => {
      $('xp-count').textContent = `${n(e.api.getDisplayedRowCount())} of ${n(VIEWS[view].rows().length)} rows`;
    },
  });

  // Counts each chip: the rows that pass the search, the column filters and every other facet
  // group. The grid filters asynchronously, so the counts test those filters here, the way the
  // grid does: search words must all appear in a row's values, and each column filter's model holds.
  const textPass = (val, c) => {
    const v = val === null || val === undefined ? '' : String(val).toLowerCase();
    const f = String(c.filter ?? '').toLowerCase();
    return ({ contains: () => v.includes(f), notContains: () => !v.includes(f), equals: () => v === f, notEqual: () => v !== f,
      startsWith: () => v.startsWith(f), endsWith: () => v.endsWith(f), blank: () => v === '', notBlank: () => v !== '' })[c.type]?.() ?? true;
  };
  const numberPass = (v, c) => {
    if (c.type === 'blank') return v === null || v === undefined;
    if (c.type === 'notBlank') return v !== null && v !== undefined;
    if (v === null || v === undefined) return false;
    return ({ equals: () => v === c.filter, notEqual: () => v !== c.filter, lessThan: () => v < c.filter, lessThanOrEqual: () => v <= c.filter,
      greaterThan: () => v > c.filter, greaterThanOrEqual: () => v >= c.filter, inRange: () => v > c.filter && v < c.filterTo })[c.type]?.() ?? true;
  };
  const modelPass = (val, m) => {
    const one = (c) => (m.filterType === 'number' ? numberPass(val, c) : textPass(val, c));
    const conditions = m.conditions ?? [m];
    return m.operator === 'OR' ? conditions.some(one) : conditions.every(one);
  };
  function countFacets(api) {
    const model = Object.entries(api.getFilterModel() ?? {});
    const words = $('xp-q').value.toLowerCase().split(' ').filter(Boolean);
    const columns = words.length ? api.getColumns() : [];
    const counts = Object.fromEntries(facetsOf().map((f) => [f.key, new Map()]));
    api.forEachNode((node) => {
      if (model.some(([colKey, m]) => !modelPass(api.getCellValue({ rowNode: node, colKey }), m))) return;
      if (words.length) {
        const text = columns.map((col) => api.getCellValue({ rowNode: node, colKey: col })).join('\n').toLowerCase();
        if (!words.every((w) => text.includes(w))) return;
      }
      const failed = fails(node.data);
      if (failed.length > 1) return;
      for (const f of failed.length ? failed : facetsOf()) {
        const v = f.get(node.data);
        counts[f.key].set(v, (counts[f.key].get(v) ?? 0) + 1);
      }
    });
    renderFacets(counts);
  }

  // Every value a facet can take in this view, in a fixed order, so chips don't jump about.
  const allValues = new Map();
  function valuesOf(f) {
    const id = `${view}:${f.key}`;
    if (!allValues.has(id)) {
      const total = new Map();
      for (const r of VIEWS[view].rows()) total.set(f.get(r), (total.get(f.get(r)) ?? 0) + 1);
      const order = f.order ?? [...total.keys()].sort((a, b) => total.get(b) - total.get(a) || String(a).localeCompare(String(b)));
      allValues.set(id, order.filter((v) => total.has(v)));
    }
    return allValues.get(id);
  }

  function renderFacets(counts) {
    $('xp-facets').innerHTML = facetsOf().map((f) => `<div class="xp-facet" role="group" aria-label="${esc(f.label)}"><span class="lab">${esc(f.label)}</span>${valuesOf(f).map((v) => {
      const on = picked[f.key]?.has(v) ?? false;
      const c = counts[f.key].get(v) ?? 0;
      return `<button type="button" class="${f.colour ? esc(v) : ''}${c || on ? '' : ' zero'}" data-f="${esc(f.key)}" data-v="${esc(v)}" aria-pressed="${on}">${f.colour ? '<i></i>' : ''}${esc(f.text ? f.text(v) : v)}<small>${n(c)}</small></button>`;
    }).join('')}</div>`).join('');
  }

  function show(next, state = {}) {
    view = VIEWS[next] ? next : 'scenarios';
    const V = VIEWS[view];
    restoring = true;
    for (const b of document.querySelectorAll('.xp-tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === view));
    $('xp-lead').textContent = V.lead;
    picked = {};
    for (const [k, vs] of Object.entries(state.facets ?? {})) if (V.facets?.some((f) => f.key === k)) picked[k] = new Set([].concat(vs).map(String));
    $('xp-q').value = state.q ?? '';
    grid.setGridOption('pinnedBottomRowData', []);
    grid.setGridOption('columnDefs', V.columns);
    grid.setGridOption('rowData', V.rows());
    grid.setGridOption('quickFilterText', state.q ?? '');
    grid.setFilterModel(state.f ?? null);
    grid.onFilterChanged();
    $('xp-detail').innerHTML = PICK;
    if (state.id !== undefined) {
      grid.forEachNode((node) => {
        if (V.key(node.data) !== state.id) return;
        node.setSelected(true);
        setTimeout(() => grid.ensureNodeVisible(node, 'top'), 50); // once the new rows are drawn
      });
    }
    restoring = false;
    saveView();
  }

  // The view in the URL's #: v (tab), q (search), fc (facet chips), f (column filters), id (picked row).
  function saveView() {
    if (restoring || !grid) return;
    const p = new URLSearchParams({ v: view });
    const q = $('xp-q').value;
    if (q) p.set('q', q);
    const fc = Object.fromEntries(chosen().map(([k, set]) => [k, [...set]]));
    if (Object.keys(fc).length) p.set('fc', JSON.stringify(fc));
    const f = grid.getFilterModel();
    if (f && Object.keys(f).length) p.set('f', JSON.stringify(f));
    const [row] = grid.getSelectedRows();
    if (row) p.set('id', VIEWS[view].key(row));
    history.replaceState(null, '', `#${p}`);
  }
  function readView() {
    const p = new URLSearchParams(location.hash.slice(1));
    const json = (k) => { try { return p.get(k) ? JSON.parse(p.get(k)) : null; } catch { return null; } };
    const facets = json('fc') ?? {};
    if (p.get('vd')) facets.verdict = p.get('vd').split(','); // links made before the facet bar
    return { v: p.get('v') ?? 'scenarios', q: p.get('q') ?? '', facets, f: json('f'), id: p.get('id') ?? undefined };
  }

  for (const b of document.querySelectorAll('.xp-tabs button')) b.addEventListener('click', () => show(b.dataset.tab));
  $('xp-facets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    const set = (picked[b.dataset.f] ??= new Set());
    if (set.has(b.dataset.v)) set.delete(b.dataset.v); else set.add(b.dataset.v);
    grid.onFilterChanged();
  });
  $('xp-q').addEventListener('input', (e) => { grid.setGridOption('quickFilterText', e.target.value); saveView(); });
  $('xp-csv').addEventListener('click', () => grid.exportDataAsCsv({ fileName: `black-box-${view}.csv` }));
  $('xp-link').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(location.href); b.textContent = 'Link copied'; } catch { b.textContent = 'Copy the address bar'; }
    setTimeout(() => { b.textContent = 'Copy link to this view'; }, 2000);
  });
  // A link inside the page (a detail panel, or one from another page) changes the #: show that view.
  window.addEventListener('hashchange', () => { const s = readView(); show(s.v, s); });

  const start = readView();
  show(start.v, start);
})();
