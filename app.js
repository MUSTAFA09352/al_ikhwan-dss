/* ============================================================================
   Al-Ikhwan Company — Executive Decision Support System (DSS) v2.0
   app.js — Single-page controller: router, REST data layer, Chart.js views
            and the what-if decision-simulation engine.
   ----------------------------------------------------------------------------
   Modules
     1.  Configuration & formatters        7.  Inventory & Products view
     2.  REST data layer                   8.  Employees & HR view
     3.  Chart registry & helpers          9.  Suppliers & Purchases view
     4.  Toasts & UI chrome                10. Financial Reports view
     5.  Overview dashboard & KPIs         11. Router
     6.  DSS what-if simulation engine     12. Bootstrap
   ========================================================================== */

(function () {
  'use strict';

  /* ==========================================================================
     1. CONFIGURATION & FORMATTERS
     ========================================================================== */
  const CONFIG = {
    locale: 'en-US',
    currency: 'USD',
    // When opened directly from disk (file://), talk to the local Flask API.
    apiBase: location.protocol === 'file:' ? 'http://127.0.0.1:5000' : '',
    priceElasticity: 1.9,
    maxMarketingUplift: 0.4,
    marketingHalfSaturation: 0.8,
    synergyCoefficient: 0.3,
    risk: {
      marginErosionWeight: 55, discountWeight: 0.9,
      profitDeclinePenalty: 18, profitGrowthBonus: -10,
      criticalMargin: 0.05, warningMargin: 0.08,
      criticalMarginPenalty: 25, warningMarginPenalty: 12,
      lowThreshold: 34, highThreshold: 67
    }
  };

  const PALETTE = ['#0ea5e9', '#10b981', '#f59e0b', '#0284c7', '#14b8a6', '#6366f1', '#f97316', '#8b5cf6'];
  const CATEGORY_COLORS = {
    'Electronics': '#0284c7', 'Commercial Goods': '#10b981',
    'Home Appliances': '#f59e0b', 'Spare Parts': '#14b8a6'
  };

  const currencyFmt = new Intl.NumberFormat(CONFIG.locale, { style: 'currency', currency: CONFIG.currency, maximumFractionDigits: 0 });
  const numberFmt = new Intl.NumberFormat(CONFIG.locale, { maximumFractionDigits: 0 });

  const $ = (id) => document.getElementById(id);
  const fmtCurrency = (n) => currencyFmt.format(Math.round(n || 0));
  const fmtNumber = (n) => numberFmt.format(Math.round(n || 0));
  const fmtPercent = (n, d = 1) => `${(n || 0).toFixed(d)}%`;
  const fmtSigned = (n, d = 1) => `${n >= 0 ? '+' : ''}${(n || 0).toFixed(d)}%`;
  const fmtAxisCurrency = (n) => `$${Math.round(n / 1000)}k`;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ==========================================================================
     2. REST DATA LAYER
     ========================================================================== */
  const state = { data: {}, loaded: {} };

  async function api(path, options) {
    const res = await fetch(CONFIG.apiBase + path, options);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
    return res.json();
  }
  const apiGet = (p) => api(p);
  const apiPost = (p, body) => api(p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  /* ==========================================================================
     3. CHART REGISTRY & HELPERS
     ========================================================================== */
  Chart.defaults.color = '#64748b';
  Chart.defaults.font.family = "'Inter', 'Segoe UI', system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.borderColor = 'rgba(148, 163, 184, 0.18)';

  const charts = {};
  function mount(id, config) {
    const canvas = $(id);
    if (!canvas) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(canvas.getContext('2d'), config);
  }
  const tooltipStyle = {
    backgroundColor: 'rgba(15, 23, 42, 0.94)', borderColor: 'rgba(14, 165, 233, 0.35)',
    borderWidth: 1, padding: 12, titleFont: { weight: '700' }
  };
  function verticalGradient(hex, alphaTop) {
    return (ctx) => {
      const { chart } = ctx;
      if (!chart.chartArea) return hex;
      const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
      g.addColorStop(0, hex + alphaTop);
      g.addColorStop(1, hex + '00');
      return g;
    };
  }
  function renderLegend(id, items) {
    const el = $(id);
    if (!el) return;
    const total = items.reduce((a, b) => a + b.value, 0) || 1;
    el.innerHTML = items.map((it) => `
      <li>
        <span class="legend__dot" style="background:${it.color}"></span>
        <span class="legend__name">${esc(it.label)}</span>
        <span class="legend__val">${fmtCurrency(it.value)}</span>
        <span class="legend__pct">${((it.value / total) * 100).toFixed(1)}%</span>
      </li>`).join('');
  }
  function regression(values) {
    const n = values.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    values.forEach((y, i) => { sx += i; sy += y; sxy += i * y; sxx += i * i; });
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { slope, intercept: (sy - slope * sx) / n };
  }
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function nextMonthLabel(isoMonth) {
    // Accepts ISO months like "2026-10" and returns the following short label.
    const m = parseInt(isoMonth.slice(5, 7), 10);
    return MONTH_NAMES[m % 12] || 'Next';
  }
  const monthShort = (isoMonth) => MONTH_NAMES[parseInt(isoMonth.slice(5, 7), 10) - 1] || isoMonth;

  /* ==========================================================================
     4. TOASTS & UI CHROME
     ========================================================================== */
  function toast(message, kind = 'info') {
    const wrap = $('toastWrap');
    const icons = { info: 'fa-circle-info', success: 'fa-circle-check', error: 'fa-triangle-exclamation' };
    const node = document.createElement('div');
    node.className = `toast toast--${kind}`;
    node.innerHTML = `<i class="fa-solid ${icons[kind] || icons.info}"></i><span>${esc(message)}</span>`;
    wrap.appendChild(node);
    setTimeout(() => { node.style.opacity = '0'; node.style.transform = 'translateX(20px)'; }, 3200);
    setTimeout(() => node.remove(), 3600);
  }
  function setDbStatus(kind, text) {
    const dot = $('dbStatus');
    dot.classList.remove('is-ok', 'is-bad');
    if (kind === 'ok') dot.classList.add('is-ok');
    if (kind === 'bad') dot.classList.add('is-bad');
    dot.innerHTML = `<span></span> ${esc(text)}`;
  }

  function startClock() {
    const tick = () => {
      const now = new Date();
      $('liveDate').textContent = now.toLocaleDateString(CONFIG.locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      $('liveClock').textContent = now.toLocaleTimeString(CONFIG.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ==========================================================================
     4.5 AUTH GATE & GLOBAL SEARCH
     ========================================================================== */
  const AUTH_USER = 'admin';
  const AUTH_PASS = 'admin123';
  const AUTH_KEY = 'dssAuth';

  function applyAuthState() {
    document.body.classList.toggle('is-authenticated', sessionStorage.getItem(AUTH_KEY) === '1');
  }

  function enterApp() {
    sessionStorage.setItem(AUTH_KEY, '1');
    applyAuthState();
    setTimeout(loadApp, 480); // wait for the auth->shell fade before mounting charts
  }

  async function loadApp() {
    try {
      const health = await apiGet('/api/health');
      setDbStatus('ok', `Connected · ${health.counts.sales} sales`);
    } catch (e) {
      setDbStatus('bad', 'Database offline');
      toast('Cannot reach the API. Start the server with: python server.py', 'error');
    }
    await setView(viewFromHash() || 'overview');
  }

  function signOut() {
    sessionStorage.removeItem(AUTH_KEY);
    applyAuthState();
    $('loginSubmit').disabled = false;
    $('loginPass').value = '';
    toast('Signed out securely', 'success');
  }

  function tableFilter(query) {
    const q = String(query || '').trim().toLowerCase();
    document.querySelectorAll('.view').forEach((view) => {
      if (view.hidden) return;
      view.querySelectorAll('.data-table tbody tr, .perf-list li, .pl-list li').forEach((row) => {
        row.hidden = !!q && !(row.textContent || '').toLowerCase().includes(q);
      });
    });
  }

  function bindAuth() {
    applyAuthState();

    $('loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const u = $('loginUser').value.trim();
      const p = $('loginPass').value;
      if (u === AUTH_USER && p === AUTH_PASS) {
        $('loginSubmit').disabled = true;
        enterApp();
      } else {
        toast('Invalid username or password. Use "Show Recovery Hints" for demo access.', 'error');
        $('loginPass').value = '';
        $('loginPass').focus();
      }
    });

    $('togglePass').addEventListener('click', () => {
      const pass = $('loginPass');
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      $('togglePass').innerHTML = `<i class="fa-${show ? 'solid' : 'regular'} fa-eye${show ? '-slash' : ''}"></i>`;
    });

    $('forgotLink').addEventListener('click', (e) => {
      e.preventDefault();
      $('authRecovery').hidden = false;
    });

    $('recoveryReset').addEventListener('click', () => toast('Reset token sent to IT Security Desk', 'success'));
    $('recoveryHints').addEventListener('click', () => { $('recoveryHint').hidden = false; });
    $('recoveryClose').addEventListener('click', () => { $('authRecovery').hidden = true; });

    $('btnSignOut').addEventListener('click', signOut);

    $('globalSearch').addEventListener('input', (e) => tableFilter(e.target.value));
  }

  function statCard(label, value, sub, icon, tone = '') {
    return `
      <div class="stat-card">
        <span class="stat-card__icon ${tone}"><i class="fa-solid ${icon}"></i></span>
        <div class="stat-card__body">
          <div class="stat-card__label">${esc(label)}</div>
          <div class="stat-card__value">${value}</div>
          <div class="stat-card__sub">${sub}</div>
        </div>
      </div>`;
  }

  /* ==========================================================================
     5. OVERVIEW DASHBOARD & KPIs
     ========================================================================== */
  let simBase = null; // resolved baseline model inputs for the simulator

  async function loadOverview() {
    const d = await apiGet('/api/overview');
    state.data.overview = d;

    simBase = {
      revenue: d.simulation.baselineRevenue,
      volume: d.simulation.baselineUnits,
      avgListPrice: d.simulation.avgListPrice,
      unitVariableCost: d.simulation.unitVariableCost,
      marketing: d.simulation.marketingBaseline,
      opex: d.simulation.fixedOpex,
      profit: d.kpis.netProfit
    };

    renderKpis(d);
    mountForecast(d);
    mountRevenueMix(d);
    initSimulatorUI(d);
  }

  function buildKpiModel(d, sim) {
    const k = d.kpis;
    const active = !!sim;
    const revenue = active ? sim.revenue : k.revenue;
    const margin = active ? sim.margin * 100 : k.margin;
    const profit = active ? sim.profit : k.netProfit;
    const tag = active ? 'Scenario' : 'Month';

    return [
      {
        label: 'Total Revenue', icon: 'fa-sack-dollar', tone: 'info',
        value: fmtCurrency(revenue),
        sub: `${tag} revenue · target attainment ${fmtPercent((revenue / k.target) * 100)}`,
        trendDir: (active ? sim.revenueDeltaPct : k.revenueTrend) >= 0 ? 'up' : 'down',
        trendText: `${fmtSigned(active ? sim.revenueDeltaPct : k.revenueTrend)} vs prior month`,
        spark: d.series.map((s) => s.revenue)
      },
      {
        label: 'Net Profit Margin', icon: 'fa-percent', tone: 'success',
        value: fmtPercent(margin),
        sub: `${tag} net profit ${fmtCurrency(profit)}`,
        trendDir: margin >= k.margin ? 'up' : 'down',
        trendText: `${fmtSigned(margin - k.margin)} vs baseline margin`
      },
      {
        label: 'Low Stock Alerts', icon: 'fa-triangle-exclamation', tone: k.lowStock > 0 ? 'danger' : 'success',
        value: fmtNumber(k.lowStock),
        sub: 'Critical SKUs requiring immediate purchase orders',
        trendDir: k.lowStock > 0 ? 'down' : 'up',
        trendText: k.lowStock > 0 ? 'Action required today' : 'All SKUs within safe cover'
      },
      {
        label: 'Collection Efficiency', icon: 'fa-money-bill-trend-up', tone: 'info',
        value: fmtPercent(k.collectionEfficiency),
        sub: `DSO ${k.dso.toFixed(1)} days · Receivables ${fmtCurrency(k.receivables)}`,
        trendDir: 'up',
        trendText: 'Healthy liquidity position'
      }
    ];
  }

  function renderKpis(d, sim) {
    const cards = buildKpiModel(d, sim);
    $('kpiGrid').innerHTML = cards.map((c) => {
      const trendIcon = c.trendDir === 'up' ? 'fa-arrow-trend-up' : c.trendDir === 'down' ? 'fa-arrow-trend-down' : 'fa-minus';
      return `
        <article class="kpi-card kpi-card--${c.tone}">
          <div class="kpi-card__top">
            <span class="kpi-card__label">${c.label}</span>
            <span class="kpi-card__icon"><i class="fa-solid ${c.icon}"></i></span>
          </div>
          <div class="kpi-card__value">${c.value}</div>
          <div class="kpi-card__sub">${c.sub}</div>
          <span class="kpi-card__trend ${c.trendDir}"><i class="fa-solid ${trendIcon}"></i> ${c.trendText}</span>
          ${c.spark ? '<div class="kpi-card__spark"><canvas aria-hidden="true"></canvas></div>' : ''}
        </article>`;
    }).join('');

    // Revenue sparkline.
    if (charts.__spark) charts.__spark.destroy();
    const sparkCanvas = $('kpiGrid').querySelector('.kpi-card__spark canvas');
    if (sparkCanvas) {
      charts.__spark = new Chart(sparkCanvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: d.series.map((s) => monthShort(s.month)),
          datasets: [{ data: cards[0].spark, borderColor: '#0ea5e9', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: verticalGradient('#0ea5e9', '59') }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, animation: { duration: 400 } }
      });
    }

    $('kpiScenarioBadge').hidden = !sim;
  }

  function forecastDatasets(d, projectedRevenue) {
    const months = d.series.map((s) => monthShort(s.month));
    const labels = months.concat([nextMonthLabel(d.currentMonth)]);
    const actual = d.series.map((s) => s.revenue);
    const targets = d.series.map((s) => d.targets[s.month] || null);
    const n = actual.length;
    const reg = regression(actual);
    const trend = actual.map((_, i) => Math.round(reg.slope * i + reg.intercept)).concat([Math.round(reg.slope * n + reg.intercept)]);

    const actualData = actual.concat([null]);
    const targetData = targets.concat([targets[n - 1] ? Math.round(targets[n - 1] * 1.04) : null]);
    const scenarioData = new Array(n + 1).fill(null);
    scenarioData[n - 1] = actual[n - 1];
    scenarioData[n] = projectedRevenue;

    return {
      labels,
      datasets: [
        { label: 'Actual Revenue', data: actualData, borderColor: '#0ea5e9', backgroundColor: verticalGradient('#0ea5e9', '52'), borderWidth: 3, tension: 0.35, pointRadius: 4, pointBackgroundColor: '#ffffff', pointBorderColor: '#0ea5e9', pointBorderWidth: 2, fill: true },
        { label: 'Management Target', data: targetData, borderColor: '#f59e0b', borderWidth: 2, borderDash: [6, 5], tension: 0.35, pointRadius: 0 },
        { label: 'Forecast Trend', data: trend, borderColor: '#14b8a6', borderWidth: 2, borderDash: [3, 4], tension: 0.3, pointRadius: 0 },
        { label: 'Scenario Projection', data: scenarioData, borderColor: '#8b5cf6', borderWidth: 2.5, borderDash: [5, 4], tension: 0.35, pointRadius: 5, pointBackgroundColor: '#8b5cf6', spanGaps: false }
      ]
    };
  }

  function mountForecast(d, projectedRevenue) {
    const projected = projectedRevenue == null ? d.series[d.series.length - 1].revenue : projectedRevenue;
    mount('chartSalesForecast', {
      type: 'line',
      data: forecastDatasets(d, projected),
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 14 } },
          tooltip: { ...tooltipStyle, callbacks: { label: (i) => ` ${i.dataset.label}: ${i.parsed.y == null ? '—' : fmtCurrency(i.parsed.y)}` } }
        },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: 'rgba(112,148,214,0.1)' }, ticks: { callback: (v) => fmtAxisCurrency(v) } }
        }
      }
    });
  }

  function mountRevenueMix(d) {
    const labels = d.categories.map((c) => c.category);
    const values = d.categories.map((c) => c.revenue);
    const colors = labels.map((l, i) => CATEGORY_COLORS[l] || PALETTE[i % PALETTE.length]);
    const total = values.reduce((a, b) => a + b, 0) || 1;

    mount('chartRevenueBreakdown', {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 3, hoverOffset: 8 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '64%',
        plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: (i) => ` ${i.label}: ${fmtCurrency(i.parsed)} (${((i.parsed / total) * 100).toFixed(1)}%)` } } }
      }
    });
    renderLegend('revenueLegend', labels.map((l, i) => ({ label: l, value: values[i], color: colors[i] })));
  }

  /* ==========================================================================
     6. DSS WHAT-IF SIMULATION ENGINE
     --------------------------------------------------------------------------
       discountUplift  = elasticity × discount
       marketingUplift = maxUplift × (inc / (inc + halfSat))     (saturating)
       growth          = 1 + discountUplift + marketingUplift + synergy
       revenue         = volume×growth × (listPrice × (1 − discount))
       profit          = revenue − volume×growth×unitCost − marketing − fixedOpex
     ========================================================================== */
  function simulate(discountPct, marketingPct, base) {
    const d = discountPct / 100;
    const inc = marketingPct / 100;

    const discountUplift = CONFIG.priceElasticity * d;
    const marketingUplift = CONFIG.maxMarketingUplift * (inc / (inc + CONFIG.marketingHalfSaturation));
    const synergy = CONFIG.synergyCoefficient * discountUplift * marketingUplift;
    const growth = 1 + discountUplift + marketingUplift + synergy;

    const volume = base.volume * growth;
    const revenue = volume * base.avgListPrice * (1 - d);
    const variableCost = volume * base.unitVariableCost;
    const marketing = base.marketing * (1 + inc);
    const profit = revenue - variableCost - marketing - base.opex;
    const margin = revenue > 0 ? profit / revenue : 0;

    const revenueDeltaPct = base.revenue ? ((revenue - base.revenue) / base.revenue) * 100 : 0;
    const volumeDeltaPct = base.volume ? ((volume - base.volume) / base.volume) * 100 : 0;
    const profitDeltaPct = base.profit ? ((profit - base.profit) / base.profit) * 100 : 0;

    const marginErosion = base.revenue && base.profit ? Math.max(0, (base.profit / base.revenue - margin) / (base.profit / base.revenue)) : 0;
    let risk = CONFIG.risk.marginErosionWeight * marginErosion + CONFIG.risk.discountWeight * discountPct;
    if (profit < base.profit * 0.999) risk += CONFIG.risk.profitDeclinePenalty;
    else if (profit > base.profit * 1.001) risk += CONFIG.risk.profitGrowthBonus;
    if (margin < CONFIG.risk.criticalMargin) risk += CONFIG.risk.criticalMarginPenalty;
    else if (margin < CONFIG.risk.warningMargin) risk += CONFIG.risk.warningMarginPenalty;
    risk = clamp(risk, 0, 100);

    const riskLevel = risk >= CONFIG.risk.highThreshold ? 'High' : risk >= CONFIG.risk.lowThreshold ? 'Moderate' : 'Low';
    return { revenue, volume, profit, margin, risk, riskLevel, revenueDeltaPct, volumeDeltaPct, profitDeltaPct, active: discountPct !== 0 || marketingPct !== 0 };
  }

  function profitSafeDiscount(marketingPct) {
    const tolerance = -0.02 * simBase.profit;
    let safe = 0;
    for (let d = 0; d <= 40; d += 0.5) {
      const s = simulate(d, marketingPct, simBase);
      if (s.profit - simBase.profit >= tolerance) safe = d; else break;
    }
    return safe;
  }

  function initSimulatorUI(d) {
    $('baselineRevenue').textContent = fmtCurrency(simBase.revenue);
    $('baselineVolume').textContent = `${fmtNumber(simBase.volume)} units`;
    $('baselineMarketing').textContent = fmtCurrency(simBase.marketing);

    const slider = $('discountRange');
    const market = $('marketingRange');
    slider.value = 0;
    market.value = 0;
    slider.oninput = runSimulation;
    market.oninput = runSimulation;
    $('btnReset').onclick = () => { slider.value = 0; market.value = 0; runSimulation(); };
    runSimulation();
  }

  function runSimulation() {
    if (!simBase) return;
    const discountPct = Number($('discountRange').value);
    const marketingPct = Number($('marketingRange').value);
    const sim = simulate(discountPct, marketingPct, simBase);

    $('discountValue').textContent = `${discountPct}%`;
    $('marketingValue').textContent = `${marketingPct}%`;
    paintRange('discountRange', discountPct, 40);
    paintRange('marketingRange', marketingPct, 100);

    setDelta('outVolume', fmtNumber(sim.volume), sim.volumeDeltaPct);
    setDelta('outProfit', fmtCurrency(sim.profit), sim.profitDeltaPct);
    setDelta('outRevenue', fmtCurrency(sim.revenue), sim.revenueDeltaPct);
    setRisk(sim);

    const fill = $('riskBarFill');
    fill.style.width = `${sim.risk}%`;
    fill.style.background = sim.riskLevel === 'High' ? 'var(--danger)' : sim.riskLevel === 'Moderate' ? 'var(--warning)' : 'var(--success)';

    renderRecommendation(sim);
    renderKpis(state.data.overview, sim.active ? sim : null);
    if (state.data.overview) mountForecast(state.data.overview, sim.revenue);
  }

  function paintRange(id, value, max) {
    $(id).style.setProperty('--fill', `${clamp((value / max) * 100, 0, 100)}%`);
  }
  function setDelta(id, value, deltaPct) {
    $(id).textContent = value;
    const el = $(id + 'Delta');
    const dir = deltaPct > 0.05 ? 'up' : deltaPct < -0.05 ? 'down' : 'flat';
    el.className = 'outcome__delta ' + (dir === 'up' ? 'delta-up' : dir === 'down' ? 'delta-down' : 'delta-flat');
    const arrow = dir === 'up' ? 'fa-arrow-up' : dir === 'down' ? 'fa-arrow-down' : 'fa-minus';
    el.innerHTML = `<i class="fa-solid ${arrow}"></i> ${fmtSigned(deltaPct)} vs baseline`;
  }
  function setRisk(sim) {
    const el = $('outRisk');
    el.textContent = sim.riskLevel;
    el.style.color = sim.riskLevel === 'High' ? 'var(--danger)' : sim.riskLevel === 'Moderate' ? 'var(--warning)' : 'var(--success)';
    const note = $('outRiskNote');
    note.className = 'outcome__delta delta-flat';
    note.textContent = `Risk score ${sim.risk.toFixed(0)} / 100`;
  }

  function renderRecommendation(sim) {
    const box = $('recommendation');
    if (!sim.active) {
      box.className = 'recommendation';
      box.innerHTML = `
        <div class="recommendation__head"><i class="fa-solid fa-scale-balanced"></i> Baseline Scenario</div>
        <div class="recommendation__body">
          No decision levers applied. Baseline: <strong>${fmtCurrency(simBase.revenue)}</strong> revenue at
          <strong>${fmtPercent((simBase.profit / simBase.revenue) * 100)}</strong> net margin
          (<strong>${fmtCurrency(simBase.profit)}</strong> net profit). Move the sliders to simulate a scenario.
        </div>`;
      return;
    }
    const safe = profitSafeDiscount(sim.marketingPct);
    const pd = sim.profitDeltaPct;
    let klass, icon, title, body;

    if (sim.riskLevel === 'High' || pd < -10) {
      klass = 'recommendation--reject'; icon = 'fa-circle-xmark';
      title = 'Not Recommended — Severe margin compression';
      body = `Projected net profit <strong>${pd < 0 ? 'falls' : 'moves'} to ${fmtCurrency(sim.profit)} (${fmtSigned(pd)})</strong>
              with margin at <strong>${fmtPercent(sim.margin * 100)}</strong> and risk rated <strong>${sim.riskLevel}</strong>.
              Discount depth erodes contribution faster than volume offsets it. Cap the discount at
              <strong>≤ ${safe.toFixed(1)}%</strong> and/or reallocate to marketing-led demand.`;
    } else if (pd >= 1) {
      klass = 'recommendation--approve'; icon = 'fa-circle-check';
      title = 'Recommended — Uplift offsets margin reduction';
      body = `Volume grows <strong>${fmtSigned(sim.volumeDeltaPct)}</strong> to <strong>${fmtNumber(sim.volume)} units</strong>,
              lifting net profit to <strong>${fmtCurrency(sim.profit)} (${fmtSigned(pd)})</strong> on
              <strong>${fmtCurrency(sim.revenue)}</strong> revenue. Margin settles at
              <strong>${fmtPercent(sim.margin * 100)}</strong> with <strong>${sim.riskLevel}</strong> risk. Proceed, monitoring depth beyond <strong>${safe.toFixed(1)}%</strong>.`;
    } else {
      klass = 'recommendation--caution'; icon = 'fa-triangle-exclamation';
      title = 'Proceed with Caution — Partial margin compression';
      body = `Volume rises <strong>${fmtSigned(sim.volumeDeltaPct)}</strong> to <strong>${fmtNumber(sim.volume)} units</strong>,
              but net profit eases to <strong>${fmtCurrency(sim.profit)} (${fmtSigned(pd)})</strong> and margin compresses to
              <strong>${fmtPercent(sim.margin * 100)}</strong> (risk: <strong>${sim.riskLevel}</strong>).
              Cap the discount near <strong>${safe.toFixed(1)}%</strong> to protect profitability.`;
    }
    box.className = `recommendation ${klass}`;
    box.innerHTML = `<div class="recommendation__head"><i class="fa-solid ${icon}"></i> ${title}</div><div class="recommendation__body">${body}</div>`;
  }

  /* ==========================================================================
     7. INVENTORY & PRODUCTS VIEW
     ========================================================================== */
  let catalogFilter = 'all';

  async function loadInventory() {
    const d = await apiGet('/api/products');
    state.data.products = d;

    $('inventoryStats').innerHTML = [
      statCard('Total SKUs', fmtNumber(d.summary.total), 'Active product lines', 'fa-layer-group'),
      statCard('Reorder Alerts', fmtNumber(d.summary.reorder), 'Critical stock levels', 'fa-triangle-exclamation', 'is-danger'),
      statCard('Slow-Moving', fmtNumber(d.summary.slow), 'Liquidation candidates', 'fa-arrow-trend-down', 'is-warning'),
      statCard('Inventory Value', fmtCurrency(d.summary.stockValue), `Retail ${fmtCurrency(d.summary.retailValue)}`, 'fa-warehouse', 'is-success')
    ].join('');

    $('countAll').textContent = d.summary.total;
    $('countReorder').textContent = d.summary.reorder;
    $('countOptimal').textContent = d.summary.optimal;
    $('countSlow').textContent = d.summary.slow;

    renderCatalog();
    bindCatalogFilters();
  }

  function renderCatalog() {
    const d = state.data.products;
    const rows = d.catalog.filter((p) => catalogFilter === 'all' || p.status.key === catalogFilter);
    const tone = { reorder: 'tag--reorder', slow: 'tag--slow', optimal: 'tag--optimal' };
    const barColor = { reorder: 'var(--danger)', slow: 'var(--warning)', optimal: 'var(--success)' };
    const icons = { reorder: 'fa-triangle-exclamation', slow: 'fa-arrow-trend-down', optimal: 'fa-circle-check' };

    $('catalogBody').innerHTML = rows.length ? rows.map((p) => {
      const covPct = clamp((p.status.coverage / 8) * 100, 0, 100);
      return `
        <tr class="${p.status.key === 'reorder' ? 'row--critical' : ''}">
          <td><div class="product-cell"><span class="name">${esc(p.name)}</span><span class="sku">${esc(p.sku)} · ${esc(p.name_ar || '')}</span></div></td>
          <td><span class="cat-pill">${esc(p.category)}</span></td>
          <td class="num">${fmtCurrency(p.cost)}</td>
          <td class="num">${fmtCurrency(p.price)}</td>
          <td class="num">${fmtNumber(p.stock)}</td>
          <td class="num">${fmtNumber(p.reorder_point)}</td>
          <td class="num"><div class="coverage"><span>${p.status.coverage.toFixed(1)} mo</span><span class="coverage__bar"><span style="width:${covPct}%;background:${barColor[p.status.key]}"></span></span></div></td>
          <td><span class="tag ${tone[p.status.key]}"><i class="fa-solid ${icons[p.status.key]}"></i> ${p.status.label}</span></td>
          <td class="num"><button class="btn btn--ghost btn--sm" data-reorder="${p.id}" data-name="${esc(p.name)}" data-velocity="${p.velocity}"><i class="fa-solid fa-cart-plus"></i> Reorder</button></td>
        </tr>`;
    }).join('') : '<tr class="empty-row"><td colspan="9">No products match this filter.</td></tr>';

    // Wire reorder buttons to the modal.
    $('catalogBody').querySelectorAll('[data-reorder]').forEach((btn) => {
      btn.addEventListener('click', () => openReorder(btn.dataset.reorder, btn.dataset.name, Number(btn.dataset.velocity)));
    });
  }

  function bindCatalogFilters() {
    document.querySelectorAll('.chip[data-filter]').forEach((chip) => {
      chip.onclick = () => {
        document.querySelectorAll('.chip[data-filter]').forEach((c) => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        catalogFilter = chip.dataset.filter;
        renderCatalog();
      };
    });
  }

  let reorderProductId = null;
  function openReorder(id, name, velocity) {
    reorderProductId = id;
    $('reorderProduct').textContent = name;
    $('reorderQty').value = Math.max(20, velocity * 2);
    $('reorderHint').textContent = `Suggested: ~2 months of demand (${Math.max(20, velocity * 2)} units). A purchase order will be created as Pending.`;
    $('reorderModal').hidden = false;
  }
  function closeReorder() { $('reorderModal').hidden = true; reorderProductId = null; }

  async function submitReorder() {
    if (!reorderProductId) return;
    const qty = Number($('reorderQty').value);
    try {
      const res = await apiPost('/api/products/reorder', { product_id: Number(reorderProductId), qty });
      toast(res.message, 'success');
      closeReorder();
      // Refresh catalog + suppliers (new PO) and invalidate their caches.
      state.loaded.products = false;
      state.loaded.suppliers = false;
      await loadInventory();
      state.loaded.products = true;
    } catch (e) {
      toast('Reorder failed: ' + e.message, 'error');
    }
  }

  function bindReorderModal() {
    $('reorderModal').querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', closeReorder));
    $('reorderSubmit').addEventListener('click', submitReorder);
  }

  /* ==========================================================================
     8. EMPLOYEES & HR VIEW
     ========================================================================== */
  async function loadEmployees() {
    const d = await apiGet('/api/employees');
    state.data.employees = d;
    const topSeller = d.directory.filter((e) => e.month_sales > 0).sort((a, b) => b.month_sales - a.month_sales)[0];

    $('hrStats').innerHTML = [
      statCard('Headcount', fmtNumber(d.summary.headcount), `${d.byDepartment.length} departments`, 'fa-user-group'),
      statCard('Monthly Payroll', fmtCurrency(d.summary.payrollTotal), 'Total salaries', 'fa-money-check-dollar', 'is-warning'),
      statCard('Avg Performance', `${d.summary.avgPerformance}/100`, 'Across all staff', 'fa-gauge-high', 'is-success'),
      statCard('Top Seller (Month)', topSeller ? esc(topSeller.name) : '—', topSeller ? fmtCurrency(topSeller.month_sales) : 'No data', 'fa-trophy', 'is-success')
    ].join('');

    // Payroll by department.
    mount('chartPayroll', {
      type: 'bar',
      data: {
        labels: d.byDepartment.map((x) => x.department),
        datasets: [{ label: 'Payroll', data: d.byDepartment.map((x) => x.payroll), backgroundColor: '#10b981', borderRadius: 6, maxBarThickness: 42 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: (i) => ` ${fmtCurrency(i.parsed.y)}` } } }, scales: { x: { grid: { display: false } }, y: { grid: { color: 'rgba(112,148,214,0.1)' }, ticks: { callback: (v) => fmtAxisCurrency(v) } } } }
    });

    // Top performers list.
    $('topPerformers').innerHTML = d.directory.slice(0, 6).map((e, i) => `
      <li>
        <span class="rank">${i + 1}</span>
        <span class="meta"><b>${esc(e.name)}</b><small>${esc(e.role)}</small></span>
        <span class="score">${e.performance_score}</span>
      </li>`).join('');

    // Directory table.
    $('employeesBody').innerHTML = d.directory.map((e) => {
      const color = e.performance_score >= 90 ? 'var(--success)' : e.performance_score >= 80 ? 'var(--accent-2)' : 'var(--warning)';
      return `
        <tr>
          <td><div class="product-cell"><span class="name">${esc(e.name)}</span><span class="sku">${esc(e.name_ar || '')}</span></div></td>
          <td>${esc(e.role)}</td>
          <td><span class="cat-pill">${esc(e.department)}</span></td>
          <td class="num">${fmtCurrency(e.salary)}</td>
          <td class="num"><div class="perf-bar"><span>${e.performance_score}</span><span class="perf-bar__track"><span style="width:${e.performance_score}%;background:${color}"></span></span></div></td>
          <td class="num">${e.month_sales ? fmtCurrency(e.month_sales) : '—'}${e.month_deals ? ` <small class="cat-pill">(${e.month_deals})</small>` : ''}</td>
        </tr>`;
    }).join('');
  }

  /* ==========================================================================
     9. SUPPLIERS & PURCHASES VIEW
     ========================================================================== */
  async function loadSuppliers() {
    const d = await apiGet('/api/suppliers');
    state.data.suppliers = d;
    const avgRating = d.suppliers.reduce((a, s) => a + s.rating, 0) / (d.suppliers.length || 1);

    $('supplierStats').innerHTML = [
      statCard('Suppliers', fmtNumber(d.summary.suppliers), `Avg rating ${avgRating.toFixed(1)}/5`, 'fa-truck-field'),
      statCard('Procurement Spend', fmtCurrency(d.summary.totalSpend), 'All purchase orders', 'fa-sack-dollar', 'is-warning'),
      statCard('Open Orders', fmtNumber(d.summary.openOrders), 'Pending / approved', 'fa-hourglass-half', 'is-danger'),
      statCard('Accounts Payable', fmtCurrency(d.suppliers.reduce((a, s) => a + s.balance, 0)), 'Outstanding supplier balances', 'fa-file-invoice', 'is-success')
    ].join('');

    mount('chartSupplierSpend', {
      type: 'bar',
      data: {
        labels: d.spendBySupplier.map((s) => s.supplier),
        datasets: [{ label: 'Spend', data: d.spendBySupplier.map((s) => s.spend), backgroundColor: '#0ea5e9', borderRadius: 6, maxBarThickness: 38 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: (i) => ` ${fmtCurrency(i.parsed.y)}` } } }, scales: { x: { grid: { display: false }, ticks: { maxRotation: 40, minRotation: 0 } }, y: { grid: { color: 'rgba(112,148,214,0.1)' }, ticks: { callback: (v) => fmtAxisCurrency(v) } } } }
    });

    $('supplierRatings').innerHTML = d.suppliers.slice().sort((a, b) => b.rating - a.rating).slice(0, 6).map((s) => `
      <li>
        <span class="rank"><i class="fa-solid fa-star" style="color:var(--warning)"></i></span>
        <span class="meta"><b>${esc(s.name)}</b><small>${esc(s.category || '')}</small></span>
        <span class="score">${s.rating.toFixed(1)}</span>
      </li>`).join('');

    $('suppliersBody').innerHTML = d.suppliers.map((s) => `
      <tr>
        <td><div class="product-cell"><span class="name">${esc(s.name)}</span><span class="sku">${esc(s.email || '')}</span></div></td>
        <td>${esc(s.contact || '')}<br><small class="cat-pill">${esc(s.phone || '')}</small></td>
        <td><span class="cat-pill">${esc(s.category || '')}</span></td>
        <td class="num"><span class="rating"><i class="fa-solid fa-star"></i>${s.rating.toFixed(1)}</span></td>
        <td class="num">${fmtCurrency(s.balance)}</td>
        <td class="num">${fmtCurrency(s.total_spend)}</td>
        <td class="num">${fmtNumber(s.order_count)}</td>
      </tr>`).join('');

    $('ordersBody').innerHTML = d.orders.map((o) => `
      <tr>
        <td><span class="sku">${esc(o.po_number)}</span></td>
        <td>${esc(o.supplier || '—')}</td>
        <td>${esc(o.product || '—')}</td>
        <td class="num">${fmtNumber(o.qty)}</td>
        <td class="num">${fmtCurrency(o.unit_cost)}</td>
        <td class="num">${fmtCurrency(o.total)}</td>
        <td>${esc(o.date)}</td>
        <td>${statusTag(o.status)}</td>
      </tr>`).join('');
  }

  function statusTag(status) {
    const map = { Received: 'tag--ok', Approved: 'tag--neutral', Pending: 'tag--warn', Cancelled: 'tag--reorder' };
    const icons = { Received: 'fa-box-open', Approved: 'fa-thumbs-up', Pending: 'fa-hourglass-half', Cancelled: 'fa-ban' };
    return `<span class="tag ${map[status] || 'tag--neutral'}"><i class="fa-solid ${icons[status] || 'fa-circle'}"></i> ${esc(status)}</span>`;
  }

  /* ==========================================================================
     10. FINANCIAL REPORTS VIEW
     ========================================================================== */
  async function loadFinance() {
    const d = await apiGet('/api/finance');
    state.data.finance = d;
    const s = d.summary;

    $('financeStats').innerHTML = [
      statCard('Revenue (Month)', fmtCurrency(s.revenue), `COGS ${fmtCurrency(s.cogs)}`, 'fa-sack-dollar'),
      statCard('Gross Profit', fmtCurrency(s.grossProfit), `Gross margin ${fmtPercent(s.grossMargin)}`, 'fa-chart-line', 'is-success'),
      statCard('Operating Expenses', fmtCurrency(s.expenses), 'Rent, salaries, marketing, utilities', 'fa-receipt', 'is-warning'),
      statCard('Net Profit', fmtCurrency(s.netProfit), `Net margin ${fmtPercent(s.netMargin)}`, 'fa-scale-balanced', s.netProfit >= 0 ? 'is-success' : 'is-danger')
    ].join('');

    // Gross profit vs expenses (bars) + net profit (line).
    mount('chartProfitTrend', {
      data: {
        labels: d.monthly.map((m) => monthShort(m.month)),
        datasets: [
          { type: 'bar', label: 'Gross Profit', data: d.monthly.map((m) => m.gross_profit), backgroundColor: '#10b981', borderRadius: 6, maxBarThickness: 26 },
          { type: 'bar', label: 'Operating Expenses', data: d.monthly.map((m) => m.expenses), backgroundColor: '#f59e0b', borderRadius: 6, maxBarThickness: 26 },
          { type: 'line', label: 'Net Profit', data: d.monthly.map((m) => m.net_profit), borderColor: '#0284c7', backgroundColor: '#0284c7', borderWidth: 3, tension: 0.35, pointRadius: 4, pointBackgroundColor: '#ffffff', pointBorderColor: '#0284c7', pointBorderWidth: 2 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 14 } }, tooltip: { ...tooltipStyle, callbacks: { label: (i) => ` ${i.dataset.label}: ${fmtCurrency(i.parsed.y)}` } } }, scales: { x: { grid: { display: false } }, y: { grid: { color: 'rgba(112,148,214,0.1)' }, ticks: { callback: (v) => fmtAxisCurrency(v) } } } }
    });

    const labels = d.expenseBreakdown.map((e) => e.category);
    const values = d.expenseBreakdown.map((e) => e.amount);
    const colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);
    const total = values.reduce((a, b) => a + b, 0) || 1;
    mount('chartExpenseBreakdown', {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 3, hoverOffset: 8 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '64%', plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: (i) => ` ${i.label}: ${fmtCurrency(i.parsed)} (${((i.parsed / total) * 100).toFixed(1)}%)` } } } }
    });
    renderLegend('expenseLegend', labels.map((l, i) => ({ label: l, value: values[i], color: colors[i] })));

    // P&L summary.
    $('plSummary').innerHTML = `
      <li><span class="pl-label">Revenue</span><span class="pl-value">${fmtCurrency(s.revenue)}</span></li>
      <li><span class="pl-label">Cost of Goods Sold</span><span class="pl-value neg">(${fmtCurrency(s.cogs)})</span></li>
      <li><span class="pl-label">Gross Profit</span><span class="pl-value pos">${fmtCurrency(s.grossProfit)}</span></li>
      <li><span class="pl-label">Operating Expenses</span><span class="pl-value neg">(${fmtCurrency(s.expenses)})</span></li>
      <li class="is-total"><span class="pl-label">Net Profit</span><span class="pl-value ${s.netProfit >= 0 ? 'pos' : 'neg'}">${fmtCurrency(s.netProfit)} · ${fmtPercent(s.netMargin)}</span></li>`;

    $('expenseDetailBody').innerHTML = d.detail.map((e) => `
      <tr><td>${esc(e.category)}</td><td>${esc(e.month)}</td><td class="num">${fmtCurrency(e.amount)}</td></tr>`).join('');
  }

  /* ==========================================================================
     SALES VIEW
     ========================================================================== */
  async function loadSales() {
    const d = await apiGet('/api/sales');
    state.data.sales = d;

    $('salesStats').innerHTML = [
      statCard('Total Revenue', fmtCurrency(d.stats.revenue), 'All recorded sales', 'fa-sack-dollar'),
      statCard('Invoices', fmtNumber(d.stats.invoices), 'Transactions', 'fa-file-invoice'),
      statCard('Avg Order Value', fmtCurrency(d.stats.avgOrder), 'Per invoice', 'fa-receipt', 'is-success'),
      statCard('Credit Outstanding', fmtCurrency(d.stats.creditOutstanding), 'Receivables on terms', 'fa-hand-holding-dollar', 'is-warning')
    ].join('');

    mount('chartSalesTrend', {
      data: {
        labels: d.trend.map((t) => monthShort(t.month)),
        datasets: [
          { type: 'bar', label: 'Revenue', data: d.trend.map((t) => t.revenue), backgroundColor: '#0284c7', borderRadius: 6, maxBarThickness: 34, yAxisID: 'y' },
          { type: 'line', label: 'Invoices', data: d.trend.map((t) => t.invoices), borderColor: '#10b981', backgroundColor: '#10b981', borderWidth: 3, tension: 0.35, pointRadius: 4, yAxisID: 'y1' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 14 } }, tooltip: tooltipStyle },
        scales: {
          x: { grid: { display: false } },
          y: { position: 'left', grid: { color: 'rgba(112,148,214,0.1)' }, ticks: { callback: (v) => fmtAxisCurrency(v) } },
          y1: { position: 'right', grid: { display: false }, ticks: { precision: 0 } }
        }
      }
    });

    const labels = d.paymentMix.map((p) => p.method);
    const values = d.paymentMix.map((p) => p.amount);
    const colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);
    const total = values.reduce((a, b) => a + b, 0) || 1;
    mount('chartPaymentMix', {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 3, hoverOffset: 8 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '64%', plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: (i) => ` ${i.label}: ${fmtCurrency(i.parsed)} (${((i.parsed / total) * 100).toFixed(1)}%)` } } } }
    });
    renderLegend('paymentLegend', labels.map((l, i) => ({ label: l, value: values[i], color: colors[i] })));

    $('topItemsBody').innerHTML = d.topItems.map((t) => `
      <tr>
        <td><div class="product-cell"><span class="name">${esc(t.name)}</span><span class="sku">${esc(t.category)}</span></div></td>
        <td><span class="cat-pill">${esc(t.category)}</span></td>
        <td class="num">${fmtNumber(t.units)}</td>
        <td class="num">${fmtCurrency(t.revenue)}</td>
      </tr>`).join('');

    $('salesSearch').oninput = (e) => renderInvoices(e.target.value);
    renderInvoices('');
  }

  function renderInvoices(term) {
    const d = state.data.sales;
    const q = term.trim().toLowerCase();
    const rows = d.invoices.filter((i) => !q || i.invoice.toLowerCase().includes(q) || i.customer.toLowerCase().includes(q));
    $('invoicesBody').innerHTML = rows.length ? rows.slice(0, 60).map((i) => `
      <tr>
        <td><span class="sku">${esc(i.invoice)}</span></td>
        <td>${esc(i.customer)}</td>
        <td>${esc(i.date)}</td>
        <td class="num">${fmtCurrency(i.total)}</td>
        <td><span class="tag tag--neutral">${esc(i.payment_method)}</span></td>
      </tr>`).join('') : '<tr class="empty-row"><td colspan="5">No invoices found.</td></tr>';
  }

  /* ==========================================================================
     11. ADD-RECORD FLOWS (modal forms + live refresh)
     ========================================================================== */

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  function bindModalClosers() {
    // Any [data-close] element hides its nearest .modal ancestor.
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal');
        if (modal) modal.hidden = true;
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
      }
    });
  }

  async function ensureProducts() {
    if (!state.data.products) {
      const d = await apiGet('/api/products');
      state.data.products = d;
    }
    return state.data.products;
  }
  async function ensureEmployees() {
    if (!state.data.employees) {
      const d = await apiGet('/api/employees');
      state.data.employees = d;
    }
    return state.data.employees;
  }

  /** Reload overview (KPIs/charts/simulator) + any already-loaded modules. */
  async function refreshAfterWrite(modules) {
    try {
      const d = await apiGet('/api/overview');
      state.data.overview = d;
      simBase = {
        revenue: d.simulation.baselineRevenue,
        volume: d.simulation.baselineUnits,
        avgListPrice: d.simulation.avgListPrice,
        unitVariableCost: d.simulation.unitVariableCost,
        marketing: d.simulation.marketingBaseline,
        opex: d.simulation.fixedOpex,
        profit: d.kpis.netProfit
      };
      $('baselineRevenue').textContent = fmtCurrency(simBase.revenue);
      $('baselineVolume').textContent = `${fmtNumber(simBase.volume)} units`;
      $('baselineMarketing').textContent = fmtCurrency(simBase.marketing);
      mountRevenueMix(d);
      runSimulation(); // re-renders KPI cards, forecast chart and outcomes
    } catch (e) {
      toast('Overview refresh failed: ' + e.message, 'error');
    }
    for (const m of modules) {
      if (state.loaded[m]) {
        try {
          await VIEWS[m].load();
        } catch (e) {
          toast(`Refresh of ${m} failed: ${e.message}`, 'error');
        }
      }
    }
  }

  /* ---------------------- Add Product ---------------------- */
  function openProductModal() {
    openModal('productModal');
  }
  function clearProductForm() {
    ['prodName', 'prodSku', 'prodNameAr'].forEach((id) => { $(id).value = ''; });
    ['prodCost', 'prodPrice', 'prodStock', 'prodReorder', 'prodVelocity'].forEach((id) => { $(id).value = '0'; });
    $('prodCategory').value = 'Electronics';
  }
  async function submitProduct() {
    const payload = {
      sku: $('prodSku').value.trim(),
      name: $('prodName').value.trim(),
      name_ar: $('prodNameAr').value.trim(),
      category: $('prodCategory').value,
      cost: Number($('prodCost').value),
      price: Number($('prodPrice').value),
      stock: Number($('prodStock').value),
      reorder_point: Number($('prodReorder').value),
      velocity: Number($('prodVelocity').value)
    };
    if (!payload.sku || !payload.name) { toast('Product name and SKU are required', 'error'); return; }

    const btn = $('btnAddProductSubmit');
    btn.disabled = true;
    try {
      const res = await apiPost('/api/products/add', payload);
      toast(res.message, 'success');
      closeModal('productModal');
      clearProductForm();
      await refreshAfterWrite(['inventory', 'sales']);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------------- Add Employee ---------------------- */
  function openEmployeeModal() {
    $('empHireDate').value = new Date().toISOString().slice(0, 10);
    openModal('employeeModal');
  }
  function clearEmployeeForm() {
    $('empName').value = ''; $('empNameAr').value = ''; $('empRole').value = '';
    $('empSalary').value = '5000'; $('empPerformance').value = '80';
  }
  async function submitEmployee() {
    const payload = {
      name: $('empName').value.trim(),
      name_ar: $('empNameAr').value.trim(),
      role: $('empRole').value.trim(),
      department: $('empDepartment').value,
      salary: Number($('empSalary').value),
      performance_score: Number($('empPerformance').value),
      hire_date: $('empHireDate').value
    };
    if (!payload.name || !payload.role) { toast('Employee name and role are required', 'error'); return; }

    const btn = $('btnAddEmployeeSubmit');
    btn.disabled = true;
    try {
      const res = await apiPost('/api/employees/add', payload);
      toast(res.message, 'success');
      closeModal('employeeModal');
      clearEmployeeForm();
      await refreshAfterWrite(['employees', 'sales']);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------------- Add Sale Transaction ---------------------- */
  let saleLines = [];
  const saleProductMap = {};

  function populateSaleEmployeeSelect() {
    const sel = $('saleEmployee');
    const emps = (state.data.employees?.directory || []).slice();
    sel.innerHTML = '<option value="">— Not assigned —</option>' +
      emps.map((e) => `<option value="${e.id}">${esc(e.name)} · ${esc(e.department)}</option>`).join('');
  }

  async function openSaleModal() {
    const latestDate = state.data.sales?.invoices?.[0]?.date || new Date().toISOString().slice(0, 10);
    $('saleDate').value = latestDate;
    $('saleCustomer').value = '';
    $('saleMethod').value = 'Cash';
    try {
      await Promise.all([ensureProducts(), ensureEmployees()]);
      state.data.products.catalog.forEach((p) => { saleProductMap[p.id] = p; });
      $('saleLineHelp').textContent = `${state.data.products.catalog.length} products · stock deducted on record`;
      populateSaleEmployeeSelect();
      saleLines = [{ product_id: null, qty: 1 }];
      renderSaleLines();
    } catch (e) {
      toast('Could not load sale form data: ' + e.message, 'error');
      return;
    }
    openModal('saleModal');
  }

  function renderSaleLines() {
    const wrap = $('saleLines');
    if (!wrap) return;
    const products = state.data.products?.catalog || [];
    wrap.innerHTML = saleLines.map((ln, i) => {
      const sub = ln.product_id && saleProductMap[ln.product_id] ? saleProductMap[ln.product_id].price * ln.qty : 0;
      return `
        <div class="sale-line">
          <select data-line="${i}" data-field="product" class="input">
            <option value="">Select product&hellip;</option>
            ${products.map((p) => `<option value="${p.id}" ${p.id === ln.product_id ? 'selected' : ''}>${esc(p.name)} — ${fmtCurrency(p.price)}</option>`).join('')}
          </select>
          <input data-line="${i}" data-field="qty" class="input" type="number" min="0" value="${ln.qty}" />
          <span class="sale-line__sub">${fmtCurrency(sub)}</span>
          <button class="icon-btn" type="button" data-line="${i}" data-remove="${i}" aria-label="Remove item"><i class="fa-solid fa-trash-can"></i></button>
        </div>`;
    }).join('');
    updateSaleTotal();
  }

  function updateSaleTotal() {
    let total = 0;
    saleLines.forEach((ln) => {
      if (ln.product_id && saleProductMap[ln.product_id]) total += saleProductMap[ln.product_id].price * ln.qty;
    });
    $('saleTotal').textContent = fmtCurrency(total);
  }

  function bindSaleLinesEvents() {
    $('saleLines').addEventListener('change', (e) => {
      const row = e.target.dataset.line;
      if (row == null) return;
      if (e.target.dataset.field === 'product') {
        saleLines[Number(row)].product_id = e.target.value ? Number(e.target.value) : null;
      } else {
        saleLines[Number(row)].qty = Number(e.target.value) || 0;
      }
      renderSaleLines();
    });
    $('saleLines').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      saleLines.splice(Number(btn.dataset.remove), 1);
      if (!saleLines.length) saleLines = [{ product_id: null, qty: 1 }];
      renderSaleLines();
    });
    $('btnAddSaleLine').addEventListener('click', () => {
      saleLines.push({ product_id: null, qty: 1 });
      renderSaleLines();
    });
  }

  async function submitSale() {
    const items = saleLines
      .filter((l) => l.product_id && l.qty > 0)
      .map((l) => ({ product_id: l.product_id, qty: l.qty }));
    if (!items.length) { toast('Add at least one item with qty &gt; 0', 'error'); return; }

    const payload = {
      customer: $('saleCustomer').value.trim() || 'Cash Customer',
      date: $('saleDate').value,
      payment_method: $('saleMethod').value,
      employee_id: Number($('saleEmployee').value) || null,
      items
    };

    const btn = $('btnAddSaleSubmit');
    btn.disabled = true;
    try {
      const res = await apiPost('/api/sales/add', payload);
      toast(res.message, 'success');
      closeModal('saleModal');
      await refreshAfterWrite(['sales', 'inventory', 'finance']);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function bindAddButtons() {
    $('btnAddProduct').addEventListener('click', openProductModal);
    $('btnAddProductSubmit').addEventListener('click', submitProduct);
    $('btnAddSale').addEventListener('click', openSaleModal);
    $('btnAddSaleSubmit').addEventListener('click', submitSale);
    $('btnAddEmployee').addEventListener('click', openEmployeeModal);
    $('btnAddEmployeeSubmit').addEventListener('click', submitEmployee);
    bindSaleLinesEvents();
  }

  /* ==========================================================================
     12. ROUTER
     ========================================================================== */
  const VIEWS = {
    overview: { title: 'Overview Dashboard', ar: 'لوحة القيادة', load: loadOverview },
    sales: { title: 'Sales', ar: 'المبيعات', load: loadSales },
    inventory: { title: 'Inventory & Products', ar: 'المنتجات والمخزون', load: loadInventory },
    employees: { title: 'Employees & HR', ar: 'الموظفين والموارد البشرية', load: loadEmployees },
    suppliers: { title: 'Suppliers & Purchases', ar: 'المشتريات والموردين', load: loadSuppliers },
    finance: { title: 'Financial Reports', ar: 'التقارير المالية', load: loadFinance }
  };

  let currentView = 'overview';

  function viewFromHash() {
    const name = location.hash.replace('#', '');
    return VIEWS[name] ? name : null;
  }

  async function setView(name) {
    if (!VIEWS[name]) return;
    currentView = name;
    closeSidebar();

    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    $('pageTitle').textContent = VIEWS[name].title;
    $('pageSubtitle').textContent = VIEWS[name].ar;

    // Reflect the active view in the URL for deep-linking (no history spam).
    if (location.hash.replace('#', '') !== name) history.replaceState(null, '', `#${name}`);

    if (!state.loaded[name]) {
      try {
        await VIEWS[name].load();
        state.loaded[name] = true;
      } catch (e) {
        toast(`Failed to load ${VIEWS[name].title}: ${e.message}`, 'error');
      }
    }

    // Re-apply the global search filter to the freshly mounted view.
    const q = $('globalSearch') && $('globalSearch').value;
    if (q) tableFilter(q);
  }

  async function loadAllViews() {
    for (const name of Object.keys(VIEWS)) {
      if (!state.loaded[name]) {
        try { await VIEWS[name].load(); state.loaded[name] = true; }
        catch (e) { toast(`Failed to load ${VIEWS[name].title}`, 'error'); }
      }
    }
  }

  /* ==========================================================================
     SIDEBAR / PRINT / NAV
     ========================================================================== */
  function openSidebar() { $('sidebar').classList.add('is-open'); $('sidebarOverlay').hidden = false; }
  function closeSidebar() { $('sidebar').classList.remove('is-open'); $('sidebarOverlay').hidden = true; }

  function bindChrome() {
    document.querySelectorAll('.nav-item').forEach((n) => n.addEventListener('click', () => setView(n.dataset.view)));
    $('menuToggle').addEventListener('click', () => $('sidebar').classList.contains('is-open') ? closeSidebar() : openSidebar());
    $('sidebarOverlay').addEventListener('click', closeSidebar);

    // Deep-linking: react to manual hash changes / browser back-forward.
    window.addEventListener('hashchange', () => {
      const name = viewFromHash();
      if (name && name !== currentView) setView(name);
    });

    // Comprehensive report: ensure every view has data, then print.
    $('btnPrint').addEventListener('click', async () => {
      await loadAllViews();
      window.print();
    });
  }

  /* ==========================================================================
     12. BOOTSTRAP
     ========================================================================== */
  async function init() {
    startClock();
    bindAuth();
    bindChrome();
    bindReorderModal();
    bindModalClosers();
    bindAddButtons();

    // Restore a valid session, otherwise wait at the executive sign-in screen.
    if (sessionStorage.getItem(AUTH_KEY) === '1') {
      applyAuthState();
      await loadApp();
    }

    // Expose a small API for debugging.
    window.DSS = { state, simulate, setView, VIEWS, apiGet };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
