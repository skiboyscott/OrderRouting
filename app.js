// Order routing engine console — state, view derivation, and rendering.
// Vanilla JS: a single state object, a pure `deriveView` step (mirrors the
// prototype's renderVals()), and template-string renderers. Event handling
// uses delegation with data-action attributes instead of closures, since the
// whole app root is replaced on every render.
(function () {
  'use strict';
  const E = window.Engine;
  const $app = document.getElementById('app');

  const SLIDER_DEFS = [
    {
      field: 'lateTolerance', label: 'Late tolerance', min: 0, max: 3, step: 1,
      display: v => v === 0 ? 'None' : v + ' day' + (v === 1 ? '' : 's'),
      note: 'How many days past the promised date the engine may accept as-is. At none, it spends up to your premium cap to buy the date back before ever accepting a later one.'
    },
    {
      field: 'maxPremium', label: 'Max premium to protect the date', min: 0, max: 30, step: 1,
      display: v => E.money(v),
      note: 'Extra spend per parcel the engine may accept over the cheapest available route in order to hit the promise. Above this it falls back within your late tolerance and says so.'
    },
    {
      field: 'costCeiling', label: 'Cost ceiling per parcel', min: 10, max: 60, step: 1,
      display: v => E.money(v),
      note: 'A selected route above this still ships — the date is never broken to save money — and the overage is reported on the order so you see the bill.'
    },
    {
      field: 'loadThreshold', label: 'Facility load penalty threshold', min: 60, max: 95, step: 5,
      display: v => v + '%',
      note: 'Above this utilization a facility gets a one-day handling penalty in transit math, pushing volume toward quieter buildings.'
    }
  ];
  const OBJ_DEFS = [
    { id: 'promise', label: 'Protect the promise', note: 'Pick the cheapest route that still hits the promised date. Cost only ever chooses among on-time routes.' },
    { id: 'cost', label: 'Minimize cost, date as floor', note: 'Pick the cheapest route that lands within your late tolerance. Faster routes win only when nothing cheaper qualifies.' }
  ];

  let state = {
    view: 'queue', section: 'Orders', selected: 'O-1002', query: '', filter: 'All',
    tab: 'All routes', runAt: Date.now(), rules: E.loadRules()
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pct(n, total) { return Math.round(n / total * 100) + '%'; }
  function sliderDisplayFor(field, value) {
    const def = SLIDER_DEFS.find(d => d.field === field);
    return def ? def.display(value) : String(value);
  }

  function setState(patch) { state = Object.assign({}, state, patch); render(); }
  function setRule(patch) {
    const rules = Object.assign({}, state.rules, patch);
    state = Object.assign({}, state, { rules });
    E.saveRules(rules);
    render();
  }
  function step(d) {
    const { results } = E.runEngine(state.rules);
    const i = results.findIndex(r => r.order.id === state.selected);
    const base = i === -1 ? 0 : i;
    const n = results[(base + d + results.length) % results.length];
    setState({ selected: n.order.id });
  }

  // ---------- derive all display data for the current state ----------
  function deriveView(state) {
    const rules = state.rules;
    const { results, inv } = E.runEngine(rules);
    const view = state.view;
    const byId = {};
    results.forEach(r => { byId[r.order.id] = r; });
    const sel = byId[state.selected] || results[0];
    const o = sel.order;

    const hits = results.filter(r => r.mode === 'ok').length;
    const tolerated = results.filter(r => r.mode === 'tolerated').length;
    const needsReview = results.filter(r => r.mode === 'late' || r.mode === 'no-stock').length;
    const overCap = results.filter(r => r.flags.indexOf('over-ceiling') >= 0).length;
    const routed = results.filter(r => r.pick);
    const avg = routed.length ? routed.reduce((s, r) => s + r.pick.cost, 0) / routed.length : 0;
    const cheapAvg = results.filter(r => r.cheapestStock).reduce((s, r) => s + r.cheapestStock.cost, 0) / Math.max(1, results.filter(r => r.cheapestStock).length);

    const q = state.query.trim().toLowerCase();
    const filtered = results.filter(r => {
      const pass = state.filter === 'All'
        || (state.filter === 'On promise' && r.mode === 'ok')
        || (state.filter === 'Auto-adjusted' && r.mode !== 'ok')
        || (state.filter === 'Over cost cap' && r.flags.indexOf('over-ceiling') >= 0);
      const hit = !q || r.order.id.toLowerCase().includes(q) || r.order.city.toLowerCase().includes(q)
        || r.order.sku.toLowerCase().includes(q) || E.SKUS[r.order.sku].toLowerCase().includes(q);
      return pass && hit;
    });

    const orders = filtered.map(r => {
      const st = E.statusOf(r);
      const m = r.pick ? r.order.eddDays - r.pick.transit : null;
      const overCeil = r.flags.indexOf('over-ceiling') >= 0;
      return {
        seq: r.rank, id: r.order.id, dest: r.order.city, zone: r.order.zone,
        sku: r.order.sku, skuName: E.SHORT[r.order.sku] + (r.order.qty > 1 ? ' × ' + r.order.qty : ''),
        edd: E.fmtShort(r.order.eddDays),
        arrive: r.pick ? E.fmtShort(r.pick.transit) : '—',
        arriveColor: r.pick ? (r.pick.onTime ? '#475467' : 'var(--warn)') : 'var(--bad)',
        margin: m === null ? '—' : m > 0 ? '+' + m + 'd' : m === 0 ? '0d' : '−' + Math.abs(m) + 'd',
        route: r.pick ? r.pick.fc.id + ' · ' + r.pick.svc.carrier : 'No route',
        routeMeta: r.pick ? r.pick.svc.carrierCode + ' ' + (r.pick.svc.mode === 'expedited' ? 'exp.' : r.pick.svc.mode) : 'no stock',
        cost: r.pick ? E.money(r.pick.cost) : '—',
        status: st.label, dotKey: st.key,
        subStatus: overCeil ? 'over cost cap' : 'open ›',
        subColor: overCeil ? 'var(--warn)' : 'var(--faint)'
      };
    });

    const total = sel.combos.length || 1;
    const funnel = [
      { label: 'Evaluated', count: sel.combos.length, pctv: '100%', color: '#475467' },
      { label: 'Stock', count: sel.stockPass.length, pctv: pct(sel.stockPass.length, total), color: sel.stockPass.length ? 'var(--ok)' : 'var(--bad)' },
      { label: 'Promise', count: sel.promisePass.length, pctv: pct(sel.promisePass.length, total), color: sel.promisePass.length ? 'var(--ok)' : 'var(--warn)' },
      { label: 'Selected', count: sel.pick ? 1 : 0, pctv: pct(sel.pick ? 1 : 0, total), color: 'var(--acc)' }
    ];

    const tab = state.tab;
    const visible = sel.combos.filter(c => {
      if (tab === 'Passed both gates') return c.hasStock && c.onTime;
      if (tab === 'Eliminated') return !c.hasStock || !c.onTime;
      return true;
    });
    const combos = visible.map(c => {
      const isPick = sel.pick && c.key === sel.pick.key;
      let verdict, verdictKey;
      if (!c.hasStock) { verdict = 'No stock'; verdictKey = 'mute'; }
      else if (isPick && !c.onTime) { verdict = 'Selected · ' + c.lateBy + 'd late'; verdictKey = 'warn'; }
      else if (isPick) { verdict = 'Selected · cheapest on-time'; verdictKey = 'ok'; }
      else if (!c.onTime) { verdict = 'Misses promise by ' + c.lateBy + 'd'; verdictKey = 'warn'; }
      else { verdict = 'Eligible · not cheapest'; verdictKey = 'neutral'; }
      return {
        fcName: c.fc.name, fcMeta: c.fc.id + ' · ' + Math.round(c.fc.load * 100) + '% load',
        carrier: c.svc.carrier, service: c.svc.name + ' · ' + c.svc.carrierCode,
        miles: c.mi.toLocaleString(), stock: c.stock, stockOk: c.hasStock,
        transit: c.transit + 'd' + (c.penalty ? '*' : ''),
        arrive: E.fmtDate(c.transit), onTime: c.onTime,
        cost: E.money(c.cost), verdict, verdictKey,
        selected: isPick, faded: !c.hasStock
      };
    });

    const ledger = results.map(r => {
      const st = E.statusOf(r);
      return {
        seq: r.rank, id: r.order.id, tag: st.label, key: st.key,
        text: r.pick
          ? 'Reserved 1 × ' + r.order.sku + ' at ' + r.pick.fc.name + ' · ' + r.pick.svc.carrier + ' ' + r.pick.svc.name.toLowerCase() + ' to ' + r.order.city + ' · ' + E.money(r.pick.cost) + ' · arrives ' + E.fmtDate(r.pick.transit) + ' against a ' + E.fmtDate(r.order.eddDays) + ' promise'
          : 'No reservation — ' + r.order.sku + ' unavailable at every active facility'
      };
    });

    const usedBy = {};
    results.forEach(r => { if (r.pick) usedBy[r.pick.fc.id] = (usedBy[r.pick.fc.id] || 0) + 1; });
    const svcUse = {};
    results.forEach(r => { if (r.pick) svcUse[r.pick.svc.id] = (svcUse[r.pick.svc.id] || 0) + 1; });

    const inventory = E.FCS.map(f => {
      const taken = k => E.INV0[f.id][k] - inv[f.id][k];
      const cell = k => inv[f.id][k] + (taken(k) ? ' (−' + taken(k) + ')' : '');
      return {
        fc: f.name, code: f.id + ' · ' + f.region + ' · cutoff ' + f.cutoff,
        d1: cell('SKU-1042'), c1: inv[f.id]['SKU-1042'] ? '#475467' : 'var(--bad)',
        d2: cell('SKU-2110'), c2: inv[f.id]['SKU-2110'] ? '#475467' : 'var(--bad)',
        d3: cell('SKU-3301'), c3: inv[f.id]['SKU-3301'] ? '#475467' : 'var(--bad)',
        load: Math.round(f.load * 100) + '%', loadKey: f.load * 100 > rules.loadThreshold ? 'warn' : 'neutral'
      };
    });

    const facilities = E.FCS.map(f => {
      const paused = rules.pausedFcs.indexOf(f.id) >= 0;
      const hot = f.load * 100 > rules.loadThreshold;
      const used = usedBy[f.id] || 0;
      return {
        name: f.name, code: f.id, paused, hot,
        meta: f.region + ' · order cutoff ' + f.cutoff + ' · ' + f.carriers.length + ' carriers',
        load: Math.round(f.load * 100) + '%',
        loadNote: hot
          ? 'Over your ' + rules.loadThreshold + '% threshold — routes out of here carry a +1 day handling penalty.'
          : 'Under your ' + rules.loadThreshold + '% threshold — no handling penalty applied.',
        stock: [
          { label: 'Skillet', value: inv[f.id]['SKU-1042'], color: inv[f.id]['SKU-1042'] ? 'var(--ink)' : 'var(--bad)' },
          { label: 'Throw', value: inv[f.id]['SKU-2110'], color: inv[f.id]['SKU-2110'] ? 'var(--ink)' : 'var(--bad)' },
          { label: 'Mug set', value: inv[f.id]['SKU-3301'], color: inv[f.id]['SKU-3301'] ? 'var(--ink)' : 'var(--bad)' }
        ],
        carriers: f.carriers.map(code => {
          const c = E.CARRIERS.find(x => x.code === code);
          const live = c.services.some(s => rules.pausedServices.indexOf(s.id) < 0 && (rules.allowAir || s.mode !== 'air'));
          return { label: c.name + ' · ' + c.services.length + ' services', live };
        }),
        usage: paused ? 'Excluded by rule' : used ? used + (used === 1 ? ' order routed here' : ' orders routed here') : 'No orders routed here',
        usageColor: paused ? 'var(--mute)' : used ? 'var(--ok)' : 'var(--ink-4)'
      };
    });

    const carriers = E.CARRIERS.map(c => {
      const used = c.services.reduce((s, x) => s + (svcUse[x.id] || 0), 0);
      return {
        name: c.name, code: c.code, meta: c.meta,
        usage: used ? used + ' of ' + results.length + ' orders' : 'Unused this batch',
        usageKey: used ? 'acc' : 'mute',
        coverage: E.FCS.filter(f => f.carriers.indexOf(c.code) >= 0).map(f => f.name).join(', '),
        services: c.services.map(s => {
          const airBlocked = !rules.allowAir && s.mode === 'air';
          const off = rules.pausedServices.indexOf(s.id) >= 0 || airBlocked;
          return {
            id: s.id, name: s.name, note: airBlocked ? 'Blocked by the no-air rule' : s.note,
            speed: s.milesPerDay.toLocaleString(),
            rate: E.money(s.base) + ' + ' + s.perMi.toFixed(3) + '/mi',
            used: (svcUse[s.id] || 0) + '×', off, blocked: airBlocked
          };
        })
      };
    });

    const evaluated = results.reduce((s, r) => s + r.combos.length, 0) || 1;
    const stockOut = results.reduce((s, r) => s + (r.combos.length - r.stockPass.length), 0);
    const lateOut = results.reduce((s, r) => s + (r.stockPass.length - r.promisePass.length), 0);
    const survived = results.reduce((s, r) => s + r.promisePass.length, 0);
    const gateTotals = [
      { label: 'Eliminated at the stock gate', value: stockOut + ' of ' + evaluated, pctv: pct(stockOut, evaluated), key: 'bad', note: 'Facility held no units of the ordered SKU, taking all of its carrier services with it.' },
      { label: 'Had stock, missed the promise', value: lateOut + ' of ' + evaluated, pctv: pct(lateOut, evaluated), key: 'warn', note: 'Shown explicitly rather than hidden — this is where the promise does work cost would not.' },
      { label: 'Reached the cost gate', value: survived + ' of ' + evaluated, pctv: pct(survived, evaluated), key: 'ok', note: 'Cheapest of these wins per order, subject to your premium cap and cost ceiling.' }
    ];

    const modeUse = { ground: 0, expedited: 0, air: 0 };
    results.forEach(r => { if (r.pick) modeUse[r.pick.svc.mode]++; });
    const carrierMix = E.CARRIERS.map(c => {
      const n = c.services.reduce((s, x) => s + (svcUse[x.id] || 0), 0);
      return { label: c.name, value: n + (n === 1 ? ' order' : ' orders'), pctv: pct(n, results.length), color: n ? 'var(--acc)' : '#eaecf0' };
    }).concat([
      { label: 'By mode · ground / expedited / air', value: modeUse.ground + ' / ' + modeUse.expedited + ' / ' + modeUse.air, pctv: '100%', color: '#cdd3e0' }
    ]);

    const baseSum = E.summary(E.DEFAULTS);
    const nowSum = E.summary(rules);
    const deltaStr = (a, b, isMoney) => {
      const d = a - b;
      if (Math.abs(d) < 0.005) return { t: 'same', c: 'var(--mute)' };
      const s = (d > 0 ? '+' : '−') + (isMoney ? E.money(Math.abs(d)).slice(1) : Math.abs(d).toFixed(0));
      return { t: s, c: d > 0 ? (isMoney ? 'var(--warn)' : 'var(--ok)') : (isMoney ? 'var(--ok)' : 'var(--warn)') };
    };
    const dHits = deltaStr(nowSum.hits, baseSum.hits, false);
    const dAdj = deltaStr(nowSum.adjusted, baseSum.adjusted, false);
    const dCap = deltaStr(nowSum.overCap, baseSum.overCap, false);
    const dAvg = deltaStr(nowSum.avg, baseSum.avg, true);
    const dSpend = deltaStr(nowSum.spend, baseSum.spend, true);
    const impact = [
      { label: 'On-promise orders', value: nowSum.hits + '/' + nowSum.n, base: baseSum.hits + '/' + baseSum.n, delta: dHits.t, deltaColor: dHits.c },
      { label: 'Auto-adjusted', value: String(nowSum.adjusted), base: String(baseSum.adjusted), delta: dAdj.t, deltaColor: dAdj.t === 'same' ? 'var(--mute)' : (nowSum.adjusted > baseSum.adjusted ? 'var(--warn)' : 'var(--ok)') },
      { label: 'Over cost cap', value: String(nowSum.overCap), base: String(baseSum.overCap), delta: dCap.t, deltaColor: dCap.t === 'same' ? 'var(--mute)' : (nowSum.overCap > baseSum.overCap ? 'var(--warn)' : 'var(--ok)') },
      { label: 'Avg cost per parcel', value: E.money(nowSum.avg), base: E.money(baseSum.avg), delta: dAvg.t, deltaColor: dAvg.c },
      { label: 'Batch shipping spend', value: E.money(nowSum.spend), base: E.money(baseSum.spend), delta: dSpend.t, deltaColor: dSpend.c }
    ];

    const mkNav = (items, sectionState) => items.map(n => ({
      label: n.label, view: n.view,
      filter: n.label === 'Auto-adjusted' ? 'Auto-adjusted' : 'All',
      badge: n.badge || '', warn: !!n.warn,
      active: n.label === sectionState
    }));
    const navOperate = mkNav([
      { label: 'Orders', badge: String(results.length), view: 'queue' },
      { label: 'Auto-adjusted', badge: String(needsReview), warn: needsReview > 0, view: 'queue' }
    ], state.section);
    const navNetwork = mkNav([
      { label: 'Inventory', view: 'inventory' },
      { label: 'Facilities', badge: rules.pausedFcs.length ? String(rules.pausedFcs.length) + ' paused' : '', warn: true, view: 'facilities' },
      { label: 'Carriers', badge: String(E.CARRIERS.length), view: 'carriers' }
    ], state.section);
    const navConfigure = mkNav([{ label: 'Routing rules', view: 'rules' }], state.section);

    const sliders = SLIDER_DEFS.map(def => ({
      field: def.field, label: def.label, min: def.min, max: def.max, step: def.step,
      value: rules[def.field], display: def.display(rules[def.field]), note: def.note
    }));
    const toggles = [
      {
        label: 'Allow air services', value: rules.allowAir ? 'Allowed' : 'Blocked', on: rules.allowAir,
        note: 'Air is the only way to hold tight offshore promises. Blocking it drops ' + E.SERVICES.filter(s => s.mode === 'air').length + ' services from every facility.',
        action: 'toggle-air'
      },
      {
        label: 'Paused facilities', value: rules.pausedFcs.length ? rules.pausedFcs.join(', ') : 'None', on: rules.pausedFcs.length > 0,
        note: 'Managed on the Facilities page. Paused buildings are excluded before any gate runs.',
        action: 'goto', view: 'facilities', section: 'Facilities'
      },
      {
        label: 'Disabled carrier services', value: rules.pausedServices.length ? String(rules.pausedServices.length) : 'None', on: rules.pausedServices.length > 0,
        note: 'Managed on the Carriers page. Disabled services disappear from every route table.',
        action: 'goto', view: 'carriers', section: 'Carriers'
      }
    ];
    const objectives = OBJ_DEFS.map(ob => ({ id: ob.id, label: ob.label, note: ob.note, active: rules.objective === ob.id }));

    const sectionCrumb = { Orders: 'Orders', Exceptions: 'Orders', Inventory: 'Network', Facilities: 'Network', Carriers: 'Network', 'Routing rules': 'Configure' };
    const pageCrumb = { queue: 'Batch 2026-08-12', detail: 'Batch 2026-08-12', metrics: 'Metrics', inventory: 'Inventory', facilities: 'Facilities', carriers: 'Carriers', rules: 'Routing rules' };
    const tabs = [
      { label: 'Batch queue', count: String(results.length), view: 'queue', active: view !== 'metrics' },
      { label: 'Metrics', count: Math.round(hits / results.length * 100) + '%', view: 'metrics', active: view === 'metrics' }
    ];
    const comboTabs = ['All routes', 'Passed both gates', 'Eliminated'].map(t => ({ label: t, active: tab === t }));
    const ruleChips = [
      { label: rules.objective === 'promise' ? 'Promise first' : 'Cost first, date as floor', on: true },
      { label: rules.lateTolerance ? rules.lateTolerance + 'd late tolerance' : 'No late tolerance', on: rules.lateTolerance > 0 },
      { label: E.money(rules.maxPremium) + ' premium cap', on: rules.maxPremium !== E.DEFAULTS.maxPremium },
      { label: E.money(rules.costCeiling) + ' cost ceiling', on: rules.costCeiling !== E.DEFAULTS.costCeiling },
      { label: rules.allowAir ? 'Air allowed' : 'Air blocked', on: !rules.allowAir },
      { label: rules.pausedFcs.length ? rules.pausedFcs.length + ' facility paused' : 'All facilities active', on: rules.pausedFcs.length > 0 }
    ];
    const rulesSummary = (rules.objective === 'promise' ? 'Promise-first' : 'Cost-first') + ' · ' + (rules.lateTolerance ? rules.lateTolerance + 'd tolerance' : 'no late tolerance') + ' · ' + E.money(rules.maxPremium) + ' premium cap';
    const kpis = [
      { label: 'EDD hit rate', value: Math.round(hits / results.length * 100) + '%', unit: hits + '/' + results.length, note: 'Gating metric — cost never overrides it', colorVar: hits === results.length ? 'var(--ok)' : 'var(--ink)' },
      { label: 'Auto-adjusted', value: String(needsReview), unit: needsReview === 1 ? 'order' : 'orders', note: 'Date revised or held by the engine itself', colorVar: needsReview ? 'var(--warn)' : 'var(--ok)' },
      { label: 'Avg ship cost', value: E.money(avg), unit: 'per parcel', note: overCap ? overCap + ' route' + (overCap === 1 ? '' : 's') + ' over your cost cap' : 'All routes inside your cost cap', colorVar: 'var(--ink)' },
      { label: 'Cost of the promise', value: E.money(avg - cheapAvg), unit: 'vs cheapest route', note: 'What holding the date costs per parcel', colorVar: 'var(--ink)' }
    ];

    const st = E.statusOf(sel);
    const margin = sel.pick ? o.eddDays - sel.pick.transit : null;
    const selVals = {
      id: o.id, rank: sel.rank, dest: o.city,
      summaryLine: E.SKUS[o.sku] + ' × ' + o.qty + ' · ' + o.city + ' · ' + o.zone + ' · promised ' + E.fmtDate(o.eddDays) + ' · sequence ' + sel.rank + ' of ' + results.length + ' by promise urgency',
      skuShort: E.SKUS[o.sku] + ' × ' + o.qty,
      eddLabel: E.fmtDate(o.eddDays) + ' · ' + o.eddDays + 'd',
      arrive: sel.pick ? E.fmtDate(sel.pick.transit) : '—',
      status: st.label, statusKey: st.key,
      verdictLabel: sel.mode === 'ok' ? 'Route selected · promise held' : sel.mode === 'tolerated' ? 'Late, inside your tolerance' : sel.mode === 'late' ? 'Auto-adjusted · best available date' : 'Held · no stock in network',
      routeTitle: sel.pick ? sel.pick.fc.name + ' → ' + o.city.split(',')[0] + ' · ' + sel.pick.svc.carrier + ' ' + sel.pick.svc.name.toLowerCase() : 'No route returned',
      routeMeta: sel.pick
        ? sel.pick.fc.id + ' · ' + sel.pick.mi.toLocaleString() + ' mi · ' + sel.pick.transit + 'd transit · ' + sel.stockPass.length + '/' + sel.combos.length + ' had stock, ' + sel.promisePass.length + ' held the date'
        : 'No active facility holds ' + o.sku,
      margin: margin === null ? '—' : margin > 0 ? '+' + margin + 'd' : margin === 0 ? '0d' : '−' + Math.abs(margin) + 'd',
      cost: sel.pick ? E.money(sel.pick.cost) : '—',
      premium: sel.pick && sel.cheapestStock ? E.money(sel.pick.cost - sel.cheapestStock.cost) : '—',
      comboNote: visible.length + ' of ' + sel.combos.length + ' combinations · ' + (E.FCS.length - rules.pausedFcs.length) + ' facilities × enabled services',
      funnel, combos,
      reasons: E.reasonsFor(sel, rules)
    };

    return {
      view, isQueue: view === 'queue', isDetail: view === 'detail', isMetrics: view === 'metrics',
      isInventory: view === 'inventory', isFacilities: view === 'facilities', isCarriers: view === 'carriers', isRules: view === 'rules',
      showTabs: view === 'queue' || view === 'detail' || view === 'metrics',
      crumbSection: sectionCrumb[state.section] || 'Orders',
      crumbPage: pageCrumb[view] || 'Batch 2026-08-12',
      tabs, filter: state.filter, query: state.query,
      navOperate, navNetwork, navConfigure,
      orders, ledger, inventory, facilities, carriers, gateTotals, carrierMix, impact,
      sliders, toggles, objectives, kpis,
      ruleNotes: [
        { key: 'bad', text: 'Cost never silently beats the date. When holding the promise exceeds your premium cap, the engine downgrades and says so on the order — it does not quietly ship late.' },
        { key: 'warn', text: 'When nothing can hit the date, the engine still decides: it takes the earliest arrival available and revises the promise instead of waiting on a person.' },
        { key: 'acc', text: 'Split shipments, hard facility capacity caps, and historical carrier performance are out of scope in this prototype — all three would change these numbers.' }
      ],
      rulesSummary, ruleChips,
      orderCount: results.length,
      facilityActiveNote: (E.FCS.length - rules.pausedFcs.length) + ' of ' + E.FCS.length + ' facilities active',
      serviceActiveNote: E.SERVICES.filter(s => rules.pausedServices.indexOf(s.id) < 0 && (rules.allowAir || s.mode !== 'air')).length + ' of ' + E.SERVICES.length + ' services enabled',
      queueCount: filtered.length === results.length ? results.length + ' orders' : filtered.length + ' of ' + results.length + ' orders',
      queueNote: 'tightest EDD first · ' + hits + ' on promise · ' + tolerated + ' late within rules · ' + needsReview + ' auto-adjusted' + (overCap ? ' · ' + overCap + ' over cost cap' : ''),
      queueFootnote: 'Every order is routed automatically from your rules — nothing waits on a person. Margin is slack against the promised date; up to ' + rules.lateTolerance + ' day(s) late routes as configured, and routes above ' + E.money(rules.costCeiling) + ' per parcel are reported here after the fact.',
      lastRun: new Date(state.runAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
      comboTabs,
      sel: selVals
    };
  }

  // ---------- renderers ----------
  function renderNavBtn(n) {
    return '<button class="nav-btn' + (n.active ? ' active' : '') + '" data-action="nav-item" data-view="' + esc(n.view) + '" data-section="' + esc(n.label) + '" data-filter="' + esc(n.filter) + '">'
      + '<span>' + esc(n.label) + '</span>'
      + '<span class="nav-badge' + (n.badge ? '' : ' hidden') + (n.warn ? ' warn' : '') + '">' + esc(n.badge) + '</span>'
      + '</button>';
  }
  function renderSidebar(v) {
    return '<aside class="sidebar">'
      + '<div class="sidebar-brand">'
      + '<div class="sidebar-logo">D</div>'
      + '<div class="sidebar-brand-text"><div class="sidebar-brand-name">Distribution</div><div class="sidebar-brand-sub">Northwind Goods</div></div>'
      + '</div>'
      + '<nav class="sidebar-nav">'
      + '<div class="sidebar-heading">Operate</div>' + v.navOperate.map(renderNavBtn).join('')
      + '<div class="sidebar-heading">Network</div>' + v.navNetwork.map(renderNavBtn).join('')
      + '<div class="sidebar-heading">Configure</div>' + v.navConfigure.map(renderNavBtn).join('')
      + '</nav>'
      + '<div class="sidebar-footer">'
      + '<div class="engine-card"><div class="engine-card-title">Engine v0.4 · shadow mode</div><div class="engine-card-note">' + esc(v.rulesSummary) + '</div></div>'
      + '<div class="user-row"><div class="user-avatar">MR</div><div class="user-info"><span class="user-name">Maya Rios</span><span class="user-role">Ops lead</span></div></div>'
      + '</div>'
      + '</aside>';
  }

  function renderTabs(v) {
    return '<div class="tabs">' + v.tabs.map(t =>
      '<button class="tab' + (t.active ? ' active' : '') + '" data-action="set-view" data-view="' + esc(t.view) + '">'
      + '<span>' + esc(t.label) + '</span><span class="tab-count">' + esc(t.count) + '</span></button>'
    ).join('') + '</div>';
  }
  function renderHeader(v) {
    return '<header class="topbar">'
      + '<div class="topbar-row">'
      + '<div class="crumb">'
      + '<span>' + esc(v.crumbSection) + '</span><span class="crumb-sep">/</span>'
      + '<span class="crumb-page' + (v.isDetail ? ' dim' : '') + '">' + esc(v.crumbPage) + '</span>'
      + (v.isDetail ? '<span class="crumb-sep">/</span><span class="crumb-id">' + esc(v.sel.id) + '</span>' : '')
      + '<span class="badge-shadow">Shadow</span>'
      + '</div>'
      + '<div class="topbar-actions">'
      + '<button class="btn-rules' + (v.view === 'rules' ? ' active' : '') + '" data-action="goto" data-view="rules" data-section="Routing rules">⚙ Routing rules</button>'
      + '<button class="btn-primary" data-action="rerun">Re-run engine</button>'
      + '</div>'
      + '</div>'
      + (v.showTabs ? renderTabs(v) : '')
      + '</header>';
  }

  function renderQueueRow(o) {
    return '<div class="queue-grid queue-row" data-action="open-order" data-id="' + esc(o.id) + '">'
      + '<div class="cell">'
      + '<div style="display:flex;align-items:center;gap:6px;min-width:0">'
      + '<span class="dot dot-' + o.dotKey + '"></span>'
      + '<span class="mono ellipsis" style="font-size:12px;font-weight:500">' + esc(o.id) + '</span>'
      + '</div>'
      + '<span class="ellipsis c-mute" style="font-size:10.5px;padding-left:11px">seq ' + o.seq + '</span>'
      + '</div>'
      + '<div class="cell"><span class="ellipsis" style="font-size:12.5px">' + esc(o.dest) + '</span><span class="ellipsis c-mute" style="font-size:10.5px">' + esc(o.zone) + '</span></div>'
      + '<div class="cell"><span class="ellipsis" style="font-size:12.5px">' + esc(o.skuName) + '</span><span class="mono ellipsis c-mute" style="font-size:10.5px">' + esc(o.sku) + '</span></div>'
      + '<div class="cell right">'
      + '<span class="mono ellipsis" style="font-size:11.5px"><span class="c-ink">' + esc(o.edd) + '</span><span class="c-faint"> → </span><span style="color:' + o.arriveColor + '">' + esc(o.arrive) + '</span></span>'
      + '<span class="mono ellipsis" style="font-size:10.5px;font-weight:500;color:' + o.arriveColor + '">' + esc(o.margin) + '</span>'
      + '</div>'
      + '<div class="cell"><span class="ellipsis" style="font-size:12.5px">' + esc(o.route) + '</span><span class="mono ellipsis c-mute" style="font-size:10.5px">' + esc(o.cost) + ' · ' + esc(o.routeMeta) + '</span></div>'
      + '<div class="cell right" style="align-items:flex-end">'
      + '<span style="font-size:11.5px;font-weight:600;line-height:1.3;color:var(--' + o.dotKey + ')">' + esc(o.status) + '</span>'
      + '<span style="font-size:10.5px;line-height:1.3;color:' + o.subColor + '">' + esc(o.subStatus) + '</span>'
      + '</div>'
      + '</div>';
  }
  function renderQueueView(v) {
    return '<main class="view">'
      + '<div class="page-head">'
      + '<div class="page-title-group"><h1 class="page-title">Batch queue</h1>'
      + '<div class="page-desc">Orders are processed tightest-promise-first, and inventory reservations carry across the batch so later orders see real stock. Open an order to see every facility × carrier service the engine evaluated.</div></div>'
      + '<div class="last-run mono">Last run ' + esc(v.lastRun) + '</div>'
      + '</div>'
      + '<button class="rules-strip" data-action="goto" data-view="rules" data-section="Routing rules">'
      + '<div class="rules-strip-left"><span class="rules-strip-label">Active rules</span>'
      + v.ruleChips.map(c => '<span class="rule-chip' + (c.on ? ' on' : '') + '">' + esc(c.label) + '</span>').join('')
      + '</div><span class="rules-strip-cta">Configure rules →</span>'
      + '</button>'
      + '<section class="card card-section">'
      + '<div class="card-head">'
      + '<div style="display:flex;align-items:baseline;gap:9px"><span class="card-head-title">' + esc(v.queueCount) + '</span><span class="card-head-note">' + esc(v.queueNote) + '</span></div>'
      + '<div class="queue-toolbar">'
      + '<input class="search-input" data-search value="' + esc(v.query) + '" placeholder="Search order, city, SKU" />'
      + '<div class="segmented">' + ['All', 'On promise', 'Auto-adjusted', 'Over cost cap'].map(f =>
        '<button class="seg-btn' + (v.filter === f ? ' active' : '') + '" data-action="set-filter" data-filter="' + esc(f) + '">' + esc(f) + '</button>'
      ).join('') + '</div>'
      + '</div>'
      + '</div>'
      + '<div>'
      + '<div class="queue-grid queue-head"><div>Order</div><div>Destination</div><div>Item</div><div class="right">EDD → est.</div><div>Route</div><div class="right">Status</div></div>'
      + v.orders.map(renderQueueRow).join('')
      + (v.orders.length === 0 ? '<div class="empty-state">No orders match this filter.</div>' : '')
      + '</div>'
      + '<div class="card-foot">' + esc(v.queueFootnote) + '</div>'
      + '</section>'
      + '</main>';
  }

  function renderComboRow(c) {
    return '<div class="eval-grid eval-row' + (c.selected ? ' selected' : '') + (c.faded ? ' faded' : '') + '">'
      + '<div class="cell"><span class="ellipsis" style="font-size:12.5px;font-weight:500">' + esc(c.fcName) + '</span><span class="mono c-mute" style="font-size:10px">' + esc(c.fcMeta) + '</span></div>'
      + '<div class="cell"><span class="ellipsis" style="font-size:12.5px;color:var(--ink)">' + esc(c.carrier) + '</span><span class="mono c-mute" style="font-size:10px">' + esc(c.service) + '</span></div>'
      + '<div class="mono right c-ink4" style="font-size:12px">' + esc(c.miles) + '</div>'
      + '<div class="mono right" style="font-size:12px;color:' + (c.stockOk ? 'var(--ink-3)' : 'var(--bad)') + '">' + c.stock + '</div>'
      + '<div class="mono right c-ink4" style="font-size:12px">' + esc(c.transit) + '</div>'
      + '<div class="mono right" style="font-size:12px;color:' + (c.onTime ? 'var(--ink-3)' : 'var(--warn)') + '">' + esc(c.arrive) + '</div>'
      + '<div class="mono right" style="font-size:12px;font-weight:500">' + esc(c.cost) + '</div>'
      + '<div><span class="chip chip-' + c.verdictKey + '">' + esc(c.verdict) + '</span></div>'
      + '</div>';
  }
  function renderDetailView(v) {
    const s = v.sel;
    return '<main class="view">'
      + '<button class="btn-ghost" style="align-self:flex-start" data-action="set-view" data-view="queue">‹ Back to batch queue</button>'
      + '<div class="detail-head">'
      + '<div class="detail-title-group"><div class="detail-title-row"><h1 class="detail-id">' + esc(s.id) + '</h1><span class="chip chip-' + s.statusKey + '">' + esc(s.status) + '</span></div>'
      + '<div class="detail-summary">' + esc(s.summaryLine) + '</div></div>'
      + '<div class="detail-nav"><button class="btn-ghost" data-action="prev-order">‹ Prev</button><button class="btn-ghost" data-action="next-order">Next ›</button></div>'
      + '</div>'
      + '<div class="detail-grid">'
      + '<section class="card detail-card">'
      + '<div class="quad-grid">'
      + '<div class="quad"><span class="quad-label">Destination</span><span class="quad-value">' + esc(s.dest) + '</span></div>'
      + '<div class="quad"><span class="quad-label">Item</span><span class="quad-value">' + esc(s.skuShort) + '</span></div>'
      + '<div class="quad"><span class="quad-label">Promised EDD</span><span class="quad-value mono">' + esc(s.eddLabel) + '</span></div>'
      + '<div class="quad"><span class="quad-label">Projected arrival</span><span class="quad-value mono" style="color:var(--' + s.statusKey + ')">' + esc(s.arrive) + '</span></div>'
      + '</div>'
      + '<div class="route-card" style="border:1px solid color-mix(in oklch, var(--' + s.statusKey + ') 40%, transparent);border-left:3px solid var(--' + s.statusKey + ');background:color-mix(in oklch, var(--' + s.statusKey + ') 4%, transparent)">'
      + '<div class="route-card-top">'
      + '<div style="min-width:0">'
      + '<div class="route-verdict" style="color:var(--' + s.statusKey + ')">' + esc(s.verdictLabel) + '</div>'
      + '<div class="route-title">' + esc(s.routeTitle) + '</div>'
      + '<div class="route-meta mono">' + esc(s.routeMeta) + '</div>'
      + '</div>'
      + '<div class="route-stats">'
      + '<div class="route-stat"><span class="route-stat-label">Margin</span><span class="route-stat-value mono" style="color:var(--' + s.statusKey + ')">' + esc(s.margin) + '</span></div>'
      + '<div class="route-stat"><span class="route-stat-label">Ship cost</span><span class="route-stat-value mono">' + esc(s.cost) + '</span></div>'
      + '<div class="route-stat"><span class="route-stat-label">Promise premium</span><span class="route-stat-value mono">' + esc(s.premium) + '</span></div>'
      + '</div>'
      + '</div>'
      + '</div>'
      + '<div><div class="funnel-label">Gate sequence</div><div class="funnel-grid">'
      + s.funnel.map(g => '<div class="funnel-card"><div class="funnel-top"><span class="funnel-name">' + esc(g.label) + '</span><span class="funnel-count mono" style="color:' + g.color + '">' + g.count + '</span></div>'
        + '<div class="bar-track"><div class="bar-fill" style="width:' + g.pctv + ';background:' + g.color + '"></div></div></div>').join('')
      + '</div></div>'
      + '</section>'
      + '<section class="card card-section">'
      + '<div class="card-head" style="border-bottom:1px solid var(--border-2)"><span class="card-head-title">Routing rules</span></div>'
      + '<div class="reasons">' + s.reasons.map(r =>
        '<div class="reason" style="border-left-color:var(--' + r.key + ')"><span class="reason-tag mono" style="color:var(--' + r.key + ')">' + esc(r.tag) + '</span><span class="reason-text">' + esc(r.text) + '</span></div>'
      ).join('') + '</div>'
      + '</section>'
      + '</div>'
      + '<section class="card card-section">'
      + '<div class="card-head">'
      + '<div style="display:flex;align-items:baseline;gap:9px"><span class="card-head-title">Route evaluation</span><span class="card-head-note">' + esc(s.comboNote) + '</span></div>'
      + '<div class="segmented">' + v.comboTabs.map(t => '<button class="seg-btn' + (t.active ? ' active' : '') + '" data-action="set-combo-tab" data-tab="' + esc(t.label) + '">' + esc(t.label) + '</button>').join('') + '</div>'
      + '</div>'
      + '<div class="eval-table-wrap"><div class="eval-table-inner">'
      + '<div class="eval-grid eval-head"><div>Fulfillment center</div><div>Carrier service</div><div class="right">Miles</div><div class="right">Stock</div><div class="right">Transit</div><div class="right">Arrives</div><div class="right">Cost</div><div>Evaluation</div></div>'
      + s.combos.map(renderComboRow).join('')
      + '</div></div>'
      + '<div class="card-foot">Prototype models: transit is <span class="mono">miles ÷ service speed</span> plus a one-day handling penalty at facilities over your load threshold (marked *); cost is a per-service base fee plus a per-mile rate. Illustrative, not contracted rates.</div>'
      + '</section>'
      + '</main>';
  }

  function renderMetricsView(v) {
    return '<main class="view">'
      + '<div class="page-head"><div class="page-title-group"><h1 class="page-title">Metrics</h1><div class="page-desc">EDD hit rate is the gating metric for this engine. Cost is tracked beside it, never above it.</div></div><div class="last-run mono">Last run ' + esc(v.lastRun) + '</div></div>'
      + '<div class="kpi-grid">' + v.kpis.map(k =>
        '<div class="card kpi-card"><div class="kpi-label">' + esc(k.label) + '</div>'
        + '<div class="kpi-value-row"><span class="kpi-value" style="color:' + k.colorVar + '">' + esc(k.value) + '</span><span class="kpi-unit">' + esc(k.unit) + '</span></div>'
        + '<div class="kpi-note">' + esc(k.note) + '</div></div>'
      ).join('') + '</div>'
      + '<div class="two-col">'
      + '<section class="card card-section"><div class="card-head"><span class="card-head-title">Where routes are lost</span><span class="card-head-note">across all ' + v.orderCount + ' orders</span></div>'
      + '<div class="bars">' + v.gateTotals.map(g =>
        '<div class="bar-row"><div class="bar-top"><span class="bar-top-label">' + esc(g.label) + '</span><span class="bar-top-value">' + esc(g.value) + '</span></div>'
        + '<div class="bar-track-lg"><div class="bar-fill-lg" style="width:' + g.pctv + ';background:var(--' + g.key + ')"></div></div>'
        + '<div class="bar-note">' + esc(g.note) + '</div></div>'
      ).join('') + '</div></section>'
      + '<section class="card card-section"><div class="card-head"><span class="card-head-title">Carrier mix this batch</span><span class="card-head-note">assigned routes</span></div>'
      + '<div class="bars">' + v.carrierMix.map(m =>
        '<div class="bar-row"><div class="bar-top"><span class="bar-top-label">' + esc(m.label) + '</span><span class="bar-top-value">' + esc(m.value) + '</span></div>'
        + '<div class="bar-track-lg"><div class="bar-fill-lg" style="width:' + m.pctv + ';background:' + m.color + '"></div></div></div>'
      ).join('') + '</div></section>'
      + '</div>'
      + '<section class="card card-section"><div class="card-head"><span class="card-head-title">Reservation ledger</span><span class="card-head-note">in processing order</span></div>'
      + v.ledger.map(l =>
        '<div class="ledger-row"><span class="ledger-seq mono">' + l.seq + '</span><span class="ledger-id mono">' + esc(l.id) + '</span>'
        + '<span class="ledger-text">' + esc(l.text) + '</span><span class="chip chip-' + l.key + '">' + esc(l.tag) + '</span></div>'
      ).join('') + '</section>'
      + '</main>';
  }

  function renderInventoryView(v) {
    return '<main class="view">'
      + '<div class="page-title-group"><h1 class="page-title">Inventory</h1><div class="page-desc">Positions after this batch\'s reservations. A zero here is what eliminates a facility at the stock gate, no matter how close it sits to the shopper.</div></div>'
      + '<section class="card card-section"><div class="inv-table-wrap"><div class="inv-table-inner">'
      + '<div class="inv-grid inv-head"><div>Facility</div><div class="right">Skillet · 1042</div><div class="right">Throw · 2110</div><div class="right">Mug set · 3301</div><div class="right">Load</div></div>'
      + v.inventory.map(r =>
        '<div class="inv-grid inv-row">'
        + '<div class="cell"><span style="font-size:12.5px;font-weight:500">' + esc(r.fc) + '</span><span class="mono c-mute" style="font-size:10px">' + esc(r.code) + '</span></div>'
        + '<div class="right mono" style="font-size:12.5px;color:' + r.c1 + '">' + esc(r.d1) + '</div>'
        + '<div class="right mono" style="font-size:12.5px;color:' + r.c2 + '">' + esc(r.d2) + '</div>'
        + '<div class="right mono" style="font-size:12.5px;color:' + r.c3 + '">' + esc(r.d3) + '</div>'
        + '<div style="display:flex;justify-content:flex-end"><span class="chip chip-' + r.loadKey + '">' + esc(r.load) + '</span></div>'
        + '</div>'
      ).join('')
      + '</div></div>'
      + '<div class="card-foot">Shown as on-hand after reservations, with units claimed by this batch in parentheses.</div>'
      + '</section>'
      + '</main>';
  }

  function renderFacilitiesView(v) {
    return '<main class="view">'
      + '<div class="page-head"><div class="page-title-group"><h1 class="page-title">Facilities</h1><div class="page-desc wide">Five fulfillment centers, each with its own carrier coverage, cutoff, and current load. Pausing a facility takes it and all of its carrier services out of routing on the next run.</div></div>'
      + '<div style="font-size:12px;color:var(--mute);white-space:nowrap">' + esc(v.facilityActiveNote) + '</div></div>'
      + '<div class="card-grid">' + v.facilities.map(f =>
        '<section class="card fc-card' + (f.paused ? ' paused' : '') + '">'
        + '<div class="fc-top"><div style="min-width:0"><div class="fc-name-row"><span class="fc-name">' + esc(f.name) + '</span><span class="fc-code mono">' + esc(f.code) + '</span></div><span class="fc-meta">' + esc(f.meta) + '</span></div>'
        + '<button class="pill-toggle ' + (f.paused ? 'off' : 'on') + '" data-action="toggle-fc" data-fc="' + esc(f.code) + '">' + (f.paused ? 'Paused' : 'Active') + '</button></div>'
        + '<div class="load-block"><div class="load-top"><span class="load-label">Current load</span><span class="load-value" style="color:var(--' + (f.hot ? 'warn' : 'ok') + ')">' + esc(f.load) + '</span></div>'
        + '<div class="bar-track-lg"><div class="bar-fill-lg" style="width:' + f.load + ';background:var(--' + (f.hot ? 'warn' : 'ok') + ')"></div></div>'
        + '<div class="load-note">' + esc(f.loadNote) + '</div></div>'
        + '<div class="stock-grid">' + f.stock.map(s => '<div class="stock-tile"><span class="stock-label">' + esc(s.label) + '</span><span class="stock-value" style="color:' + s.color + '">' + s.value + '</span></div>').join('') + '</div>'
        + '<div><span class="coverage-label">Carrier coverage</span><div class="coverage-chips">' + f.carriers.map(c => '<span class="coverage-chip' + (c.live ? '' : ' off') + '">' + esc(c.label) + '</span>').join('') + '</div></div>'
        + '<div class="fc-usage"><span class="fc-usage-label">This batch</span><span class="fc-usage-value" style="color:' + f.usageColor + '">' + esc(f.usage) + '</span></div>'
        + '</section>'
      ).join('') + '</div>'
      + '</main>';
  }

  function renderCarriersView(v) {
    return '<main class="view">'
      + '<div class="page-head"><div class="page-title-group"><h1 class="page-title">Carriers</h1><div class="page-desc wide">Four carriers and the services you hold with them. Turn a service off and the engine stops considering it everywhere — the route table on the next run will show the remaining options only.</div></div>'
      + '<div style="font-size:12px;color:var(--mute);white-space:nowrap">' + esc(v.serviceActiveNote) + '</div></div>'
      + '<div class="carrier-grid">' + v.carriers.map(c =>
        '<section class="card card-section">'
        + '<div class="carrier-card-head"><div style="min-width:0"><div class="fc-name-row"><span class="fc-name">' + esc(c.name) + '</span><span class="fc-code mono">' + esc(c.code) + '</span></div><span class="fc-meta">' + esc(c.meta) + '</span></div>'
        + '<span class="chip chip-' + c.usageKey + '">' + esc(c.usage) + '</span></div>'
        + '<div class="svc-table-wrap"><div class="svc-table-inner">'
        + '<div class="svc-grid svc-head"><div>Service</div><div class="right">Mi / day</div><div class="right">Base + rate</div><div class="right">Used</div><div class="right">Status</div></div>'
        + c.services.map(s =>
          '<div class="svc-grid svc-row' + (s.off ? ' off' : '') + '">'
          + '<div class="cell"><span class="svc-name">' + esc(s.name) + '</span><span class="svc-note">' + esc(s.note) + '</span></div>'
          + '<div class="right mono c-ink3" style="font-size:12px">' + esc(s.speed) + '</div>'
          + '<div class="right mono c-ink3" style="font-size:12px">' + esc(s.rate) + '</div>'
          + '<div class="right mono c-ink4" style="font-size:12px">' + esc(s.used) + '</div>'
          + '<div style="display:flex;justify-content:flex-end"><button class="svc-toggle ' + (s.off ? 'off' : 'on') + (s.blocked ? ' blocked' : '') + '" data-action="toggle-service" data-svc="' + esc(s.id) + '" data-blocked="' + (s.blocked ? '1' : '0') + '">' + (s.off ? 'Off' : 'On') + '</button></div>'
          + '</div>'
        ).join('')
        + '</div></div>'
        + '<div class="card-foot">Facilities: ' + esc(c.coverage) + '</div>'
        + '</section>'
      ).join('') + '</div>'
      + '</main>';
  }

  function renderRulesView(v) {
    return '<main class="view">'
      + '<div class="page-head"><div class="page-title-group"><h1 class="page-title">Routing rules</h1><div class="page-desc wide">Your preferences, applied to every order in the batch. Changes take effect immediately and the impact panel shows what they did to this batch.</div></div>'
      + '<div style="display:flex;gap:8px"><button class="btn-ghost" data-action="reset-rules">Reset to defaults</button><button class="btn-primary" data-action="goto" data-view="queue" data-section="Orders">See the batch →</button></div></div>'
      + '<div class="rules-layout">'
      + '<div class="rules-main">'
      + '<section class="card card-section"><div class="section-head"><span class="section-head-title">Primary objective</span><span class="section-head-note">What the engine optimizes first. The other becomes the tiebreak.</span></div>'
      + '<div class="objectives">' + v.objectives.map(ob =>
        '<button class="objective-btn' + (ob.active ? ' active' : '') + '" data-action="set-objective" data-obj="' + esc(ob.id) + '">'
        + '<span class="objective-dot' + (ob.active ? ' active' : '') + '"></span>'
        + '<span class="objective-text"><span class="objective-label">' + esc(ob.label) + '</span><span class="objective-note">' + esc(ob.note) + '</span></span>'
        + '</button>'
      ).join('') + '</div></section>'
      + '<section class="card card-section"><div class="section-head"><span class="section-head-title">Thresholds</span><span class="section-head-note">The limits the engine decides inside. It always picks a route — these set which one.</span></div>'
      + '<div class="sliders">' + v.sliders.map(s =>
        '<div class="slider-row">'
        + '<div class="slider-top"><span class="slider-label">' + esc(s.label) + '</span><span class="slider-value mono" data-slider-label="' + esc(s.field) + '">' + esc(s.display) + '</span></div>'
        + '<input type="range" min="' + s.min + '" max="' + s.max + '" step="' + s.step + '" value="' + s.value + '" data-slider data-field="' + esc(s.field) + '" />'
        + '<div class="slider-note">' + esc(s.note) + '</div>'
        + '</div>'
      ).join('') + '</div></section>'
      + '<section class="card card-section"><div class="section-head"><span class="section-head-title">Constraints</span><span class="section-head-note">Blunt on/off rules applied before any scoring.</span></div>'
      + '<div class="toggles">' + v.toggles.map(t =>
        '<div class="toggle-row"><div style="min-width:0"><div class="toggle-label">' + esc(t.label) + '</div><div class="toggle-note">' + esc(t.note) + '</div></div>'
        + '<button class="pill ' + (t.on ? 'on' : 'off') + '" data-action="' + esc(t.action) + '"'
        + (t.view ? ' data-view="' + esc(t.view) + '"' : '') + (t.section ? ' data-section="' + esc(t.section) + '"' : '') + '>' + esc(t.value) + '</button></div>'
      ).join('') + '</div></section>'
      + '</div>'
      + '<div class="rules-side">'
      + '<section class="card card-section"><div class="section-head"><span class="section-head-title">Impact on this batch</span><span class="section-head-note">Current rules vs. defaults</span></div>'
      + '<div class="impact">' + v.impact.map(i =>
        '<div class="impact-row"><div style="min-width:0"><div class="impact-label">' + esc(i.label) + '</div><div class="impact-base">default ' + esc(i.base) + '</div></div>'
        + '<div style="display:flex;align-items:baseline;gap:7px;flex-shrink:0"><span class="impact-value">' + esc(i.value) + '</span><span class="impact-delta" style="color:' + i.deltaColor + '">' + esc(i.delta) + '</span></div></div>'
      ).join('') + '</div></section>'
      + '<section class="card card-section"><div class="section-head" style="border-bottom:1px solid var(--border-2)"><span class="section-head-title">What these rules guarantee</span></div>'
      + '<div class="rule-notes">' + v.ruleNotes.map(n =>
        '<div class="rule-note"><span class="rule-note-dot" style="background:var(--' + n.key + ')"></span><span class="rule-note-text">' + esc(n.text) + '</span></div>'
      ).join('') + '</div></section>'
      + '</div>'
      + '</div>'
      + '</main>';
  }

  function renderMain(v) {
    if (v.isQueue) return renderQueueView(v);
    if (v.isDetail) return renderDetailView(v);
    if (v.isMetrics) return renderMetricsView(v);
    if (v.isInventory) return renderInventoryView(v);
    if (v.isFacilities) return renderFacilitiesView(v);
    if (v.isCarriers) return renderCarriersView(v);
    if (v.isRules) return renderRulesView(v);
    return '';
  }
  function render() {
    const v = deriveView(state);
    $app.innerHTML = '<div class="shell">' + renderSidebar(v) + '<div class="main-col">' + renderHeader(v) + renderMain(v) + '</div></div>';
  }

  // ---------- events ----------
  function onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a === 'nav-item') { setState({ view: el.dataset.view, section: el.dataset.section, filter: el.dataset.filter }); return; }
    if (a === 'goto') { setState({ view: el.dataset.view, section: el.dataset.section }); return; }
    if (a === 'set-view') { setState({ view: el.dataset.view }); return; }
    if (a === 'rerun') { setState({ runAt: Date.now() }); return; }
    if (a === 'open-order') { setState({ selected: el.dataset.id, view: 'detail' }); return; }
    if (a === 'prev-order') { step(-1); return; }
    if (a === 'next-order') { step(1); return; }
    if (a === 'set-filter') { setState({ filter: el.dataset.filter }); return; }
    if (a === 'set-combo-tab') { setState({ tab: el.dataset.tab }); return; }
    if (a === 'toggle-fc') {
      const id = el.dataset.fc, list = state.rules.pausedFcs, on = list.indexOf(id) >= 0;
      setRule({ pausedFcs: on ? list.filter(x => x !== id) : list.concat([id]) });
      return;
    }
    if (a === 'toggle-service') {
      if (el.dataset.blocked === '1') return;
      const id = el.dataset.svc, list = state.rules.pausedServices, on = list.indexOf(id) >= 0;
      setRule({ pausedServices: on ? list.filter(x => x !== id) : list.concat([id]) });
      return;
    }
    if (a === 'toggle-air') { setRule({ allowAir: !state.rules.allowAir }); return; }
    if (a === 'set-objective') { setRule({ objective: el.dataset.obj }); return; }
    if (a === 'reset-rules') {
      const rules = Object.assign({}, E.DEFAULTS);
      state = Object.assign({}, state, { rules });
      E.saveRules(rules);
      render();
      return;
    }
  }
  function onInput(e) {
    const t = e.target;
    if (t.matches && t.matches('[data-search]')) {
      const selStart = t.selectionStart, selEnd = t.selectionEnd;
      state = Object.assign({}, state, { query: t.value });
      render();
      const el = $app.querySelector('[data-search]');
      if (el) {
        el.focus();
        try { el.setSelectionRange(selStart, selEnd); } catch (err) { /* ignore */ }
      }
      return;
    }
    if (t.matches && t.matches('[data-slider]')) {
      const field = t.dataset.field, value = Number(t.value);
      state.rules = Object.assign({}, state.rules, { [field]: value });
      E.saveRules(state.rules);
      const label = $app.querySelector('[data-slider-label="' + field + '"]');
      if (label) label.textContent = sliderDisplayFor(field, value);
      return;
    }
  }
  function onChange(e) {
    const t = e.target;
    if (t.matches && t.matches('[data-slider]')) render();
  }

  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  render();
})();
