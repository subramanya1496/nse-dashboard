// Home page (index.html) renderer. All sections are computed from the pipeline's
// published JSON — anything not collected yet renders an explicit note, never a
// fabricated value (CLAUDE.md logging discipline, applied to the UI).
(function () {
  const U = window.dashboardUtils;

  let activeTab = "flags";
  let searchQuery = "";
  let activeFilters = new Set();
  let controlsBound = false;
  let showAllFlat = false;
  const FLAT_LIMIT = 25;

  // ---------- Market strip ----------

  function marketStatusIST() {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const day = ist.getDay();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    if (day === 0 || day === 6) return { label: "Closed · weekend", cls: "closed" };
    if (mins >= 540 && mins < 555) return { label: "Pre-open", cls: "pre" };
    if (mins >= 555 && mins < 930) return { label: "Market open", cls: "open" };
    return { label: "Market closed", cls: "closed" };
  }

  function sparklineSvg(history, cls) {
    if (!Array.isArray(history) || history.length < 2) return "";
    const values = history.map((h) => h.close);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const W = 72, H = 22, pad = 1;
    const pts = values
      .map((v, i) => `${(pad + (i / (values.length - 1)) * (W - 2 * pad)).toFixed(1)},${(pad + (1 - (v - min) / span) * (H - 2 * pad)).toFixed(1)}`)
      .join(" ");
    return `<svg class="spark ${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke-width="1.4" vector-effect="non-scaling-stroke"></polyline></svg>`;
  }

  function renderMarketStrip(market, stocks, meta) {
    const el = document.getElementById("market-strip");
    const parts = [];

    if (market && market.indices && market.indices.length) {
      market.indices.forEach((ix) => {
        const chg = U.formatChangePct(ix.change_pct);
        // VIX rising = fear rising: amber, not teal.
        const isVix = ix.key === "india_vix";
        const chgCls = isVix ? (ix.change_pct > 0 ? "vix-up" : "up") : chg.cls;
        const trendCls = ix.change_pct >= 0 ? (isVix ? "amber" : "teal") : "rose";
        parts.push(`<div class="mi" title="as of ${ix.as_of}">
          <span class="mi-label">${ix.label}</span>
          <span class="mi-value mono">${ix.close.toLocaleString("en-IN")}</span>
          <span class="mi-chg mono ${chgCls}">${chg.text}</span>
          ${sparklineSvg(ix.history, trendCls)}
        </div>`);
      });
    } else {
      parts.push(`<div class="mi mi-note">Index data arrives with the next pipeline run (market.json not published yet)</div>`);
    }

    const adv = stocks.filter((s) => (s.indicators.change_pct ?? 0) > 0).length;
    const dec = stocks.filter((s) => (s.indicators.change_pct ?? 0) < 0).length;
    const flat = stocks.length - adv - dec;
    parts.push(`<div class="mi" title="Advance / decline across the ${stocks.length} tracked watchlist stocks (not exchange-wide)">
      <span class="mi-label">ADV/DEC <span class="mi-sub">watchlist</span></span>
      <span class="mi-value mono"><span class="up">${adv}</span> / <span class="down">${dec}</span>${flat ? ` <span class="flat">/ ${flat}</span>` : ""}</span>
      <span class="ad-bar"><span class="ad-adv" style="width:${stocks.length ? ((adv / stocks.length) * 100).toFixed(0) : 0}%"></span></span>
    </div>`);

    const status = marketStatusIST();
    parts.push(`<div class="mi mi-status">
      <span class="status-dot ${status.cls}"></span><span class="mi-label">${status.label}</span>
      <span class="mi-sub" title="By NSE schedule — trading holidays are not checked">·</span>
      <span class="mi-sub mono">data: ${U.formatUpdatedAt(meta.run_at)}</span>
    </div>`);

    el.innerHTML = parts.join("");
  }

  // ---------- KPI row ----------

  function renderKpis(stocks, sectors, portfolio) {
    const el = document.getElementById("kpi-row");
    const perfect = stocks.filter((s) => s.flags.flag_count === s.flags.flag_total);
    const breakouts = stocks.filter(U.isBreakoutCandidate);
    const accum = stocks.filter(U.isSilentAccumulation);
    const topSector = sectors.length ? sectors[0] : null;

    let pnlHtml = `<div class="kpi-value">—</div><div class="kpi-sub">no holdings configured</div>`;
    if (portfolio.holdings.length) {
      const withPrice = portfolio.holdings.filter((h) => h.current_price != null);
      const invested = withPrice.reduce((s, h) => s + h.buy_price * h.quantity, 0);
      const pnl = withPrice.reduce((s, h) => s + (h.pnl ?? 0), 0);
      const pct = invested ? (pnl / invested) * 100 : 0;
      const cls = pnl > 0 ? "up" : pnl < 0 ? "down" : "flat";
      pnlHtml = `<div class="kpi-value mono ${cls}">${pnl >= 0 ? "+" : "−"}₹${Math.abs(pnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>
        <div class="kpi-sub mono ${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% unrealized</div>`;
    }

    el.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">All 8/8 flags</div>
        <div class="kpi-value mono">${perfect.length}</div>
        <div class="kpi-sub">${perfect.length ? perfect.slice(0, 3).map((s) => s.symbol).join(", ") + (perfect.length > 3 ? "…" : "") : "none today"}</div></div>
      <div class="kpi-card"><div class="kpi-label">Breakout candidates</div>
        <div class="kpi-value mono">${breakouts.length}</div>
        <div class="kpi-sub">above upper band / at 52w high</div></div>
      <div class="kpi-card"><div class="kpi-label">Silent accumulation</div>
        <div class="kpi-value mono">${accum.length}</div>
        <div class="kpi-sub">volume ≥1.4× avg, price flat</div></div>
      <div class="kpi-card"><div class="kpi-label">Strongest sector</div>
        <div class="kpi-value">${topSector ? topSector.sector : "—"}</div>
        <div class="kpi-sub mono">${topSector ? `${topSector.avg_flag_pct}% avg flags · ${topSector.stock_count} stocks` : ""}</div></div>
      <div class="kpi-card"><div class="kpi-label">Portfolio P&L</div>${pnlHtml}</div>`;
  }

  // ---------- Sector heatmap ----------

  function heatClass(pct) {
    if (pct >= 75) return "h-strong2";
    if (pct >= 62.5) return "h-strong";
    if (pct >= 50) return "h-mid2";
    if (pct >= 37.5) return "h-mid";
    if (pct >= 25) return "h-weak";
    return "h-weak2";
  }

  function renderHeatmap(sectors) {
    const el = document.getElementById("sector-heatmap-grid");
    if (!sectors.length) {
      el.innerHTML = `<div class="empty-note">No sector data yet.</div>`;
      return;
    }
    el.innerHTML = sectors
      .map(
        (s) => `<button class="heat-cell ${heatClass(s.avg_flag_pct)}" data-sector="${s.sector}" title="Filter watchlist to ${s.sector}">
          <span class="heat-name">${s.sector}</span>
          <span class="heat-pct mono">${s.avg_flag_pct}%</span>
          <span class="heat-count mono">${s.stock_count} stk</span>
        </button>`
      )
      .join("");
    el.querySelectorAll(".heat-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        const search = document.getElementById("stock-search");
        search.value = searchQuery === cell.dataset.sector ? "" : cell.dataset.sector;
        search.dispatchEvent(new Event("input"));
        document.getElementById("watchlist-card").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  // ---------- Opportunities ----------

  function renderOpportunities(stocks, flagDefinitions) {
    const el = document.getElementById("opportunities-list");
    const top = [...stocks].sort((a, b) => b.flags.flag_count - a.flags.flag_count).slice(0, 5);
    if (!top.length) {
      el.innerHTML = `<div class="empty-note">No stock data this run.</div>`;
      return;
    }
    el.innerHTML = "";
    top.forEach((stock, i) => {
      const exp = U.buildExplanation(stock, flagDefinitions);
      const chg = U.formatChangePct(stock.indicators.change_pct);
      const wrap = document.createElement("div");
      wrap.className = "opp-block";
      wrap.innerHTML = `
        <div class="opp-row">
          <div class="rank">${i + 1}</div>
          <div class="opp-main">
            <div class="opp-head">
              <span class="name">${stock.symbol}</span>
              <span class="sector-badge">${stock.sector || "—"}</span>
              <span class="flag-count ${U.flagCountClass(stock.flags.flag_count, stock.flags.flag_total)}">${stock.flags.flag_count}/${stock.flags.flag_total}</span>
              <span class="opp-price mono">${U.formatPrice(stock.indicators.close)} <span class="chg ${chg.cls}">${chg.text}</span></span>
            </div>
            <div class="opp-summary">${exp.summary}</div>
            ${exp.highlights.map((h) => `<div class="exp-highlight">▸ ${h}</div>`).join("")}
          </div>
          <span class="opp-toggle" aria-hidden="true">▾</span>
        </div>`;
      const detail = document.createElement("div");
      detail.className = "opp-detail";
      detail.hidden = true;
      detail.innerHTML = `<div class="exp-risks"><span class="exp-risk-title">Risks to watch</span>
          ${exp.risks.map((r) => `<div class="exp-risk">⚠ ${r}</div>`).join("")}</div>
        <div class="exp-note">Rule-based explanation generated from the flags — not a recommendation. Claude AI wording arrives in Phase 3.</div>`;
      wrap.appendChild(detail);
      wrap.querySelector(".opp-row").addEventListener("click", () => {
        detail.hidden = !detail.hidden;
        wrap.classList.toggle("open", !detail.hidden);
      });
      el.appendChild(wrap);
    });
  }

  // ---------- Breadth ----------

  function renderBreadth(stocks) {
    const el = document.getElementById("breadth-widgets");
    const total = stocks.length || 1;
    const above200 = stocks.filter((s) => s.indicators.ema200 != null && s.indicators.close > s.indicators.ema200).length;
    const high52 = stocks.filter((s) => s.indicators.high_52w != null && s.indicators.close >= 0.998 * s.indicators.high_52w);
    const low52 = stocks.filter((s) => s.indicators.low_52w != null && s.indicators.close <= 1.002 * s.indicators.low_52w);
    const breakouts = stocks.filter(U.isBreakoutCandidate).length;
    const adv = stocks.filter((s) => (s.indicators.change_pct ?? 0) > 0).length;
    const dec = stocks.filter((s) => (s.indicators.change_pct ?? 0) < 0).length;
    const adRatio = dec ? (adv / dec).toFixed(2) : adv ? "∞" : "—";

    const bar = (n) => `<span class="breadth-bar"><span style="width:${((n / total) * 100).toFixed(0)}%"></span></span>`;
    el.innerHTML = `
      <div class="breadth-item"><span class="bk">Above EMA200</span><span class="bv mono">${above200}/${stocks.length}</span>${bar(above200)}</div>
      <div class="breadth-item"><span class="bk">New 52w highs</span><span class="bv mono up">${high52.length}</span><span class="bnames">${high52.slice(0, 4).map((s) => s.symbol).join(" · ")}</span></div>
      <div class="breadth-item"><span class="bk">New 52w lows</span><span class="bv mono down">${low52.length}</span><span class="bnames">${low52.slice(0, 4).map((s) => s.symbol).join(" · ")}</span></div>
      <div class="breadth-item"><span class="bk">Breakout setups</span><span class="bv mono">${breakouts}</span>${bar(breakouts)}</div>
      <div class="breadth-item"><span class="bk">A/D ratio</span><span class="bv mono">${adRatio}</span><span class="bnames">${adv} adv · ${dec} dec (watchlist)</span></div>`;
  }

  // ---------- Screens ----------

  const SCREENS = [
    {
      id: "trending", title: "Trending today", hint: "largest absolute % moves",
      pick: (stocks) => [...stocks].sort((a, b) => Math.abs(b.indicators.change_pct ?? 0) - Math.abs(a.indicators.change_pct ?? 0)).slice(0, 5),
      stat: (s) => null,
    },
    {
      id: "accum", title: "Silent accumulation", hint: "volume ≥1.4× avg, price flat",
      pick: (stocks) => stocks.filter(U.isSilentAccumulation).sort((a, b) => (U.volumeRatio(b.indicators) ?? 0) - (U.volumeRatio(a.indicators) ?? 0)).slice(0, 5),
      stat: (s) => `${(U.volumeRatio(s.indicators) ?? 0).toFixed(1)}× vol`,
    },
    {
      id: "buyzone", title: "Near buy zone", hint: "uptrend, pulled back to EMA20/50",
      pick: (stocks) => stocks.filter(U.isNearBuyZone).sort((a, b) => b.flags.flag_count - a.flags.flag_count).slice(0, 5),
      stat: (s) => `${s.flags.flag_count}/${s.flags.flag_total} flags`,
    },
    {
      id: "breakout", title: "Breakout candidates", hint: "above upper band / at 52w high",
      pick: (stocks) => stocks.filter(U.isBreakoutCandidate).sort((a, b) => (b.indicators.change_pct ?? 0) - (a.indicators.change_pct ?? 0)).slice(0, 5),
      stat: (s) => s.indicators.high_52w != null && s.indicators.close >= 0.995 * s.indicators.high_52w ? "at 52w high" : "above BB",
    },
    {
      id: "highvol", title: "High volume movers", hint: "volume vs 20-day average",
      pick: (stocks) => stocks.filter((s) => (U.volumeRatio(s.indicators) ?? 0) >= 1.5).sort((a, b) => (U.volumeRatio(b.indicators) ?? 0) - (U.volumeRatio(a.indicators) ?? 0)).slice(0, 5),
      stat: (s) => `${(U.volumeRatio(s.indicators) ?? 0).toFixed(1)}× vol`,
    },
    {
      id: "weakening", title: "Recently weakening", hint: "uptrend intact, short-term cracks",
      pick: (stocks) => stocks.filter(U.isWeakening).sort((a, b) => (a.indicators.change_pct ?? 0) - (b.indicators.change_pct ?? 0)).slice(0, 5),
      stat: (s) => {
        const r5 = U.returnOverSessions(s, 5);
        return r5 !== null ? `${r5.toFixed(1)}% / 5d` : "below EMA20";
      },
    },
  ];

  function renderScreens(stocks) {
    const el = document.getElementById("screens-grid");
    el.innerHTML = SCREENS.map((screen) => {
      const picks = screen.pick(stocks);
      const rows = picks.length
        ? picks.map((s) => {
            const chg = U.formatChangePct(s.indicators.change_pct);
            const stat = screen.stat(s);
            return `<button class="screen-row" data-symbol="${s.symbol}" title="Show ${s.symbol} in the watchlist">
              <span class="ss">${s.symbol}</span>
              ${stat ? `<span class="sstat mono">${stat}</span>` : ""}
              <span class="schg mono ${chg.cls}">${chg.text}</span>
            </button>`;
          }).join("")
        : `<div class="empty-note sm">No stocks match this screen today.</div>`;
      return `<div class="screen-card">
        <div class="screen-head"><h4>${screen.title}</h4><span class="screen-hint">${screen.hint}</span></div>
        ${rows}
      </div>`;
    }).join("");

    el.querySelectorAll(".screen-row").forEach((row) => {
      row.addEventListener("click", () => {
        const search = document.getElementById("stock-search");
        search.value = row.dataset.symbol;
        search.dispatchEvent(new Event("input"));
        document.getElementById("watchlist-card").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  // ---------- Filters ----------

  function buildFilterDefs(sectors) {
    const strongSectors = new Set(sectors.filter((s) => s.avg_flag_pct >= 62.5).map((s) => s.sector));
    return [
      { key: "buyzone", label: "Only buy zone", fn: (s) => U.isNearBuyZone(s), needsData: null },
      { key: "highroe", label: "High ROE ≥15%", fn: (s) => s.fundamentals?.roe != null && s.fundamentals.roe >= 0.15, needsData: (s) => s.fundamentals?.roe != null },
      { key: "lowdebt", label: "Low debt <1×", fn: (s) => { const d = U.debtToEquityRatio(s.fundamentals); return d !== null && d < 1; }, needsData: (s) => U.debtToEquityRatio(s.fundamentals) !== null },
      { key: "strongsector", label: "Strong sectors", fn: (s) => strongSectors.has(s.sector), needsData: null },
      { key: "dividend", label: "Dividend ≥1%", fn: (s) => { const y = U.dividendYieldPct(s.fundamentals); return y !== null && y >= 1; }, needsData: (s) => U.dividendYieldPct(s.fundamentals) !== null },
      { key: "breakout", label: "Breakouts", fn: (s) => U.isBreakoutCandidate(s), needsData: null },
    ];
  }

  function renderFilterChips(filterDefs, stocks, onChange) {
    const el = document.getElementById("filter-chips");
    el.innerHTML = filterDefs
      .map((f) => {
        const count = stocks.filter(f.fn).length;
        return `<button class="filter-chip ${activeFilters.has(f.key) ? "active" : ""}" data-key="${f.key}">${f.label} <span class="mono">${count}</span></button>`;
      })
      .join("");
    el.querySelectorAll(".filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const key = chip.dataset.key;
        if (activeFilters.has(key)) activeFilters.delete(key);
        else activeFilters.add(key);
        chip.classList.toggle("active", activeFilters.has(key));
        onChange();
      });
    });
  }

  // ---------- Right rail sections ----------

  function renderInstitutional(stocks) {
    const el = document.getElementById("institutional-body");
    const withData = stocks.filter((s) => s.shareholding);
    if (!withData.length) {
      el.innerHTML = `<div class="empty-note">Promoter / FII / DII changes not available this run — the NSE shareholding source has been blocking automated requests (each skip is logged by the pipeline). This section fills in automatically when the source responds.</div>`;
      return;
    }
    const fmt = (v) => {
      if (v === null || v === undefined) return `<span class="flat">—</span>`;
      const cls = v > 0 ? "up" : v < 0 ? "down" : "flat";
      return `<span class="${cls} mono">${v > 0 ? "+" : ""}${v}%</span>`;
    };
    el.innerHTML = `<div class="inst-head"><span></span><span>Prom</span><span>FII</span><span>DII</span></div>` +
      withData.slice(0, 12).map((s) => `<div class="inst-row"><span class="ss">${s.symbol}</span>
        ${fmt(s.shareholding.promoter_holding_change_pct)}${fmt(s.shareholding.fii_holding_change_pct)}${fmt(s.shareholding.dii_holding_change_pct)}</div>`).join("");
  }

  function renderEvents(stocks) {
    const el = document.getElementById("events-body");
    const today = new Date();
    const horizon = new Date(today.getTime() + 60 * 24 * 3600 * 1000);
    const items = [];
    stocks.forEach((s) => {
      const ev = s.events;
      if (!ev) return;
      (ev.earnings_dates || []).forEach((d) => items.push({ symbol: s.symbol, type: "Earnings", date: d }));
      if (ev.ex_dividend_date) items.push({ symbol: s.symbol, type: "Ex-dividend", date: ev.ex_dividend_date });
      if (ev.dividend_date) items.push({ symbol: s.symbol, type: "Dividend pay", date: ev.dividend_date });
    });
    const upcoming = items
      .map((i) => ({ ...i, d: new Date(i.date) }))
      .filter((i) => !isNaN(i.d) && i.d >= new Date(today.toDateString()) && i.d <= horizon)
      .sort((a, b) => a.d - b.d);

    if (!upcoming.length) {
      const collected = stocks.some((s) => s.events);
      el.innerHTML = `<div class="empty-note">${collected
        ? "No earnings or dividend dates within the next 60 days."
        : "Event dates (earnings, dividends) start populating as the fundamentals cache refreshes over the next pipeline runs."}
        <br><span class="fine">Bonus/split announcements are not in the current free feed — planned via the NSE corporate-actions source.</span></div>`;
      return;
    }
    el.innerHTML = upcoming.slice(0, 12).map((i) => `<div class="event-row">
        <span class="event-date mono">${U.formatEventDate(i.date)}</span>
        <span class="ss">${i.symbol}</span>
        <span class="event-type">${i.type}</span>
      </div>`).join("") +
      `<div class="fine">Yahoo calendar dates · bonus/split feed not covered yet.</div>`;
  }

  function renderNews(news) {
    const el = document.getElementById("news-body");
    if (!news || !news.items || !news.items.length) {
      el.innerHTML = `<div class="empty-note">News arrives with the next pipeline run (news.json not published yet).</div>`;
      return;
    }
    const badge = (s) => {
      const cls = s === "positive" ? "pos" : s === "negative" ? "neg" : "neu";
      return `<span class="senti ${cls}">${s}</span>`;
    };
    el.innerHTML = news.items.slice(0, 10).map((item) => `
      <a class="news-row" href="${item.link || "#"}" target="_blank" rel="noopener">
        <div class="news-top">${badge(item.sentiment)}<span class="ss">${item.symbol}</span>
          <span class="news-src">${item.publisher || ""}</span></div>
        <div class="news-title">${item.title}</div>
      </a>`).join("") +
      `<div class="fine">Sentiment is keyword-based (labelled in the data) — not an AI judgment. Headlines cover holdings + top flag-count names.</div>`;
  }

  function renderPortfolioAnalytics(portfolio, stocksBySymbol) {
    const el = document.getElementById("portfolio-analytics-body");
    const holdings = portfolio.holdings.filter((h) => h.current_price != null);
    if (!portfolio.holdings.length) {
      el.innerHTML = `<div class="empty-note">No holdings configured yet — add one via the Manage card.</div>`;
      return;
    }
    if (!holdings.length) {
      el.innerHTML = `<div class="empty-note">Holdings exist but no price data joined this cycle (see run status).</div>`;
      return;
    }
    const value = (h) => h.current_price * h.quantity;
    const invested = holdings.reduce((s, h) => s + h.buy_price * h.quantity, 0);
    const current = holdings.reduce((s, h) => s + value(h), 0);
    const pnl = current - invested;
    const pnlCls = pnl > 0 ? "up" : pnl < 0 ? "down" : "flat";

    const rows = holdings.map((h) => {
      const alloc = (value(h) / current) * 100;
      const days = (Date.now() - new Date(h.buy_date).getTime()) / (24 * 3600 * 1000);
      let cagr = "—";
      if (days >= 90 && h.buy_price > 0) {
        const c = (Math.pow(h.current_price / h.buy_price, 365 / days) - 1) * 100;
        cagr = `${c >= 0 ? "+" : ""}${c.toFixed(1)}%`;
      } else if (days < 90) {
        cagr = "held <3mo";
      }
      const cls = (h.pnl ?? 0) > 0 ? "up" : (h.pnl ?? 0) < 0 ? "down" : "flat";
      return `<div class="pa-row">
        <span class="ss">${h.symbol}</span>
        <span class="pa-alloc"><span class="pa-alloc-bar"><span style="width:${alloc.toFixed(0)}%"></span></span><span class="mono">${alloc.toFixed(0)}%</span></span>
        <span class="mono ${cls}">${h.pnl_pct != null ? `${h.pnl_pct >= 0 ? "+" : ""}${h.pnl_pct.toFixed(1)}%` : "—"}</span>
        <span class="mono pa-cagr" title="Annualized (CAGR) — only shown after 3 months held">${cagr}</span>
      </div>`;
    }).join("");

    const sectorCounts = {};
    holdings.forEach((h) => { const sec = h.sector || "Unknown"; sectorCounts[sec] = (sectorCounts[sec] || 0) + value(h); });
    const sectorHtml = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1])
      .map(([sec, v]) => `<span class="sector-badge">${sec} <span class="mono">${((v / current) * 100).toFixed(0)}%</span></span>`).join(" ");

    let divHtml;
    const withYield = holdings.filter((h) => U.dividendYieldPct(stocksBySymbol[h.symbol]?.fundamentals) !== null);
    if (withYield.length) {
      const income = withYield.reduce((s, h) => s + value(h) * (U.dividendYieldPct(stocksBySymbol[h.symbol].fundamentals) / 100), 0);
      const missing = holdings.length - withYield.length;
      divHtml = `≈ ₹${income.toLocaleString("en-IN", { maximumFractionDigits: 0 })}/yr <span class="fine">est. from current yields${missing ? ` · ${missing} holding(s) missing yield data` : ""}</span>`;
    } else {
      divHtml = `<span class="empty-note sm">yield data not collected yet — populates with the next fundamentals refresh</span>`;
    }

    el.innerHTML = `
      <div class="pa-summary">
        <div class="pa-stat"><span class="k">Invested</span><span class="v mono">₹${invested.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span></div>
        <div class="pa-stat"><span class="k">Value</span><span class="v mono">₹${current.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span></div>
        <div class="pa-stat"><span class="k">Unrealized</span><span class="v mono ${pnlCls}">${pnl >= 0 ? "+" : "−"}₹${Math.abs(pnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span></div>
      </div>
      <div class="pa-head"><span></span><span>Alloc</span><span>P&L</span><span>CAGR</span></div>
      ${rows}
      <div class="pa-block"><span class="k">Sector mix</span> ${sectorHtml}</div>
      <div class="pa-block"><span class="k">Dividend income</span> ${divHtml}</div>`;
  }

  function renderRunStatus(meta) {
    const el = document.getElementById("run-status");
    if (meta.summary.skipped > 0) {
      const skippedSymbols = Object.entries(meta.symbols)
        .filter(([, info]) => info.status !== "ok")
        .map(([symbol, info]) => `${symbol} (${info.reason})`);
      el.innerHTML = `<div class="callout compact"><b>${meta.summary.skipped} skipped this run:</b><br>${skippedSymbols.join("<br>")}</div>`;
    } else {
      el.textContent = `All ${meta.summary.total} tracked symbols updated successfully.`;
    }
  }

  // ---------- Watchlist ----------

  function setupWatchlist(stocks, flagDefinitions, filterDefs) {
    const listEl = document.getElementById("stock-list");
    const countEl = document.getElementById("stock-count");
    const noteEl = document.getElementById("filter-note");

    const favoriteOptions = {
      onFavoriteToggle: () => {
        if (activeTab === "favorites") renderTab(activeTab);
      },
    };

    function applyFilters(base) {
      let matched = base;
      let missingData = 0;
      activeFilters.forEach((key) => {
        const def = filterDefs.find((f) => f.key === key);
        if (!def) return;
        if (def.needsData) missingData += matched.filter((s) => !def.needsData(s)).length;
        matched = matched.filter(def.fn);
      });
      return { matched, missingData };
    }

    function renderTab(tab) {
      activeTab = tab;
      const base = tab === "favorites" ? U.filterFavorites(stocks) : stocks;
      const searched = U.filterStocksByQuery(base, searchQuery);
      const { matched, missingData } = applyFilters(searched);

      noteEl.textContent = activeFilters.size && missingData
        ? `${missingData} stock(s) excluded from an active filter because the required fundamentals field isn't collected for them yet.`
        : "";

      const totalLabel = tab === "favorites" ? `${base.length} favorites` : `${stocks.length} tracked`;
      countEl.textContent = searchQuery || activeFilters.size ? `${matched.length} of ${totalLabel}` : totalLabel;

      if (!matched.length) {
        listEl.innerHTML = tab === "favorites" && !searchQuery && !activeFilters.size
          ? `<div class="empty-note">No favorites yet — click the ☆ on any stock to add one.</div>`
          : `<div class="empty-note">No stocks match the current search/filters.</div>`;
        return;
      }

      if (tab === "sector") {
        U.renderSectorGroupsInto(listEl, matched, flagDefinitions, { forceExpand: !!(searchQuery || activeFilters.size), ...favoriteOptions });
        return;
      }

      const sorted = tab === "trending"
        ? [...matched].sort((a, b) => Math.abs(b.indicators.change_pct ?? 0) - Math.abs(a.indicators.change_pct ?? 0))
        : [...matched].sort((a, b) => b.flags.flag_count - a.flags.flag_count);

      const visible = showAllFlat ? sorted : sorted.slice(0, FLAT_LIMIT);
      U.renderStockListInto(listEl, visible, flagDefinitions, favoriteOptions);

      if (sorted.length > FLAT_LIMIT) {
        const row = document.createElement("div");
        row.className = "show-more-row";
        const btn = document.createElement("button");
        btn.className = "btn btn-ghost btn-sm";
        btn.textContent = showAllFlat ? "Show top 25 only" : `Show all ${sorted.length} stocks`;
        btn.addEventListener("click", () => {
          showAllFlat = !showAllFlat;
          renderTab(activeTab);
        });
        row.appendChild(btn);
        listEl.appendChild(row);
      }
    }

    renderFilterChips(filterDefs, stocks, () => {
      showAllFlat = false;
      renderTab(activeTab);
    });

    renderTab(activeTab);

    if (!controlsBound) {
      U.initTabs(document.getElementById("watchlist-tabs"), (tab) => {
        showAllFlat = false;
        renderTab(tab);
      });
      const searchEl = document.getElementById("stock-search");
      searchEl.value = searchQuery;
      searchEl.addEventListener("input", () => {
        searchQuery = searchEl.value.trim();
        showAllFlat = false;
        renderTab(activeTab);
      });
      controlsBound = true;
    }
  }

  // ---------- Boot ----------

  async function render() {
    const [meta, flagDefinitions] = await Promise.all([U.loadMeta(), U.loadFlagDefinitions()]);
    const [stocks, sectors, portfolio, market, news] = await Promise.all([
      U.loadAllStocks(meta),
      U.loadSectors(),
      U.loadPortfolio(),
      U.loadMarket(),
      U.loadNews(),
    ]);
    const stocksBySymbol = Object.fromEntries(stocks.map((s) => [s.symbol, s]));

    renderMarketStrip(market, stocks, meta);
    renderKpis(stocks, sectors, portfolio);
    renderHeatmap(sectors);
    renderOpportunities(stocks, flagDefinitions);
    renderBreadth(stocks);
    renderScreens(stocks);
    renderInstitutional(stocks);
    renderEvents(stocks);
    renderNews(news);
    renderPortfolioAnalytics(portfolio, stocksBySymbol);
    renderRunStatus(meta);

    const filterDefs = buildFilterDefs(sectors);
    setupWatchlist(stocks, flagDefinitions, filterDefs);
  }

  render().catch((err) => {
    console.error(err);
    document.getElementById("stock-list").innerHTML =
      `<div class="empty-note">Failed to load data: ${err.message}. Run the pipeline first (python -m src.pipeline).</div>`;
  });

  window.dashboardUtils.initRefreshButton(document.getElementById("refresh-btn"), render);
})();
