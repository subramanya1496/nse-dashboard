// Portfolio page renderer. Same discipline as the rest of the dashboard: every number
// is computed from the published pipeline output, and any holding the pipeline could not
// price says so explicitly instead of being dropped or zero-filled.
(function () {
  const U = window.dashboardUtils;

  const money = (v, digits = 0) =>
    `₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: digits })}`;
  const signedMoney = (v, digits = 0) => `${v >= 0 ? "+" : "−"}${money(v, digits)}`;
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");

  function summarise(holdings, stockBySymbol) {
    const priced = holdings.filter((h) => h.current_price != null);
    const invested = priced.reduce((s, h) => s + h.buy_price * h.quantity, 0);
    const current = priced.reduce((s, h) => s + h.current_price * h.quantity, 0);
    const pnl = current - invested;
    const pnlPct = invested ? (pnl / invested) * 100 : 0;

    // Day change needs prev_close, which lives in the per-stock file rather than
    // portfolio.json. Holdings whose stock file is missing are excluded and counted.
    let dayChange = 0;
    let dayCovered = 0;
    priced.forEach((h) => {
      const ind = stockBySymbol[h.symbol]?.indicators;
      if (!ind || ind.prev_close == null || ind.close == null) return;
      dayChange += (ind.close - ind.prev_close) * h.quantity;
      dayCovered += 1;
    });
    const dayBase = priced.reduce((s, h) => {
      const ind = stockBySymbol[h.symbol]?.indicators;
      if (!ind || ind.prev_close == null) return s;
      return s + ind.prev_close * h.quantity;
    }, 0);
    const dayPct = dayBase ? (dayChange / dayBase) * 100 : null;

    const ranked = [...priced].filter((h) => h.pnl_pct != null).sort((a, b) => b.pnl_pct - a.pnl_pct);
    return {
      priced,
      unpriced: holdings.filter((h) => h.current_price == null),
      invested,
      current,
      pnl,
      pnlPct,
      dayChange,
      dayPct,
      dayCovered,
      best: ranked[0] || null,
      worst: ranked[ranked.length - 1] || null,
    };
  }

  function renderSummary(s, holdings) {
    const el = document.getElementById("pf-kpis");
    const dayHtml =
      s.dayCovered > 0
        ? `<div class="kpi-value mono ${cls(s.dayChange)}">${signedMoney(s.dayChange)}</div>
           <div class="kpi-sub ${cls(s.dayChange)}">${s.dayPct != null ? `${s.dayPct >= 0 ? "+" : ""}${s.dayPct.toFixed(2)}% today` : "today"}</div>`
        : `<div class="kpi-value">—</div><div class="kpi-sub">no per-stock data this run</div>`;

    el.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Invested</div>
        <div class="kpi-value mono">${money(s.invested)}</div>
        <div class="kpi-sub">${s.priced.length} of ${holdings.length} holdings priced</div></div>
      <div class="kpi-card"><div class="kpi-label">Current value</div>
        <div class="kpi-value mono">${money(s.current)}</div>
        <div class="kpi-sub">at last published close</div></div>
      <div class="kpi-card"><div class="kpi-label">Unrealized P&L</div>
        <div class="kpi-value mono ${cls(s.pnl)}">${signedMoney(s.pnl)}</div>
        <div class="kpi-sub ${cls(s.pnl)}">${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(2)}%</div></div>
      <div class="kpi-card"><div class="kpi-label">Day change</div>${dayHtml}</div>
      <div class="kpi-card"><div class="kpi-label">Best / worst</div>
        <div class="kpi-value pf-bw">
          ${s.best ? `<span class="up mono">${s.best.symbol} ${s.best.pnl_pct >= 0 ? "+" : ""}${s.best.pnl_pct.toFixed(1)}%</span>` : "—"}
        </div>
        <div class="kpi-sub">${s.worst ? `<span class="down mono">${s.worst.symbol} ${s.worst.pnl_pct >= 0 ? "+" : ""}${s.worst.pnl_pct.toFixed(1)}%</span>` : ""}</div></div>`;
  }

  function renderAllocation(s) {
    const el = document.getElementById("pf-allocation");
    if (!s.priced.length) {
      el.innerHTML = `<div class="empty-note">No priced holdings to allocate.</div>`;
      return;
    }
    const rows = [...s.priced]
      .map((h) => ({ h, value: h.current_price * h.quantity }))
      .sort((a, b) => b.value - a.value)
      .map(({ h, value }) => {
        const w = (value / s.current) * 100;
        return `<div class="alloc-row">
          <span class="ss">${h.symbol}</span>
          <span class="alloc-bar"><span style="width:${w.toFixed(1)}%" class="${cls(h.pnl ?? 0)}"></span></span>
          <span class="alloc-w mono">${w.toFixed(1)}%</span>
          <span class="alloc-v mono">${money(value)}</span>
        </div>`;
      })
      .join("");
    el.innerHTML = rows + `<div class="fine">Weight = holding value ÷ total priced value at the last close.</div>`;
  }

  function renderSectorMix(s) {
    const el = document.getElementById("pf-sectors");
    if (!s.priced.length) {
      el.innerHTML = `<div class="empty-note">No priced holdings.</div>`;
      return;
    }
    const bySector = {};
    s.priced.forEach((h) => {
      const sec = h.sector || "Uncategorized";
      bySector[sec] = (bySector[sec] || 0) + h.current_price * h.quantity;
    });
    const entries = Object.entries(bySector).sort((a, b) => b[1] - a[1]);
    const top = entries[0];
    el.innerHTML =
      entries
        .map(([sec, v]) => {
          const w = (v / s.current) * 100;
          return `<div class="alloc-row">
            <span class="ss sec">${sec}</span>
            <span class="alloc-bar"><span style="width:${w.toFixed(1)}%"></span></span>
            <span class="alloc-w mono">${w.toFixed(1)}%</span>
          </div>`;
        })
        .join("") +
      `<div class="fine">${entries.length} sector${entries.length === 1 ? "" : "s"} · largest is ${top[0]} at ${((top[1] / s.current) * 100).toFixed(0)}%. Concentration is shown, not judged.</div>`;
  }

  function holdingCard(h, stock, s, flagDefinitions) {
    const block = document.createElement("div");
    block.className = "pf-block";

    if (h.current_price == null) {
      block.innerHTML = `<div class="pf-row unpriced">
        <div class="pf-main">
          <div class="pf-head"><span class="name">${h.symbol}</span><span class="sector-badge">${h.sector || "—"}</span></div>
          <div class="pf-note">Not priced this run — the pipeline could not fetch it (no NSE symbol token, or the OHLCV fetch failed). Qty ${h.quantity} @ ${U.formatPrice(h.buy_price)}. It is excluded from the totals above rather than counted as zero.</div>
        </div>
      </div>`;
      return block;
    }

    const value = h.current_price * h.quantity;
    const weight = s.current ? (value / s.current) * 100 : 0;
    const invested = h.buy_price * h.quantity;
    const pnlCls = cls(h.pnl ?? 0);
    const ind = stock?.indicators;
    const day = ind && ind.prev_close != null ? ((ind.close - ind.prev_close) / ind.prev_close) * 100 : null;
    const dayCls = day == null ? "flat" : cls(day);
    const flags = h.flags;

    const row = document.createElement("div");
    row.className = "pf-row";
    row.innerHTML = `
      <div class="pf-main">
        <div class="pf-head">
          <span class="name">${h.symbol}</span>
          <span class="sector-badge">${h.sector || "—"}</span>
          ${flags ? `<span class="flag-count ${U.flagCountClass(flags.flag_count, flags.flag_total)}">${flags.flag_count}/${flags.flag_total}</span>` : ""}
          <span class="pf-weight mono" title="Share of portfolio value">${weight.toFixed(1)}%</span>
        </div>
        <div class="pf-metrics mono">
          <span class="m"><span class="mk">Qty</span> ${h.quantity}</span>
          <span class="m"><span class="mk">Avg</span> ${U.formatPrice(h.buy_price)}</span>
          <span class="m"><span class="mk">LTP</span> ${U.formatPrice(h.current_price)}</span>
          <span class="m"><span class="mk">Day</span> <span class="${dayCls}">${day == null ? "—" : `${day >= 0 ? "+" : ""}${day.toFixed(2)}%`}</span></span>
          <span class="m"><span class="mk">Invested</span> ${money(invested)}</span>
          <span class="m"><span class="mk">Value</span> ${money(value)}</span>
        </div>
      </div>
      <div class="pf-pnl">
        <div class="pf-pnl-v mono ${pnlCls}">${signedMoney(h.pnl ?? 0)}</div>
        <div class="pf-pnl-p mono ${pnlCls}">${h.pnl_pct != null ? `${h.pnl_pct >= 0 ? "+" : ""}${h.pnl_pct.toFixed(2)}%` : "—"}</div>
      </div>`;

    block.appendChild(row);
    if (stock) {
      row.classList.add("clickable");
      U.attachRowToggle(block, row, stock, flagDefinitions);
    }
    return block;
  }

  function renderHoldings(holdings, stockBySymbol, s, flagDefinitions) {
    const el = document.getElementById("pf-holdings");
    el.innerHTML = "";
    const sorted = [...holdings].sort((a, b) => {
      const av = a.current_price != null ? a.current_price * a.quantity : -1;
      const bv = b.current_price != null ? b.current_price * b.quantity : -1;
      return bv - av;
    });
    sorted.forEach((h) => el.appendChild(holdingCard(h, stockBySymbol[h.symbol], s, flagDefinitions)));
    document.getElementById("pf-count").textContent = `${holdings.length} holding${holdings.length === 1 ? "" : "s"}`;
  }

  function renderDataNote(s, meta) {
    const el = document.getElementById("pf-data-note");
    if (!s.unpriced.length) {
      el.innerHTML = "";
      return;
    }
    const names = s.unpriced.map((h) => h.symbol).join(", ");
    el.innerHTML = `<div class="callout compact"><b>${s.unpriced.length} holding(s) not priced this run:</b> ${names}.<br>
      Totals, allocation and P&L above cover only the ${s.priced.length} priced holding(s) — nothing is zero-filled or guessed. See the run status on the watchlist page for per-symbol reasons.</div>`;
  }

  async function render() {
    const [meta, flagDefinitions, portfolio] = await Promise.all([
      U.loadMeta(),
      U.loadFlagDefinitions(),
      U.loadPortfolio(),
    ]);

    document.getElementById("last-updated").textContent = `Last run: ${U.formatUpdatedAt(meta.run_at)}`;

    const holdings = portfolio.holdings || [];
    if (!holdings.length) {
      document.getElementById("pf-holdings").innerHTML = `<div class="empty-note">No holdings configured yet — add one via the buttons above.</div>`;
      return;
    }

    // Pull the per-stock files for holdings the pipeline priced, for day change + detail.
    const tracked = holdings.filter((h) => h.current_price != null && meta.symbols[h.symbol]?.status === "ok");
    const stockList = await Promise.all(
      tracked.map((h) => U.loadStock(h.symbol).catch(() => null))
    );
    const stockBySymbol = {};
    stockList.forEach((s) => {
      if (s) stockBySymbol[s.symbol] = s;
    });

    const s = summarise(holdings, stockBySymbol);
    renderSummary(s, holdings);
    renderAllocation(s);
    renderSectorMix(s);
    renderHoldings(holdings, stockBySymbol, s, flagDefinitions);
    renderDataNote(s, meta);
  }

  render().catch((err) => {
    console.error(err);
    document.getElementById("pf-holdings").innerHTML =
      `<div class="empty-note">Failed to load data: ${err.message}. Run the pipeline first (python -m src.pipeline).</div>`;
  });

  U.initRefreshButton(document.getElementById("refresh-btn"), render);
})();
