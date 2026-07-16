// Home page (index.html) renderer. All sections are computed from the pipeline's
// published JSON — anything not collected yet renders an explicit note, never a
// fabricated value (CLAUDE.md logging discipline, applied to the UI).
(function () {
  const U = window.dashboardUtils;

  let activeTab = "flags";
  let searchQuery = "";
  let controlsBound = false;
  let showAllFlat = false;
  const FLAT_LIMIT = 25;

  // Selected filters survive reloads (UX: "remember selected filters").
  const FILTERS_KEY = "nse-dashboard-filters";
  let activeFilters = new Set();
  try {
    activeFilters = new Set(JSON.parse(localStorage.getItem(FILTERS_KEY) || "[]"));
  } catch { /* corrupt storage -> start clean */ }
  function persistFilters() {
    localStorage.setItem(FILTERS_KEY, JSON.stringify([...activeFilters]));
  }

  // Collapsible panels, with the collapsed set remembered per browser.
  const COLLAPSED_KEY = "nse-dashboard-collapsed";
  function setupCollapsibles() {
    let collapsed;
    try {
      collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]"));
    } catch {
      collapsed = new Set();
    }
    document.querySelectorAll("[data-collapse-id]").forEach((panel) => {
      const id = panel.dataset.collapseId;
      const head = panel.querySelector(".panel-head, .card-head-row");
      if (!head || head.querySelector(".collapse-btn")) return;
      const btn = document.createElement("button");
      btn.className = "collapse-btn";
      btn.setAttribute("aria-label", "Collapse section");
      const apply = () => {
        const isCollapsed = collapsed.has(id);
        panel.classList.toggle("collapsed", isCollapsed);
        btn.textContent = isCollapsed ? "+" : "–";
        btn.title = isCollapsed ? "Expand section" : "Collapse section";
      };
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
        apply();
      });
      head.appendChild(btn);
      apply();
    });
  }

  // Keyboard: "/" focuses search from anywhere; Escape clears it.
  function setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        document.getElementById("global-search").focus();
      } else if (e.key === "Escape" && typing && document.activeElement.type === "search") {
        document.activeElement.value = "";
        document.activeElement.dispatchEvent(new Event("input", { bubbles: true }));
        document.activeElement.blur();
      }
    });
  }

  // ---------- Market strip ----------

  // How old the published data is. The dashboard is not a live ticker — prices only move
  // when the pipeline runs — so the age is always shown, and flagged once it is old enough
  // to mean a scheduled run was missed or delayed (rather than quietly looking current).
  function relativeAge(iso) {
    const then = new Date(iso).getTime();
    if (isNaN(then)) return { text: "age unknown", stale: true };
    const mins = (Date.now() - then) / 60000;
    if (mins < 1) return { text: "just now", stale: false };
    if (mins < 60) return { text: `${Math.round(mins)}m ago`, stale: false };
    const hrs = mins / 60;
    if (hrs < 24) return { text: `${Math.round(hrs)}h ago`, stale: false };
    const days = hrs / 24;
    // Over a weekend/holiday a 1–3 day gap is expected; beyond that something is wrong.
    return { text: `${Math.round(days)}d ago`, stale: days >= 3 };
  }

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
    const age = relativeAge(meta.run_at);
    parts.push(`<div class="mi mi-status">
      <span class="status-dot ${status.cls}"></span><span class="mi-label">${status.label}</span>
      <span class="mi-sub" title="By NSE schedule — trading holidays are not checked">·</span>
      <span class="mi-sub mono ${age.stale ? "stale" : ""}" title="When the pipeline last published data (IST). Prices only change when the pipeline runs — they are not live ticks.">
        data: ${U.formatUpdatedAt(meta.run_at)} · ${age.text}${age.stale ? " ⚠" : ""}
      </span>
    </div>`);

    el.innerHTML = parts.join("");
  }

  // ---------- KPI row ----------

  function jumpToWatchlist(query) {
    const search = document.getElementById("stock-search");
    search.value = query;
    search.dispatchEvent(new Event("input"));
    document.getElementById("watchlist-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // A clickable list of stocks used inside the KPI detail drawer. statFn adds a
  // per-row metric (e.g. volume ratio); each row jumps to that stock in the watchlist.
  function kpiStockRows(list, statFn) {
    if (!list.length) return `<div class="empty-note sm">Nothing matches this right now.</div>`;
    return list
      .map((s) => {
        const chg = U.formatChangePct(s.indicators.change_pct);
        const stat = statFn ? statFn(s) : null;
        return `<button class="kpi-stock-row" data-symbol="${s.symbol}" title="Show ${s.symbol} in the watchlist">
          <span class="ss">${s.symbol}</span>
          <span class="sector-badge">${s.sector || "—"}</span>
          <span class="flag-count ${U.flagCountClass(s.flags.flag_count, s.flags.flag_total)}">${s.flags.flag_count}/${s.flags.flag_total}</span>
          ${stat ? `<span class="kstat mono">${stat}</span>` : ""}
          <span class="kprice mono">${U.formatPrice(s.indicators.close)} <span class="chg ${chg.cls}">${chg.text}</span></span>
        </button>`;
      })
      .join("");
  }

  function renderKpis(stocks, sectors, portfolio) {
    const el = document.getElementById("kpi-row");
    const byChangeDesc = (a, b) => (b.indicators.change_pct ?? 0) - (a.indicators.change_pct ?? 0);
    const perfect = [...stocks].filter((s) => s.flags.flag_count === s.flags.flag_total).sort(byChangeDesc);
    const breakouts = [...stocks].filter(U.isBreakoutCandidate).sort(byChangeDesc);
    const accum = [...stocks].filter(U.isSilentAccumulation).sort((a, b) => (U.volumeRatio(b.indicators) ?? 0) - (U.volumeRatio(a.indicators) ?? 0));
    const topSector = sectors.length ? sectors[0] : null;
    const sectorStocks = topSector
      ? [...stocks].filter((s) => s.sector === topSector.sector).sort((a, b) => b.flags.flag_count - a.flags.flag_count)
      : [];

    // Portfolio rollup (drives both the P&L card and its detail).
    const holdings = portfolio.holdings || [];
    const priced = holdings.filter((h) => h.current_price != null);
    const invested = priced.reduce((s, h) => s + h.buy_price * h.quantity, 0);
    const pnl = priced.reduce((s, h) => s + (h.pnl ?? 0), 0);
    const pnlPct = invested ? (pnl / invested) * 100 : 0;
    const pnlCls = pnl > 0 ? "up" : pnl < 0 ? "down" : "flat";

    const cards = [
      {
        key: "perfect",
        label: "All 8/8 flags",
        valueHtml: `<div class="kpi-value mono">${perfect.length}</div>`,
        sub: perfect.length ? "all 8 bullish conditions met" : "none today",
        detail: () => ({
          title: `Stocks with all 8/8 bullish flags (${perfect.length})`,
          body: kpiStockRows(perfect),
        }),
      },
      {
        key: "breakouts",
        label: "Breakout candidates",
        valueHtml: `<div class="kpi-value mono">${breakouts.length}</div>`,
        sub: "above upper band / at 52w high",
        detail: () => ({
          title: `Breakout candidates (${breakouts.length})`,
          body: kpiStockRows(breakouts, (s) =>
            s.indicators.high_52w != null && s.indicators.close >= 0.995 * s.indicators.high_52w ? "at 52w high" : "above BB"
          ),
        }),
      },
      {
        key: "accum",
        label: "Silent accumulation",
        valueHtml: `<div class="kpi-value mono">${accum.length}</div>`,
        sub: "volume ≥1.4× avg, price flat",
        detail: () => ({
          title: `Silent accumulation (${accum.length})`,
          body: kpiStockRows(accum, (s) => `${(U.volumeRatio(s.indicators) ?? 0).toFixed(1)}× vol`),
        }),
      },
      {
        key: "sector",
        label: "Strongest sector",
        valueHtml: `<div class="kpi-value">${topSector ? topSector.sector : "—"}</div>`,
        sub: topSector ? `${topSector.avg_flag_pct}% avg flags · ${topSector.stock_count} stocks` : "",
        detail: () => ({
          title: topSector ? `${topSector.sector} — strongest sector (${topSector.avg_flag_pct}% avg flags)` : "No sector data",
          body: kpiStockRows(sectorStocks),
        }),
      },
      {
        key: "pnl",
        label: "Portfolio P&L",
        valueHtml: holdings.length
          ? `<div class="kpi-value mono ${pnlCls}">${pnl >= 0 ? "+" : "−"}₹${Math.abs(pnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>`
          : `<div class="kpi-value">—</div>`,
        sub: holdings.length
          ? `<span class="${pnlCls}">${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% unrealized</span>`
          : "no holdings configured",
        detail: () => ({
          title: `Portfolio — unrealized P&L`,
          body: holdings.length ? portfolioDetailRows(holdings, priced, invested, pnl, pnlPct, pnlCls) : `<div class="empty-note sm">No holdings configured yet — add one via the Manage card.</div>`,
        }),
      },
    ];

    el.innerHTML = cards
      .map(
        (c) => `<button class="kpi-card" data-kpi="${c.key}">
          <div class="kpi-label">${c.label}</div>
          ${c.valueHtml}
          <div class="kpi-sub">${c.sub}</div>
          <span class="kpi-expand">details ▾</span>
        </button>`
      )
      .join("");

    // One shared detail drawer beneath the KPI row.
    let drawer = document.getElementById("kpi-detail");
    if (!drawer) {
      drawer = document.createElement("section");
      drawer.id = "kpi-detail";
      drawer.className = "kpi-detail panel";
      drawer.hidden = true;
      el.after(drawer);
    }
    let openKey = null;

    function closeDrawer() {
      drawer.hidden = true;
      openKey = null;
      el.querySelectorAll(".kpi-card").forEach((c) => c.classList.remove("active"));
    }

    el.querySelectorAll(".kpi-card").forEach((card) => {
      card.addEventListener("click", () => {
        const key = card.dataset.kpi;
        if (openKey === key) {
          closeDrawer();
          return;
        }
        const cfg = cards.find((c) => c.key === key);
        const { title, body } = cfg.detail();
        drawer.innerHTML = `<div class="kpi-detail-head"><h3>${title}</h3><button class="kpi-detail-close" aria-label="Close">✕</button></div><div class="kpi-detail-body">${body}</div>`;
        drawer.hidden = false;
        openKey = key;
        el.querySelectorAll(".kpi-card").forEach((c) => c.classList.toggle("active", c === card));

        drawer.querySelector(".kpi-detail-close").addEventListener("click", closeDrawer);
        drawer.querySelectorAll(".kpi-stock-row").forEach((row) => {
          row.addEventListener("click", () => jumpToWatchlist(row.dataset.symbol));
        });
        const link = drawer.querySelector(".kpi-portfolio-link");
        if (link) link.addEventListener("click", (e) => { e.stopPropagation(); });
        drawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  function portfolioDetailRows(holdings, priced, invested, pnl, pnlPct, pnlCls) {
    const rows = holdings
      .map((h) => {
        if (h.current_price == null) {
          return `<div class="kpi-holding-row"><span class="ss">${h.symbol}</span><span class="kh-note">no data this cycle (untracked / suspended symbol)</span></div>`;
        }
        const cls = (h.pnl ?? 0) > 0 ? "up" : (h.pnl ?? 0) < 0 ? "down" : "flat";
        const value = h.current_price * h.quantity;
        return `<button class="kpi-holding-row" data-symbol="${h.symbol}" title="Show ${h.symbol} in the watchlist">
          <span class="ss">${h.symbol}</span>
          <span class="kh-qty mono">${h.quantity} @ ${U.formatPrice(h.buy_price)}</span>
          <span class="kh-val mono">${U.formatPrice(value)}</span>
          <span class="mono ${cls}">${h.pnl_pct != null ? `${h.pnl_pct >= 0 ? "+" : ""}${h.pnl_pct.toFixed(1)}%` : "—"}</span>
          <span class="mono ${cls}">${(h.pnl ?? 0) >= 0 ? "+" : "−"}₹${Math.abs(h.pnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
        </button>`;
      })
      .join("");
    return `<div class="kpi-holding-head"><span></span><span>Qty @ cost</span><span>Value</span><span>P&L%</span><span>P&L</span></div>
      ${rows}
      <div class="kpi-portfolio-total">Invested ₹${invested.toLocaleString("en-IN", { maximumFractionDigits: 0 })} · <span class="${pnlCls}">${pnl >= 0 ? "+" : "−"}₹${Math.abs(pnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)</span></div>
      <a class="btn btn-primary btn-sm kpi-portfolio-link" href="portfolio.html">Open full portfolio →</a>`;
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

  // ---------- Keep an eye on ----------
  // Transparent conditions only, exactly like the screens: a stock qualifies because a
  // named boolean fired, and we show the levels its own price history has established.
  // The dashboard still never says buy or sell — it shows where price has turned before
  // and how far away those levels are, and the user decides. (CLAUDE.md hard rule.)

  function keepAnEyeReasons(stock) {
    const reasons = [];
    if (U.isNearBuyZone(stock)) reasons.push("Uptrend (EMA50 &gt; EMA200), pulled back to its EMA20/50 zone");
    if (U.isBreakoutCandidate(stock)) reasons.push("Pressing the upper Bollinger band / 52-week high");
    if (U.isSilentAccumulation(stock)) reasons.push("Volume ≥1.4× average while price stayed flat");
    return reasons;
  }

  function levelPill(label, value, fromClose, cls) {
    const dist = fromClose === null ? "" : `<span class="lv-dist ${cls}">${fromClose >= 0 ? "+" : ""}${fromClose.toFixed(1)}%</span>`;
    return `<div class="level-pill">
      <span class="lv-k">${label}</span>
      <span class="lv-v mono">${U.formatPrice(value)}</span>
      ${dist}
    </div>`;
  }

  function renderKeepAnEye(stocks, flagDefinitions) {
    const el = document.getElementById("keep-an-eye-list");
    const picks = stocks
      .filter((s) => s.flags.flag_count >= 5 && (U.isNearBuyZone(s) || U.isBreakoutCandidate(s) || U.isSilentAccumulation(s)))
      .sort((a, b) => b.flags.flag_count - a.flags.flag_count)
      .slice(0, 6);

    if (!picks.length) {
      el.innerHTML = `<div class="empty-note">No stock currently meets any of the watch conditions (≥5/8 flags plus a pullback, breakout or accumulation pattern).</div>`;
      return;
    }

    el.innerHTML = `<div class="watch-grid">${picks
      .map((s) => {
        const ind = s.indicators;
        const sr = U.supportResistance(s);
        const chg = U.formatChangePct(ind.change_pct);
        const pct = (target) => (target && ind.close ? ((target - ind.close) / ind.close) * 100 : null);
        const atrPct = ind.atr14 != null && ind.close ? (ind.atr14 / ind.close) * 100 : null;

        const levels = [];
        if (sr) levels.push(levelPill("Support", sr.support, pct(sr.support), "down"));
        levels.push(levelPill("Now", ind.close, null, ""));
        if (sr) levels.push(levelPill("Resistance", sr.resistance, pct(sr.resistance), "up"));
        if (ind.high_52w != null) levels.push(levelPill("52w high", ind.high_52w, pct(ind.high_52w), "up"));

        return `<div class="watch-card">
          <div class="watch-head">
            <button class="watch-sym" data-symbol="${s.symbol}" title="Show ${s.symbol} in the watchlist">${s.symbol}</button>
            <span class="sector-badge">${s.sector || "—"}</span>
            <span class="flag-count ${U.flagCountClass(s.flags.flag_count, s.flags.flag_total)}">${s.flags.flag_count}/${s.flags.flag_total}</span>
            <span class="watch-price mono">${U.formatPrice(ind.close)} <span class="chg ${chg.cls}">${chg.text}</span></span>
          </div>
          <div class="watch-why">${keepAnEyeReasons(s).map((r) => `<div class="exp-highlight">▸ ${r}</div>`).join("")}</div>
          <div class="level-row">${levels.join("")}</div>
          <div class="watch-foot fine">
            ${sr ? `Support/resistance = lowest/highest close of the last 20 sessions (${sr.basis}).` : ""}
            ${atrPct !== null ? ` Typical daily swing (ATR) ${U.formatPrice(ind.atr14)} ≈ ${atrPct.toFixed(1)}%.` : ""}
            These are observed price levels, not targets or advice.
          </div>
        </div>`;
      })
      .join("")}</div>
      <div class="fine watch-note">Why these: each stock met ≥5 of the 8 bullish flags <b>and</b> one of the named patterns above. The dashboard does not rate them or say when to trade — it shows the conditions and the levels, you decide.</div>`;

    el.querySelectorAll(".watch-sym").forEach((btn) => {
      btn.addEventListener("click", () => jumpToWatchlist(btn.dataset.symbol));
    });
  }

  // ---------- Market overview (breadth + movers + sector poles + VIX) ----------
  // A collection of separately-observable facts — deliberately NOT collapsed into a
  // single "market health score" (that would be the composite-score rule violated at
  // market level instead of stock level).

  function renderBreadth(stocks, sectors, market) {
    const el = document.getElementById("breadth-widgets");
    const total = stocks.length || 1;
    const above200 = stocks.filter((s) => s.indicators.ema200 != null && s.indicators.close > s.indicators.ema200).length;
    const high52 = stocks.filter((s) => s.indicators.high_52w != null && s.indicators.close >= 0.998 * s.indicators.high_52w);
    const low52 = stocks.filter((s) => s.indicators.low_52w != null && s.indicators.close <= 1.002 * s.indicators.low_52w);
    const breakouts = stocks.filter(U.isBreakoutCandidate).length;
    const adv = stocks.filter((s) => (s.indicators.change_pct ?? 0) > 0).length;
    const dec = stocks.filter((s) => (s.indicators.change_pct ?? 0) < 0).length;
    const adRatio = dec ? (adv / dec).toFixed(2) : adv ? "∞" : "—";

    const byChange = [...stocks].filter((s) => s.indicators.change_pct != null).sort((a, b) => b.indicators.change_pct - a.indicators.change_pct);
    const mover = (s) => {
      const chg = U.formatChangePct(s.indicators.change_pct);
      return `<button class="mover" data-symbol="${s.symbol}"><span class="ss">${s.symbol}</span><span class="mono ${chg.cls}">${chg.text}</span></button>`;
    };
    const gainers = byChange.slice(0, 5).map(mover).join("");
    const losers = byChange.slice(-5).reverse().map(mover).join("");

    const strongest = sectors?.[0];
    const weakest = sectors?.length ? sectors[sectors.length - 1] : null;
    const vix = market?.indices?.find((i) => i.key === "india_vix");
    const participating = sectors?.filter((s) => s.avg_flag_pct >= 50).length ?? 0;

    const bar = (n) => `<span class="breadth-bar"><span style="width:${((n / total) * 100).toFixed(0)}%"></span></span>`;
    el.innerHTML = `
      <div class="breadth-item"><span class="bk">Above EMA200</span><span class="bv mono">${above200}/${stocks.length}</span>${bar(above200)}</div>
      <div class="breadth-item"><span class="bk">A/D ratio</span><span class="bv mono">${adRatio}</span><span class="bnames">${adv} adv · ${dec} dec (watchlist)</span></div>
      <div class="breadth-item"><span class="bk">New 52w highs</span><span class="bv mono up">${high52.length}</span><span class="bnames">${high52.slice(0, 4).map((s) => s.symbol).join(" · ")}</span></div>
      <div class="breadth-item"><span class="bk">New 52w lows</span><span class="bv mono down">${low52.length}</span><span class="bnames">${low52.slice(0, 4).map((s) => s.symbol).join(" · ")}</span></div>
      <div class="breadth-item"><span class="bk">Breakout setups</span><span class="bv mono">${breakouts}</span>${bar(breakouts)}</div>
      <div class="breadth-item"><span class="bk">Sectors ≥50% flags</span><span class="bv mono">${participating}/${sectors?.length ?? 0}</span>${sectors?.length ? bar(participating / (sectors.length / total)) : ""}</div>
      ${strongest ? `<div class="breadth-item"><span class="bk">Strongest sector</span><span class="bv mono up">${strongest.sector}</span><span class="bnames">${strongest.avg_flag_pct}% avg flags</span></div>` : ""}
      ${weakest && weakest !== strongest ? `<div class="breadth-item"><span class="bk">Weakest sector</span><span class="bv mono down">${weakest.sector}</span><span class="bnames">${weakest.avg_flag_pct}% avg flags</span></div>` : ""}
      ${vix ? `<div class="breadth-item"><span class="bk">India VIX</span><span class="bv mono">${vix.close}</span><span class="bnames">${vix.change_pct != null ? (vix.change_pct > 0 ? "+" : "") + vix.change_pct.toFixed(1) + "% vs prev" : ""}</span></div>` : ""}
      <div class="movers-row"><span class="bk">Top gainers</span><div class="movers">${gainers || "—"}</div></div>
      <div class="movers-row"><span class="bk">Top losers</span><div class="movers">${losers || "—"}</div></div>`;

    el.querySelectorAll(".mover").forEach((btn) => btn.addEventListener("click", () => jumpToWatchlist(btn.dataset.symbol)));
  }

  // ---------- What changed today ----------

  const CHANGE_KIND_LABELS = {
    flags: "Flags", attention: "Attention", rsi: "RSI", macd: "MACD", ema200: "EMA200",
    high_52w: "52w high", low_52w: "52w low", volume: "Volume", levels: "Levels",
  };

  function renderChanges(changes, stocksBySymbol) {
    const el = document.getElementById("changes-list");
    if (!changes) {
      el.innerHTML = `<div class="empty-note">Change tracking starts with the next pipeline run — it compares each run against the previously published one, so the first comparison appears tomorrow.</div>`;
      return;
    }
    if (changes.note && !Object.keys(changes.symbols || {}).length) {
      el.innerHTML = `<div class="empty-note">${changes.note}</div>`;
      return;
    }
    const entries = Object.entries(changes.symbols || {});
    if (!entries.length) {
      el.innerHTML = `<div class="empty-note">No tracked stock changed materially between ${changes.baseline_date} and ${changes.data_date} — no crossings, new extremes, or flag moves.</div>`;
      return;
    }
    // Most-changed first; symbols still in today's universe get click-to-jump.
    entries.sort((a, b) => b[1].length - a[1].length);
    const shown = entries.slice(0, 24);
    el.innerHTML = `
      <div class="fine changes-sub">Comparing ${changes.baseline_date} → ${changes.data_date} · ${entries.length} stocks changed${changes.symbols_without_baseline ? ` · ${changes.symbols_without_baseline} had no baseline yet` : ""}</div>
      <div class="changes-grid">${shown
        .map(([symbol, events]) => {
          const stock = stocksBySymbol[symbol];
          const chg = stock ? U.formatChangePct(stock.indicators.change_pct) : null;
          return `<div class="change-card">
            <button class="change-sym" data-symbol="${symbol}">${symbol}${chg ? ` <span class="mono ${chg.cls}">${chg.text}</span>` : ""}</button>
            <div class="change-events">${events
              .map((e) => `<div class="change-event"><span class="change-kind k-${e.kind}">${CHANGE_KIND_LABELS[e.kind] || e.kind}</span><span>${e.text}</span></div>`)
              .join("")}</div>
          </div>`;
        })
        .join("")}</div>
      ${entries.length > shown.length ? `<div class="fine dim">…and ${entries.length - shown.length} more stocks with smaller changes.</div>` : ""}`;

    el.querySelectorAll(".change-sym").forEach((btn) => btn.addEventListener("click", () => jumpToWatchlist(btn.dataset.symbol)));
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

  function buildFilterDefs(sectors, portfolio, changes) {
    const strongSectors = new Set(sectors.filter((s) => s.avg_flag_pct >= 62.5).map((s) => s.sector));
    const held = new Set((portfolio?.holdings || []).map((h) => h.symbol));
    const improved = new Set(
      Object.entries(changes?.symbols || {})
        .filter(([, events]) => events.some((e) => e.kind === "flags" && e.text.includes("gained")))
        .map(([symbol]) => symbol)
    );
    const nearSupport = (s) => {
      const sr = U.supportResistance(s);
      return sr ? s.indicators.close <= sr.support * 1.02 : false;
    };
    return [
      { key: "buyzone", label: "Only buy zone", fn: (s) => U.isNearBuyZone(s), needsData: null },
      { key: "lowrisk", label: "Low risk", fn: (s) => s.decision?.risk?.level === "low", needsData: (s) => s.decision != null },
      { key: "breakout", label: "Breakouts", fn: (s) => U.isBreakoutCandidate(s), needsData: null },
      { key: "nearsupport", label: "Near support", fn: nearSupport, needsData: null },
      { key: "pullback", label: "Pullback", fn: (s) => s.indicators.ema50 > s.indicators.ema200 && s.indicators.close < s.indicators.ema20, needsData: null },
      { key: "strongsector", label: "Strong sectors", fn: (s) => strongSectors.has(s.sector), needsData: null },
      { key: "portfolio", label: "My portfolio", fn: (s) => held.has(s.symbol), needsData: null },
      { key: "vol2x", label: "Volume ≥2×", fn: (s) => (U.volumeRatio(s.indicators) ?? 0) >= 2, needsData: null },
      { key: "near52high", label: "Near 52w high", fn: (s) => s.indicators.high_52w != null && s.indicators.close >= 0.95 * s.indicators.high_52w, needsData: null },
      { key: "improved", label: "Improved today", fn: (s) => improved.has(s.symbol), needsData: null },
      { key: "highroe", label: "High ROE ≥15%", fn: (s) => s.fundamentals?.roe != null && s.fundamentals.roe >= 0.15, needsData: (s) => s.fundamentals?.roe != null },
      { key: "lowdebt", label: "Low debt <1×", fn: (s) => { const d = U.debtToEquityRatio(s.fundamentals); return d !== null && d < 1; }, needsData: (s) => U.debtToEquityRatio(s.fundamentals) !== null },
      { key: "dividend", label: "Dividend ≥1%", fn: (s) => { const y = U.dividendYieldPct(s.fundamentals); return y !== null && y >= 1; }, needsData: (s) => U.dividendYieldPct(s.fundamentals) !== null },
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
        persistFilters();
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
      // buy_date can be null (broker export lacked purchase dates) — don't fabricate a
      // CAGR from the epoch; show "date n/a" instead. Guard invalid dates too.
      const buyTime = h.buy_date ? new Date(h.buy_date).getTime() : NaN;
      let cagr = "—";
      if (!isNaN(buyTime)) {
        const days = (Date.now() - buyTime) / (24 * 3600 * 1000);
        if (days >= 90 && h.buy_price > 0) {
          const c = (Math.pow(h.current_price / h.buy_price, 365 / days) - 1) * 100;
          cagr = `${c >= 0 ? "+" : ""}${c.toFixed(1)}%`;
        } else if (days < 90) {
          cagr = "held <3mo";
        }
      } else {
        cagr = "date n/a";
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

  function renderRunStatus(meta, runReport, validation, news, stocks) {
    const el = document.getElementById("run-status");
    const rows = [];
    const kv = (k, v, cls = "") => rows.push(`<div class="health-row"><span class="hk">${k}</span><span class="hv mono ${cls}">${v}</span></div>`);

    kv("Last update", U.formatUpdatedAt(meta.run_at));
    kv("Stocks updated", `${meta.summary.ok}/${meta.summary.total}`, meta.summary.skipped ? "down" : "up");
    if (runReport?.runtime_seconds != null) kv("Pipeline duration", `${(runReport.runtime_seconds / 60).toFixed(1)} min`);
    if (validation) kv("Output validation", validation.result === "pass" ? "passed" : "FAILED", validation.result === "pass" ? "up" : "down");

    const pct = (n) => `${Math.round((n / (stocks.length || 1)) * 100)}%`;
    kv("Fundamentals", pct(stocks.filter((s) => s.fundamentals).length) + " of stocks");
    kv("Shareholding", pct(stocks.filter((s) => s.shareholding).length) + " of stocks");
    kv("News items", news?.items?.length ?? 0);

    let skippedHtml = "";
    if (meta.summary.skipped > 0) {
      const skippedSymbols = Object.entries(meta.symbols)
        .filter(([, info]) => info.status !== "ok")
        .map(([symbol, info]) => `${symbol} (${info.reason})`);
      skippedHtml = `<div class="callout compact"><b>${meta.summary.skipped} skipped:</b><br>${skippedSymbols.join("<br>")}</div>`;
    }
    el.innerHTML = rows.join("") + skippedHtml;
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

      // Two inputs drive one query: the always-visible one in the sticky header and the
      // one inside the watchlist panel. Typing in either updates the other so they can
      // never disagree about what is being filtered.
      const searchEl = document.getElementById("stock-search");
      const globalEl = document.getElementById("global-search");
      const countEl2 = document.getElementById("global-search-count");

      const applySearch = (value, { fromHeader }) => {
        searchQuery = value.trim();
        showAllFlat = false;
        if (searchEl.value !== value) searchEl.value = value;
        if (globalEl.value !== value) globalEl.value = value;
        renderTab(activeTab);
        if (countEl2) {
          const n = document.querySelectorAll("#stock-list .stock-block").length;
          countEl2.textContent = searchQuery ? `${n} match${n === 1 ? "" : "es"} · Enter to jump` : "";
        }
        if (fromHeader && searchQuery) document.getElementById("watchlist-card").classList.add("search-target");
      };

      searchEl.value = searchQuery;
      searchEl.addEventListener("input", () => applySearch(searchEl.value, { fromHeader: false }));
      globalEl.addEventListener("input", () => applySearch(globalEl.value, { fromHeader: true }));
      globalEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          document.getElementById("watchlist-card").scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
      controlsBound = true;
    }
  }

  // ---------- Boot ----------

  async function render() {
    const [meta, flagDefinitions] = await Promise.all([U.loadMeta(), U.loadFlagDefinitions()]);
    const [stocks, sectors, portfolio, market, news, changes, runReport, validation] = await Promise.all([
      U.loadAllStocks(meta),
      U.loadSectors(),
      U.loadPortfolio(),
      U.loadMarket(),
      U.loadNews(),
      U.loadChanges(),
      U.loadRunReport(),
      U.loadValidationReport(),
    ]);
    const stocksBySymbol = Object.fromEntries(stocks.map((s) => [s.symbol, s]));
    U.setSectorContext(sectors); // detail-panel checklist needs sector strength

    renderMarketStrip(market, stocks, meta);
    renderKpis(stocks, sectors, portfolio);
    renderHeatmap(sectors);
    renderOpportunities(stocks, flagDefinitions);
    renderChanges(changes, stocksBySymbol);
    renderKeepAnEye(stocks, flagDefinitions);
    renderBreadth(stocks, sectors, market);
    renderScreens(stocks);
    renderInstitutional(stocks);
    renderEvents(stocks);
    renderNews(news);
    renderPortfolioAnalytics(portfolio, stocksBySymbol);
    renderRunStatus(meta, runReport, validation, news, stocks);

    const filterDefs = buildFilterDefs(sectors, portfolio, changes);
    setupWatchlist(stocks, flagDefinitions, filterDefs);
    setupCollapsibles();
  }

  setupKeyboardShortcuts();

  render().catch((err) => {
    console.error(err);
    document.getElementById("stock-list").innerHTML =
      `<div class="empty-note">Failed to load data: ${err.message}. Run the pipeline first (python -m src.pipeline).</div>`;
  });

  window.dashboardUtils.initRefreshButton(document.getElementById("refresh-btn"), render);
})();
