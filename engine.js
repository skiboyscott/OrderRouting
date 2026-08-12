// Order routing engine — data model and pure business logic.
// Ported from the Order Routing Engine.dc.html prototype: haversine distances,
// a three-gate pipeline (stock -> promise -> cost), tightest-EDD-first batch
// processing with inventory reservations carrying across the batch, and a
// rules-driven route picker (promise-first vs. cost-first objectives).
(function (global) {
  'use strict';

  const FCS = [
    { id: 'CHI', name: 'Chicago', region: 'IL', lat: 41.85, lon: -87.65, load: 0.86, cutoff: '17:00 CT', carriers: ['PF', 'NL', 'CP'] },
    { id: 'NJ', name: 'New Jersey', region: 'NJ', lat: 40.06, lon: -74.72, load: 0.42, cutoff: '19:00 ET', carriers: ['PF', 'NL', 'SB'] },
    { id: 'LAX', name: 'Los Angeles', region: 'CA', lat: 33.94, lon: -118.41, load: 0.61, cutoff: '16:00 PT', carriers: ['NL', 'CP', 'SB'] },
    { id: 'DFW', name: 'Dallas', region: 'TX', lat: 32.78, lon: -96.8, load: 0.55, cutoff: '18:00 CT', carriers: ['PF', 'CP', 'SB'] },
    { id: 'ATL', name: 'Atlanta', region: 'GA', lat: 33.75, lon: -84.39, load: 0.73, cutoff: '18:30 ET', carriers: ['PF', 'NL', 'CP'] }
  ];

  const CARRIERS = [
    {
      code: 'PF', name: 'Pace Freight', meta: 'National parcel · contracted through Mar 2027',
      services: [
        { id: 'PF-GRD', name: 'Ground', mode: 'ground', milesPerDay: 500, base: 6.5, perMi: 0.011, note: 'Standard parcel, no guarantee' },
        { id: 'PF-EXG', name: 'Expedited ground', mode: 'expedited', milesPerDay: 720, base: 9.5, perMi: 0.015, note: 'Priority linehaul, day-definite' }
      ]
    },
    {
      code: 'NL', name: 'Northline', meta: 'Regional + air · strongest East lanes',
      services: [
        { id: 'NL-GRD', name: 'Ground', mode: 'ground', milesPerDay: 480, base: 5.9, perMi: 0.010, note: 'Cheapest ground in the network' },
        { id: 'NL-EXG', name: 'Expedited ground', mode: 'expedited', milesPerDay: 740, base: 9.9, perMi: 0.014, note: 'Day-definite to zone 6' },
        { id: 'NL-AIR', name: 'Air', mode: 'air', milesPerDay: 1400, base: 22.0, perMi: 0.028, note: 'Next-flight-out, offshore capable' }
      ]
    },
    {
      code: 'CP', name: 'Cardinal Post', meta: 'Value ground · residential specialist',
      services: [
        { id: 'CP-GRD', name: 'Ground', mode: 'ground', milesPerDay: 450, base: 5.4, perMi: 0.009, note: 'Slowest, lowest cost per mile' },
        { id: 'CP-AIR', name: 'Air', mode: 'air', milesPerDay: 1300, base: 19.5, perMi: 0.026, note: 'Deferred air, 2-day domestic' }
      ]
    },
    {
      code: 'SB', name: 'Skybridge', meta: 'Premium speed · no economy tier',
      services: [
        { id: 'SB-EXG', name: 'Expedited ground', mode: 'expedited', milesPerDay: 760, base: 11.0, perMi: 0.016, note: 'Guaranteed day-definite' },
        { id: 'SB-AIR', name: 'Air', mode: 'air', milesPerDay: 1600, base: 26.0, perMi: 0.031, note: 'Fastest lane in the network' }
      ]
    }
  ];
  const SERVICES = [];
  CARRIERS.forEach(c => c.services.forEach(s => SERVICES.push(Object.assign({}, s, { carrier: c.name, carrierCode: c.code }))));

  const SKUS = { 'SKU-1042': 'Cast-iron skillet', 'SKU-2110': 'Wool throw blanket', 'SKU-3301': 'Ceramic mug set' };
  const SHORT = { 'SKU-1042': 'Skillet 10"', 'SKU-2110': 'Wool throw', 'SKU-3301': 'Mug set (4)' };
  const INV0 = {
    CHI: { 'SKU-1042': 20, 'SKU-2110': 0, 'SKU-3301': 1 },
    NJ: { 'SKU-1042': 15, 'SKU-2110': 9, 'SKU-3301': 0 },
    LAX: { 'SKU-1042': 0, 'SKU-2110': 6, 'SKU-3301': 1 },
    DFW: { 'SKU-1042': 12, 'SKU-2110': 4, 'SKU-3301': 0 },
    ATL: { 'SKU-1042': 8, 'SKU-2110': 0, 'SKU-3301': 0 }
  };
  const ORDERS = [
    { id: 'O-1001', city: 'Austin, TX', zone: 'Zone 4 · residential', lat: 30.27, lon: -97.74, sku: 'SKU-1042', qty: 1, eddDays: 4 },
    { id: 'O-1002', city: 'Milwaukee, WI', zone: 'Zone 3 · residential', lat: 43.04, lon: -87.91, sku: 'SKU-2110', qty: 1, eddDays: 5 },
    { id: 'O-1003', city: 'Pasadena, CA', zone: 'Zone 2 · residential', lat: 34.15, lon: -118.14, sku: 'SKU-3301', qty: 1, eddDays: 3 },
    { id: 'O-1004', city: 'Denver, CO', zone: 'Zone 5 · commercial', lat: 39.74, lon: -104.99, sku: 'SKU-3301', qty: 1, eddDays: 6 },
    { id: 'O-1005', city: 'Honolulu, HI', zone: 'Zone 8 · offshore', lat: 21.31, lon: -157.86, sku: 'SKU-1042', qty: 1, eddDays: 2 }
  ];

  const TODAY = new Date(2026, 7, 12);
  const DEFAULTS = { objective: 'promise', lateTolerance: 0, maxPremium: 12, costCeiling: 40, loadThreshold: 80, allowAir: true, pausedFcs: [], pausedServices: [] };
  const STORE = 'odm.rules.v2';

  function miles(a, b) {
    const R = 3959, t = Math.PI / 180;
    const dLat = (b.lat - a.lat) * t, dLon = (b.lon - a.lon) * t;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }
  function fmtDate(d) { return new Date(TODAY.getTime() + d * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  function fmtShort(d) {
    const x = new Date(TODAY.getTime() + d * 86400000);
    return (x.getMonth() + 1) + '/' + x.getDate();
  }
  function money(n) { return '$' + n.toFixed(2); }

  function loadRules() {
    try {
      const raw = global.localStorage.getItem(STORE);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) { /* first run */ }
    return Object.assign({}, DEFAULTS);
  }
  function saveRules(rules) {
    try { global.localStorage.setItem(STORE, JSON.stringify(rules)); } catch (e) { /* ignore */ }
  }

  function runEngine(rules) {
    const inv = {};
    FCS.forEach(f => { inv[f.id] = Object.assign({}, INV0[f.id]); });
    const claims = {};
    const seq = ORDERS.slice().sort((a, b) => a.eddDays - b.eddDays || a.id.localeCompare(b.id));
    const results = [];
    const activeFcs = FCS.filter(f => rules.pausedFcs.indexOf(f.id) < 0);

    seq.forEach((o, i) => {
      const combos = [];
      activeFcs.forEach(fc => {
        const mi = miles(fc, o);
        const stock = inv[fc.id][o.sku] || 0;
        SERVICES.filter(s => fc.carriers.indexOf(s.carrierCode) >= 0)
          .filter(s => rules.pausedServices.indexOf(s.id) < 0)
          .filter(s => rules.allowAir || s.mode !== 'air')
          .forEach(s => {
            const penalty = fc.load * 100 > rules.loadThreshold ? 1 : 0;
            const transit = Math.ceil(mi / s.milesPerDay) + penalty;
            combos.push({
              key: fc.id + '/' + s.id, fc, svc: s, mi, stock, penalty, transit,
              cost: s.base + s.perMi * mi, hasStock: stock >= o.qty,
              onTime: transit <= o.eddDays, lateBy: Math.max(0, transit - o.eddDays)
            });
          });
      });
      combos.sort((a, b) => a.mi - b.mi || a.cost - b.cost);
      const stockPass = combos.filter(c => c.hasStock);
      const promisePass = stockPass.filter(c => c.onTime);
      const tolerancePass = stockPass.filter(c => c.lateBy <= rules.lateTolerance);
      const cheapestStock = stockPass.slice().sort((a, b) => a.cost - b.cost)[0] || null;

      let pool = [], pick = null, flags = [];
      if (stockPass.length) {
        if (rules.objective === 'cost') {
          pool = (tolerancePass.length ? tolerancePass : stockPass).slice()
            .sort((a, b) => a.cost - b.cost || a.transit - b.transit);
          if (!tolerancePass.length) pool = stockPass.slice().sort((a, b) => a.transit - b.transit || a.cost - b.cost);
        } else if (promisePass.length) {
          pool = promisePass.slice().sort((a, b) => a.cost - b.cost);
          const premium = pool[0].cost - cheapestStock.cost;
          if (premium > rules.maxPremium) {
            const fallback = tolerancePass.slice().sort((a, b) => a.cost - b.cost)[0];
            if (fallback && fallback.cost < pool[0].cost) {
              pool = tolerancePass.slice().sort((a, b) => a.cost - b.cost);
              flags.push('premium-capped');
            }
          }
        } else if (tolerancePass.length) {
          pool = tolerancePass.slice().sort((a, b) => a.cost - b.cost);
        } else {
          pool = stockPass.slice().sort((a, b) => a.transit - b.transit || a.cost - b.cost);
        }
        pick = pool[0];
      }

      let mode = 'no-stock';
      if (pick) {
        if (pick.onTime) mode = 'ok';
        else if (pick.lateBy <= rules.lateTolerance) mode = 'tolerated';
        else mode = 'late';
        if (pick.cost > rules.costCeiling) flags.push('over-ceiling');
      }
      if (pick) {
        inv[pick.fc.id][o.sku] = (inv[pick.fc.id][o.sku] || 0) - o.qty;
        if ((inv[pick.fc.id][o.sku] || 0) === 0) claims[pick.fc.id + '|' + o.sku] = o.id;
      }
      results.push({
        order: o, rank: i + 1, combos, stockPass, promisePass, tolerancePass, cheapestStock,
        pick, runnerUp: pool[1] || null, mode, flags, claimsSnapshot: Object.assign({}, claims)
      });
    });
    return { results, inv };
  }

  function statusOf(r) {
    if (r.mode === 'ok') return { label: 'On promise', key: 'ok' };
    if (r.mode === 'tolerated') return { label: 'Late, allowed', key: 'warn' };
    if (r.mode === 'late') return { label: 'Best available', key: 'warn' };
    return { label: 'Held for stock', key: 'bad' };
  }

  function reasonsFor(r, rules) {
    const o = r.order, out = [];
    const nearest = r.combos[0];
    if (nearest && !nearest.hasStock) {
      const by = r.claimsSnapshot[nearest.fc.id + '|' + o.sku];
      const who = by && by !== o.id ? ' Its last unit was reserved earlier in this batch by ' + by + ', which held the tighter promise.' : '';
      out.push({ tag: 'Stock', key: 'bad', text: nearest.fc.name + ' is the closest facility at ' + nearest.mi.toLocaleString() + ' mi but holds 0 units of ' + o.sku + ', so every carrier service out of it is eliminated at the stock gate.' + who });
    }
    if (r.pick && r.cheapestStock && !r.cheapestStock.onTime && r.cheapestStock.key !== r.pick.key) {
      out.push({ tag: 'Promise', key: 'warn', text: r.cheapestStock.fc.name + ' via ' + r.cheapestStock.svc.carrier + ' ' + r.cheapestStock.svc.name.toLowerCase() + ' is the cheapest route with stock at ' + money(r.cheapestStock.cost) + ', but lands ' + r.cheapestStock.lateBy + 'd past the promise. Holding the date costs ' + money(r.pick.cost - r.cheapestStock.cost) + ' more.' });
    }
    if (r.pick && r.runnerUp) {
      out.push({ tag: 'Cost', key: 'acc', text: 'Among routes that cleared your rules, ' + r.pick.fc.name + ' via ' + r.pick.svc.carrier + ' ' + r.pick.svc.name.toLowerCase() + ' at ' + money(r.pick.cost) + ' beat the runner-up (' + r.runnerUp.fc.name + ' · ' + r.runnerUp.svc.carrier + ' ' + r.runnerUp.svc.name.toLowerCase() + ', ' + money(r.runnerUp.cost) + ') by ' + money(Math.abs(r.runnerUp.cost - r.pick.cost)) + '.' });
    }
    if (r.flags.indexOf('premium-capped') >= 0) {
      out.push({ tag: 'Rule', key: 'warn', text: 'Protecting the date would have cost more than your ' + money(rules.maxPremium) + ' premium cap, so the engine took a cheaper route inside your ' + rules.lateTolerance + '-day late tolerance instead. Raise the cap to buy the date back.' });
    }
    if (r.flags.indexOf('over-ceiling') >= 0) {
      out.push({ tag: 'Rule', key: 'warn', text: 'Selected route costs ' + money(r.pick.cost) + ', over your ' + money(rules.costCeiling) + ' per-parcel ceiling. Your rules put the date first, so it ships and the overage is reported here.' });
    }
    if (r.mode === 'tolerated') {
      out.push({ tag: 'Rule', key: 'warn', text: 'Arrives ' + r.pick.lateBy + 'd late, inside the ' + rules.lateTolerance + '-day tolerance you set, so the engine routes it as configured. Set tolerance to none and it would buy the date instead.' });
    }
    if (r.mode === 'late') {
      out.push({ tag: 'Decision', key: 'warn', text: 'No combination can hit ' + fmtDate(o.eddDays) + '. The engine automatically took the earliest-arriving route with stock — ' + r.pick.lateBy + 'd late — and the shopper gets a revised date rather than silence.' });
    }
    if (r.mode === 'no-stock') {
      out.push({ tag: 'Decision', key: 'bad', text: 'No active facility holds ' + o.sku + ', so there is no route to take. The order is held and the shopper is notified, per your rules.' });
    }
    if (r.pick && r.pick.penalty) {
      out.push({ tag: 'Load', key: 'mute', text: r.pick.fc.name + ' is at ' + Math.round(r.pick.fc.load * 100) + '% load, over your ' + rules.loadThreshold + '% threshold, so a one-day handling penalty is included in the transit above.' });
    }
    return out;
  }

  function summary(rules) {
    const { results } = runEngine(rules);
    const hits = results.filter(r => r.mode === 'ok').length;
    const routed = results.filter(r => r.pick);
    const adjusted = results.filter(r => r.mode === 'late' || r.mode === 'no-stock').length;
    const overCap = results.filter(r => r.flags.indexOf('over-ceiling') >= 0).length;
    const avg = routed.length ? routed.reduce((s, r) => s + r.pick.cost, 0) / routed.length : 0;
    const spend = routed.reduce((s, r) => s + r.pick.cost, 0);
    return { hits, adjusted, overCap, avg, spend, n: results.length };
  }

  global.Engine = {
    FCS, CARRIERS, SERVICES, SKUS, SHORT, INV0, ORDERS, TODAY, DEFAULTS, STORE,
    miles, fmtDate, fmtShort, money,
    loadRules, saveRules,
    runEngine, statusOf, reasonsFor, summary
  };
})(window);
