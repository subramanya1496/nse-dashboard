// =====================================================================================
// PAGES — one module per navigation destination, each with a single responsibility.
// All data widgets are the same transparent, flag-count-based renderers as before
// (ported from the old single-page home/portfolio scripts); this file only re-houses
// them into the platform shell. Anything not collected yet renders an explicit note,
// never a fabricated value (CLAUDE.md logging discipline, applied to the UI).
// =====================================================================================
(function () {
  const U = window.dashboardUtils;
  const P = window.Platform;
  const jump = (symbol) => P.jumpToStock(symbol);

  // ---------------- Shared fragment renderers ----------------

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

  function bindJumpRows(container) {
    container.querySelectorAll("[data-symbol]").forEach((row) => {
      row.addEventListener("click", () => jump(row.dataset.symbol));
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
      <a class="btn btn-primary btn-sm kpi-portfolio-link" href="#/portfolio">Open full portfolio →</a>`;
  }

  // Lucide-style inline icons for the KPI cards (stroke = currentColor)
  const KPI_ICONS = {
    flag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`,
    breakout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
    volume: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>`,
    sector: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>`,
    wallet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 14h.01"/><path d="M2 7l3.5-4h13L22 7"/></svg>`,
  };

  // "vs yesterday" chips — honest counts from changes.json (flag gains/losses vs the
  // previous published run), never an invented trend. No changes file → no chip.
  function kpiDeltaChip(members, data) {
    const changes = data.changes;
    if (!changes || !changes.symbols) return "";
    const gained = members.filter((s) => (changes.symbols[s.symbol] || []).some((e) => e.kind === "flags" && e.text.includes("gained"))).length;
    const lost = members.filter((s) => (changes.symbols[s.symbol] || []).some((e) => e.kind === "flags" && e.text.includes("lost"))).length;
    const title = `Flag changes vs the previous run (${changes.baseline_date} → ${changes.data_date})`;
    if (gained) return `<span class="kpi-delta up" title="${title}">▲ ${gained} gained flags today</span>`;
    if (lost) return `<span class="kpi-delta down" title="${title}">▼ ${lost} lost flags today</span>`;
    return `<span class="kpi-delta" title="${title}">— no flag changes today</span>`;
  }

  // KPI metric-card row + shared detail drawer (Dashboard page)
  function renderKpis(rowEl, data) {
    const { stocks, sectors, portfolio, stocksBySymbol } = data;
    const byChangeDesc = (a, b) => (b.indicators.change_pct ?? 0) - (a.indicators.change_pct ?? 0);
    const perfect = [...stocks].filter((s) => s.flags.flag_count === s.flags.flag_total).sort(byChangeDesc);
    const breakouts = [...stocks].filter(U.isBreakoutCandidate).sort(byChangeDesc);
    const accum = [...stocks].filter(U.isSilentAccumulation).sort((a, b) => (U.volumeRatio(b.indicators) ?? 0) - (U.volumeRatio(a.indicators) ?? 0));
    const topSector = sectors.length ? sectors[0] : null;
    const sectorStocks = topSector
      ? [...stocks].filter((s) => s.sector === topSector.sector).sort((a, b) => b.flags.flag_count - a.flags.flag_count)
      : [];

    const holdings = portfolio.holdings || [];
    const priced = holdings.filter((h) => h.current_price != null);
    const invested = priced.reduce((s, h) => s + h.buy_price * h.quantity, 0);
    const pnl = priced.reduce((s, h) => s + (h.pnl ?? 0), 0);
    const pnlPct = invested ? (pnl / invested) * 100 : 0;
    const pnlCls = pnl > 0 ? "up" : pnl < 0 ? "down" : "flat";

    // Mini progress ring = share of the tracked watchlist meeting the condition.
    // A count made visual — never a weighted score.
    const ring = (n, cls) => P.ringHtml(n / (stocks.length || 1), `${n}`, {
      size: 44, stroke: 4, cls, title: `${n} of ${stocks.length} tracked stocks`,
    });

    // Portfolio day change vs previous close — the only honest "vs yesterday" money number
    let dayChange = 0, dayBase = 0;
    priced.forEach((h) => {
      const ind = stocksBySymbol[h.symbol]?.indicators;
      if (!ind || ind.prev_close == null || ind.close == null) return;
      dayChange += (ind.close - ind.prev_close) * h.quantity;
      dayBase += ind.prev_close * h.quantity;
    });
    const dayPct = dayBase ? (dayChange / dayBase) * 100 : null;
    const pnlDelta = dayPct == null ? "" :
      `<span class="kpi-delta ${dayChange > 0 ? "up" : dayChange < 0 ? "down" : ""}" title="Value change vs the previous close, across priced holdings">${dayChange >= 0 ? "▲" : "▼"} ${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(2)}% today</span>`;

    const cards = [
      {
        key: "perfect", label: "All 8/8 flags", icon: KPI_ICONS.flag, iconCls: "up",
        valueHtml: `<div class="kpi-value mono">${perfect.length}</div>`,
        sub: perfect.length ? "all 8 bullish conditions met" : "none today",
        delta: kpiDeltaChip(perfect, data),
        ring: ring(perfect.length, "up"),
        detail: () => ({ title: `Stocks with all 8/8 bullish flags (${perfect.length})`, body: kpiStockRows(perfect) }),
      },
      {
        key: "breakouts", label: "Breakout candidates", icon: KPI_ICONS.breakout, iconCls: "accent",
        valueHtml: `<div class="kpi-value mono">${breakouts.length}</div>`,
        sub: "above upper band / at 52w high",
        delta: kpiDeltaChip(breakouts, data),
        ring: ring(breakouts.length, "accent"),
        detail: () => ({
          title: `Breakout candidates (${breakouts.length})`,
          body: kpiStockRows(breakouts, (s) =>
            s.indicators.high_52w != null && s.indicators.close >= 0.995 * s.indicators.high_52w ? "at 52w high" : "above BB"),
        }),
      },
      {
        key: "accum", label: "Silent accumulation", icon: KPI_ICONS.volume, iconCls: "warn",
        valueHtml: `<div class="kpi-value mono">${accum.length}</div>`,
        sub: "volume ≥1.4× avg, price flat",
        delta: kpiDeltaChip(accum, data),
        ring: ring(accum.length, "warn"),
        detail: () => ({
          title: `Silent accumulation (${accum.length})`,
          body: kpiStockRows(accum, (s) => `${(U.volumeRatio(s.indicators) ?? 0).toFixed(1)}× vol`),
        }),
      },
      {
        key: "sector", label: "Strongest sector", icon: KPI_ICONS.sector, iconCls: "special",
        valueHtml: `<div class="kpi-value">${topSector ? topSector.sector : "—"}</div>`,
        sub: topSector ? `${topSector.avg_flag_pct}% avg flags · ${topSector.stock_count} stocks` : "",
        detail: () => ({
          title: topSector ? `${topSector.sector} — strongest sector (${topSector.avg_flag_pct}% avg flags)` : "No sector data",
          body: kpiStockRows(sectorStocks),
        }),
      },
      {
        key: "pnl", label: "Portfolio P&L", icon: KPI_ICONS.wallet, iconCls: pnl >= 0 ? "up" : "down",
        valueHtml: holdings.length
          ? `<div class="kpi-value mono ${pnlCls}">${pnl >= 0 ? "+" : "−"}₹${Math.abs(pnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>`
          : `<div class="kpi-value">—</div>`,
        sub: holdings.length
          ? `<span class="${pnlCls}">${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% unrealized</span>`
          : "no holdings configured",
        delta: holdings.length ? pnlDelta : "",
        detail: () => ({
          title: `Portfolio — unrealized P&L`,
          body: holdings.length
            ? portfolioDetailRows(holdings, priced, invested, pnl, pnlPct, pnlCls)
            : `<div class="empty-note sm">No holdings configured yet — add one from Settings.</div>`,
        }),
      },
    ];

    rowEl.innerHTML = cards
      .map(
        (c) => `<button class="kpi-card" data-kpi="${c.key}">
          <div class="kpi-top"><span class="kpi-label">${c.label}</span><span class="kpi-icon ${c.iconCls || ""}" aria-hidden="true">${c.icon || ""}</span></div>
          ${c.valueHtml}
          <div class="kpi-sub">${c.sub}</div>
          ${c.delta || ""}
          ${c.ring ? `<span class="kpi-ring">${c.ring}</span>` : ""}
          <span class="kpi-expand">details ▾</span>
        </button>`
      )
      .join("");

    let drawer = document.getElementById("kpi-detail");
    if (!drawer) {
      drawer = document.createElement("section");
      drawer.id = "kpi-detail";
      drawer.className = "kpi-detail panel";
      drawer.hidden = true;
      rowEl.after(drawer);
    }
    let openKey = null;

    function closeDrawer() {
      drawer.hidden = true;
      openKey = null;
      rowEl.querySelectorAll(".kpi-card").forEach((c) => c.classList.remove("active"));
    }

    rowEl.querySelectorAll(".kpi-card").forEach((card) => {
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
        rowEl.querySelectorAll(".kpi-card").forEach((c) => c.classList.toggle("active", c === card));
        drawer.querySelector(".kpi-detail-close").addEventListener("click", closeDrawer);
        drawer.querySelectorAll(".kpi-stock-row, button.kpi-holding-row").forEach((row) => {
          if (row.dataset.symbol) row.addEventListener("click", () => jump(row.dataset.symbol));
        });
        drawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  // Opportunities list (top N by flag count) — compact rows: badges + observed levels
  // + a one-line summary; the full rule-based explanation lives behind the expand.
  // Every badge is a count of named conditions with its reasons in the title — the
  // requested "confidence" is shown honestly as the data-completeness count.
  function renderOpportunitiesInto(el, data, limit = 5) {
    const { stocks, flagDefinitions } = data;
    const top = [...stocks].sort((a, b) => b.flags.flag_count - a.flags.flag_count).slice(0, limit);
    if (!top.length) {
      el.innerHTML = `<div class="empty-note">No stock data this run.</div>`;
      return;
    }
    el.innerHTML = "";
    top.forEach((stock, i) => {
      const exp = U.buildExplanation(stock, flagDefinitions);
      const ind = stock.indicators;
      const chg = U.formatChangePct(ind.change_pct);
      const ratio = U.volumeRatio(ind);
      const volBadge = ratio == null ? "" :
        `<span class="vol-badge ${ratio >= 1.5 ? "hot" : ""}" title="Today's volume vs the 20-day average">${ratio.toFixed(1)}× vol</span>`;

      const sr = U.supportResistance(stock);
      const lvPct = (target) => (target && ind.close ? ((target - ind.close) / ind.close) * 100 : null);
      const lv = (label, value, cls) => {
        const d = lvPct(value);
        return `<span class="lv" title="Observed from the last 20 sessions' closes — not a target">${label} <b class="mono">${U.formatPrice(value)}</b>${d == null ? "" : ` <span class="${cls}">${d >= 0 ? "+" : ""}${d.toFixed(1)}%</span>`}</span>`;
      };
      const levels = [];
      if (sr) { levels.push(lv("S", sr.support, "down")); levels.push(lv("R", sr.resistance, "up")); }
      if (ind.high_52w != null) levels.push(lv("52w", ind.high_52w, "up"));

      const wrap = document.createElement("div");
      wrap.className = "opp-block";
      wrap.innerHTML = `
        <div class="opp-row">
          <div class="rank">${i + 1}</div>
          <div class="opp-main">
            <div class="opp-head">
              <span class="name">${stock.symbol}</span>
              <span class="sector-badge">${stock.sector || "—"}</span>
              <span class="opp-price mono">${U.formatPrice(ind.close)} <span class="chg ${chg.cls}">${chg.text}</span></span>
            </div>
            <div class="opp-badges">
              <span class="flag-count ${U.flagCountClass(stock.flags.flag_count, stock.flags.flag_total)}">${stock.flags.flag_count}/${stock.flags.flag_total}</span>
              ${U.attentionStarsHtml(stock)}${U.riskChipHtml(stock, { compact: true })}${U.trendChipsHtml(stock)}${volBadge}${U.dataCompletenessHtml(stock)}
            </div>
            ${levels.length ? `<div class="opp-levels">${levels.join("")}</div>` : ""}
            <div class="opp-summary">${exp.summary}</div>
          </div>
          <span class="opp-toggle" aria-hidden="true">▾</span>
        </div>`;
      const detail = document.createElement("div");
      detail.className = "opp-detail";
      detail.hidden = true;
      detail.innerHTML = `
        ${exp.highlights.length ? `<div class="opp-highlights">${exp.highlights.map((h) => `<div class="exp-highlight">▸ ${h}</div>`).join("")}</div>` : ""}
        <div class="exp-risks"><span class="exp-risk-title">Risks to watch</span>
          ${exp.risks.map((r) => `<div class="exp-risk">⚠ ${r}</div>`).join("")}</div>
        <div class="exp-note">Rule-based explanation generated from the flags — not a recommendation. Levels are observed from price history, not targets. Claude AI wording arrives in Phase 3.</div>`;
      wrap.appendChild(detail);
      wrap.querySelector(".opp-row").addEventListener("click", () => {
        detail.hidden = !detail.hidden;
        wrap.classList.toggle("open", !detail.hidden);
      });
      el.appendChild(wrap);
    });
  }

  // Keep an eye on — named conditions + observed levels, never targets or advice.
  function keepAnEyeReasons(stock) {
    const reasons = [];
    if (U.isNearBuyZone(stock)) reasons.push("Uptrend (EMA50 &gt; EMA200), pulled back to its EMA20/50 zone");
    if (U.isBreakoutCandidate(stock)) reasons.push("Pressing the upper Bollinger band / 52-week high");
    if (U.isSilentAccumulation(stock)) reasons.push("Volume ≥1.4× average while price stayed flat");
    return reasons;
  }

  function levelPill(label, value, fromClose, cls) {
    const dist = fromClose === null ? "" : `<span class="lv-dist ${cls}">${fromClose >= 0 ? "+" : ""}${fromClose.toFixed(1)}%</span>`;
    return `<div class="level-pill"><span class="lv-k">${label}</span><span class="lv-v mono">${U.formatPrice(value)}</span>${dist}</div>`;
  }

  function renderKeepAnEyeInto(el, data) {
    const { stocks } = data;
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
    bindJumpRows(el);
  }

  // Market breadth + movers — separately-observable facts, never a "market health score".
  function renderBreadthInto(el, data) {
    const { stocks, sectors, market } = data;
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
    // Visual summary — each ring is the share of tracked stocks/sectors meeting a
    // named condition (a fraction of counts made visual, never a "health score").
    const bvRing = (n, of, label, cls, title) =>
      `<div class="bv-item">${P.ringHtml(of ? n / of : 0, `${n}`, { size: 56, stroke: 5, cls, title })}<span class="bv-cap">${label}</span></div>`;
    const visual = `<div class="breadth-visual">
      ${bvRing(above200, stocks.length, "above EMA200", "up", `${above200} of ${stocks.length} tracked stocks close above their 200-day EMA`)}
      ${bvRing(adv, stocks.length, "advancing", adv >= dec ? "up" : "down", `${adv} of ${stocks.length} tracked stocks up on the day`)}
      ${bvRing(participating, sectors?.length ?? 0, "sectors ≥50% flags", "accent", `${participating} of ${sectors?.length ?? 0} sectors average at least half the bullish flags`)}
    </div>`;
    el.innerHTML = `
      ${visual}
      <div class="breadth-item"><span class="bk">Above EMA200</span><span class="bv mono">${above200}/${stocks.length}</span>${bar(above200)}</div>
      <div class="breadth-item"><span class="bk">A/D ratio</span><span class="bv mono">${adRatio}</span><span class="bnames">${adv} adv · ${dec} dec (watchlist)</span></div>
      <div class="breadth-item"><span class="bk">New 52w highs</span><span class="bv mono up">${high52.length}</span><span class="bnames">${high52.slice(0, 4).map((s) => s.symbol).join(" · ")}</span></div>
      <div class="breadth-item"><span class="bk">New 52w lows</span><span class="bv mono down">${low52.length}</span><span class="bnames">${low52.slice(0, 4).map((s) => s.symbol).join(" · ")}</span></div>
      <div class="breadth-item"><span class="bk">Breakout setups</span><span class="bv mono">${breakouts}</span>${bar(breakouts)}</div>
      <div class="breadth-item"><span class="bk">Sectors ≥50% flags</span><span class="bv mono">${participating}/${sectors?.length ?? 0}</span></div>
      ${strongest ? `<div class="breadth-item"><span class="bk">Strongest sector</span><span class="bv mono up">${strongest.sector}</span><span class="bnames">${strongest.avg_flag_pct}% avg flags</span></div>` : ""}
      ${weakest && weakest !== strongest ? `<div class="breadth-item"><span class="bk">Weakest sector</span><span class="bv mono down">${weakest.sector}</span><span class="bnames">${weakest.avg_flag_pct}% avg flags</span></div>` : ""}
      ${vix ? `<div class="breadth-item"><span class="bk">India VIX</span><span class="bv mono">${vix.close}</span><span class="bnames">${vix.change_pct != null ? (vix.change_pct > 0 ? "+" : "") + vix.change_pct.toFixed(1) + "% vs prev" : ""}</span></div>` : ""}
      <div class="movers-row"><span class="bk">Top gainers</span><div class="movers">${gainers || "—"}</div></div>
      <div class="movers-row"><span class="bk">Top losers</span><div class="movers">${losers || "—"}</div></div>`;
    bindJumpRows(el);
  }

  // What changed today
  const CHANGE_KIND_LABELS = {
    flags: "Flags", attention: "Attention", rsi: "RSI", macd: "MACD", ema200: "EMA200",
    high_52w: "52w high", low_52w: "52w low", volume: "Volume", levels: "Levels",
  };

  function renderChangesInto(el, data, limit = 24) {
    const { changes, stocksBySymbol } = data;
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
    entries.sort((a, b) => b[1].length - a[1].length);
    const shown = entries.slice(0, limit);
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
    bindJumpRows(el);
  }

  // Screens — six transparent boolean conditions
  const SCREENS = [
    {
      id: "trending", title: "Trending today", hint: "largest absolute % moves",
      pick: (stocks, n) => [...stocks].sort((a, b) => Math.abs(b.indicators.change_pct ?? 0) - Math.abs(a.indicators.change_pct ?? 0)).slice(0, n),
      stat: () => null,
    },
    {
      id: "accum", title: "Silent accumulation", hint: "volume ≥1.4× avg, price flat",
      pick: (stocks, n) => stocks.filter(U.isSilentAccumulation).sort((a, b) => (U.volumeRatio(b.indicators) ?? 0) - (U.volumeRatio(a.indicators) ?? 0)).slice(0, n),
      stat: (s) => `${(U.volumeRatio(s.indicators) ?? 0).toFixed(1)}× vol`,
    },
    {
      id: "buyzone", title: "Near buy zone", hint: "uptrend, pulled back to EMA20/50",
      pick: (stocks, n) => stocks.filter(U.isNearBuyZone).sort((a, b) => b.flags.flag_count - a.flags.flag_count).slice(0, n),
      stat: (s) => `${s.flags.flag_count}/${s.flags.flag_total} flags`,
    },
    {
      id: "breakout", title: "Breakout candidates", hint: "above upper band / at 52w high",
      pick: (stocks, n) => stocks.filter(U.isBreakoutCandidate).sort((a, b) => (b.indicators.change_pct ?? 0) - (a.indicators.change_pct ?? 0)).slice(0, n),
      stat: (s) => s.indicators.high_52w != null && s.indicators.close >= 0.995 * s.indicators.high_52w ? "at 52w high" : "above BB",
    },
    {
      id: "highvol", title: "High volume movers", hint: "volume vs 20-day average",
      pick: (stocks, n) => stocks.filter((s) => (U.volumeRatio(s.indicators) ?? 0) >= 1.5).sort((a, b) => (U.volumeRatio(b.indicators) ?? 0) - (U.volumeRatio(a.indicators) ?? 0)).slice(0, n),
      stat: (s) => `${(U.volumeRatio(s.indicators) ?? 0).toFixed(1)}× vol`,
    },
    {
      id: "weakening", title: "Recently weakening", hint: "uptrend intact, short-term cracks",
      pick: (stocks, n) => stocks.filter(U.isWeakening).sort((a, b) => (a.indicators.change_pct ?? 0) - (b.indicators.change_pct ?? 0)).slice(0, n),
      stat: (s) => {
        const r5 = U.returnOverSessions(s, 5);
        return r5 !== null ? `${r5.toFixed(1)}% / 5d` : "below EMA20";
      },
    },
  ];

  function renderScreensInto(el, data, perScreen = 5) {
    const { stocks } = data;
    el.innerHTML = `<div class="screens-grid">${SCREENS.map((screen) => {
      const picks = screen.pick(stocks, perScreen);
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
    }).join("")}</div>`;
    bindJumpRows(el);
  }

  // Sector heatmap
  function heatClass(pct) {
    if (pct >= 75) return "h-strong2";
    if (pct >= 62.5) return "h-strong";
    if (pct >= 50) return "h-mid2";
    if (pct >= 37.5) return "h-mid";
    if (pct >= 25) return "h-weak";
    return "h-weak2";
  }

  function renderHeatmapInto(el, sectors, onSelect) {
    if (!sectors.length) {
      el.innerHTML = `<div class="empty-note">No sector data yet.</div>`;
      return;
    }
    el.innerHTML = sectors
      .map(
        (s) => `<button class="heat-cell ${heatClass(s.avg_flag_pct)}" data-sector="${s.sector}" title="${s.sector} — ${s.avg_flag_pct}% avg flags">
          <span class="heat-name">${s.sector}</span>
          <span class="heat-pct mono">${s.avg_flag_pct}%</span>
          <span class="heat-count mono">${s.stock_count} stk</span>
        </button>`
      )
      .join("");
    el.querySelectorAll(".heat-cell").forEach((cell) => {
      cell.addEventListener("click", () => onSelect(cell.dataset.sector));
    });
  }

  // Institutional / news / analytics / health (right-rail bodies)
  function renderInstitutionalInto(el, stocks) {
    el.classList.remove("empty-note"); // container may carry the "Loading…" empty state
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

  function collectEvents(stocks, horizonDays = 60) {
    const today = new Date();
    const horizon = new Date(today.getTime() + horizonDays * 24 * 3600 * 1000);
    const items = [];
    stocks.forEach((s) => {
      const ev = s.events;
      if (!ev) return;
      (ev.earnings_dates || []).forEach((d) => items.push({ symbol: s.symbol, sector: s.sector, type: "Earnings", date: d }));
      if (ev.ex_dividend_date) items.push({ symbol: s.symbol, sector: s.sector, type: "Ex-dividend", date: ev.ex_dividend_date });
      if (ev.dividend_date) items.push({ symbol: s.symbol, sector: s.sector, type: "Dividend pay", date: ev.dividend_date });
    });
    return items
      .map((i) => ({ ...i, d: new Date(i.date) }))
      .filter((i) => !isNaN(i.d) && i.d >= new Date(today.toDateString()) && i.d <= horizon)
      .sort((a, b) => a.d - b.d);
  }

  function renderEventsInto(el, stocks, { limit = 12 } = {}) {
    const upcoming = collectEvents(stocks);
    if (!upcoming.length) {
      const collected = stocks.some((s) => s.events);
      el.innerHTML = `<div class="empty-note">${collected
        ? "No earnings or dividend dates within the next 60 days."
        : "Event dates (earnings, dividends) start populating as the fundamentals cache refreshes over the next pipeline runs."}
        <br><span class="fine">Bonus/split announcements are not in the current free feed — planned via the NSE corporate-actions source.</span></div>`;
      return;
    }
    el.innerHTML = upcoming.slice(0, limit).map((i) => `<div class="event-row">
        <span class="event-date mono">${U.formatEventDate(i.date)}</span>
        <span class="ss">${i.symbol}</span>
        <span class="event-type">${i.type}</span>
      </div>`).join("") +
      `<div class="fine">Yahoo calendar dates · bonus/split feed not covered yet.</div>`;
  }

  function renderNewsInto(el, news, { limit = 10 } = {}) {
    if (!news || !news.items || !news.items.length) {
      el.innerHTML = `<div class="empty-note">News arrives with the next pipeline run (news.json not published yet).</div>`;
      return;
    }
    const badge = (s) => {
      const cls = s === "positive" ? "pos" : s === "negative" ? "neg" : "neu";
      return `<span class="senti ${cls}">${s}</span>`;
    };
    el.innerHTML = news.items.slice(0, limit).map((item) => `
      <a class="news-row" href="${item.link || "#"}" target="_blank" rel="noopener">
        <div class="news-top">${badge(item.sentiment)}<span class="ss">${item.symbol}</span>
          <span class="news-src">${item.publisher || ""}</span></div>
        <div class="news-title">${item.title}</div>
      </a>`).join("") +
      `<div class="fine">Sentiment is keyword-based (labelled in the data) — not an AI judgment. Headlines cover holdings + top flag-count names.</div>`;
  }

  function renderPortfolioAnalyticsInto(el, data) {
    el.classList.remove("empty-note");
    const { portfolio, stocksBySymbol } = data;
    const holdings = portfolio.holdings.filter((h) => h.current_price != null);
    if (!portfolio.holdings.length) {
      el.innerHTML = `<div class="empty-note">No holdings configured yet — add one from Settings.</div>`;
      return;
    }
    if (!holdings.length) {
      el.innerHTML = `<div class="empty-note">Holdings exist but no price data joined this cycle (see dashboard health).</div>`;
      return;
    }
    const value = (h) => h.current_price * h.quantity;
    const invested = holdings.reduce((s, h) => s + h.buy_price * h.quantity, 0);
    const current = holdings.reduce((s, h) => s + value(h), 0);
    const pnl = current - invested;
    const pnlCls = pnl > 0 ? "up" : pnl < 0 ? "down" : "flat";

    const rows = holdings.map((h) => {
      const alloc = (value(h) / current) * 100;
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

  function renderRunStatusInto(el, data) {
    el.classList.remove("empty-note");
    const { meta, runReport, validation, news, stocks } = data;
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

  // =====================================================================================
  // PAGE: Dashboard — the daily answer to "what deserves my attention today?"
  // =====================================================================================
  P.registerPage("dashboard", {
    title: "Dashboard",
    crumb: "Overview",
    render(main, data) {
      main.innerHTML = `
        <section class="kpi-row" id="kpi-row" aria-label="Key numbers today"></section>
        <section class="grid-opp">
          <div class="panel" aria-label="Today's opportunities">
            <div class="panel-head"><h2>Today's opportunities</h2>
              <span class="panel-sub">top 3 by flag count — ranked by conditions met, never a score</span>
              <a class="btn btn-ghost btn-sm" style="margin-left:auto" href="#/opportunities">View all →</a></div>
            <div id="dash-opps"></div>
          </div>
          <div class="panel" aria-label="Market overview">
            <div class="panel-head"><h2>Market overview</h2><span class="panel-sub">breadth across the tracked watchlist</span>
              <a class="btn btn-ghost btn-sm" style="margin-left:auto" href="#/market">Market →</a></div>
            <div id="dash-breadth"></div>
          </div>
        </section>
        <section class="grid-main">
          <div class="panel" aria-label="What changed today">
            <div class="panel-head"><h2>What changed today</h2>
              <span class="panel-sub">observed differences vs the previous run · click a symbol to jump to it</span></div>
            <div id="dash-changes"></div>
          </div>
          <div>
            <div class="side-card"><h5>Portfolio analytics</h5><div id="dash-pa" class="empty-note">Loading…</div></div>
            <div class="side-card"><h5>Dashboard health</h5><div id="dash-health" class="empty-note">Loading…</div></div>
          </div>
        </section>`;
      renderKpis(main.querySelector("#kpi-row"), data);
      renderOpportunitiesInto(main.querySelector("#dash-opps"), data, 3);
      renderBreadthInto(main.querySelector("#dash-breadth"), data);
      renderChangesInto(main.querySelector("#dash-changes"), data, 12);
      renderPortfolioAnalyticsInto(main.querySelector("#dash-pa"), data);
      renderRunStatusInto(main.querySelector("#dash-health"), data);
    },
  });

  // =====================================================================================
  // PAGE: Market — indices (India + global), breadth, movers
  // =====================================================================================
  function indexCardHtml(ix) {
    const chg = U.formatChangePct(ix.change_pct);
    const isVix = ix.key === "india_vix";
    const chgCls = isVix ? (ix.change_pct > 0 ? "vix-up" : "up") : chg.cls;
    const trendCls = ix.change_pct >= 0 ? (isVix ? "amber" : "teal") : "rose";
    const values = (ix.history || []).map((h) => h.close);
    let spark = "";
    if (values.length >= 2) {
      const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
      const W = 260, H = 44, pad = 2;
      const pts = values.map((v, i) => `${(pad + (i / (values.length - 1)) * (W - 2 * pad)).toFixed(1)},${(pad + (1 - (v - min) / span) * (H - 2 * pad)).toFixed(1)}`).join(" ");
      spark = `<svg class="spark ${trendCls}" style="width:100%;height:44px" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline></svg>`;
    }
    return `<div class="kpi-card" title="as of ${ix.as_of}">
      <div class="kpi-label">${ix.label}</div>
      <div class="kpi-value mono">${ix.close.toLocaleString("en-IN")}</div>
      <div class="kpi-sub mono ${chgCls === "vix-up" ? "" : chgCls}">${chg.text} · ${ix.as_of}</div>
      ${spark}
    </div>`;
  }

  P.registerPage("market", {
    title: "Market",
    crumb: "Overview",
    render(main, data) {
      const { market } = data;
      const india = market?.indices || [];
      const global = market?.global_indices || [];
      main.innerHTML = `
        <div class="page-head"><div><h2>Market</h2><div class="sub">Index levels, watchlist breadth and movers. Levels refresh when the pipeline (or the morning brief) runs — this is not a live feed.</div></div></div>
        <section class="panel" aria-label="India indices">
          <div class="panel-head"><h2>India</h2><span class="panel-sub">${market ? `updated ${U.formatUpdatedAt(market.updated_at)}` : ""}</span></div>
          ${india.length
            ? `<div class="grid-2" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${india.map(indexCardHtml).join("")}</div>`
            : `<div class="empty-note">Index data arrives with the next pipeline run (market.json not published yet).</div>`}
        </section>
        <section class="panel" aria-label="Global indices">
          <div class="panel-head"><h2>Global</h2><span class="panel-sub">overnight / other markets — context for the India open</span></div>
          ${global.length
            ? `<div class="grid-2" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${global.map(indexCardHtml).join("")}</div>`
            : `<div class="empty-note">Global index data arrives with the next pipeline run.</div>`}
        </section>
        <section class="panel" aria-label="Watchlist breadth">
          <div class="panel-head"><h2>Watchlist breadth</h2><span class="panel-sub">separate observable facts — deliberately no single "market health score"</span></div>
          <div id="market-breadth"></div>
        </section>`;
      renderBreadthInto(main.querySelector("#market-breadth"), data);
    },
  });

  // =====================================================================================
  // PAGE: Opportunities — top setups + "keep an eye on" levels
  // =====================================================================================
  P.registerPage("opportunities", {
    title: "Opportunities",
    crumb: "Overview",
    render(main, data) {
      main.innerHTML = `
        <div class="page-head"><div><h2>Opportunities</h2><div class="sub">Ranked by how many of the 8 bullish conditions fired — with the reasons and the risks, never a score or a verdict.</div></div></div>
        <section class="panel" aria-label="Today's opportunities">
          <div class="panel-head"><h2>Today's top setups</h2><span class="panel-sub">top 5 by flag count · click for risks</span></div>
          <div id="opp-list"></div>
        </section>
        <section class="panel" aria-label="Keep an eye on">
          <div class="panel-head"><h2>Keep an eye on</h2>
            <span class="panel-sub">setups worth watching, with the price levels that matter · levels are measured from price history — <b>not</b> buy/sell advice</span></div>
          <div id="opp-watch"></div>
        </section>`;
      renderOpportunitiesInto(main.querySelector("#opp-list"), data, 5);
      renderKeepAnEyeInto(main.querySelector("#opp-watch"), data);
    },
  });

  // =====================================================================================
  // PAGE: Watchlist — search, tabs, filters, dense rows with expandable detail
  // =====================================================================================
  const FILTERS_KEY = "nse-dashboard-filters";
  let activeFilters = new Set();
  try { activeFilters = new Set(JSON.parse(localStorage.getItem(FILTERS_KEY) || "[]")); } catch { /* corrupt -> clean */ }
  const persistFilters = () => localStorage.setItem(FILTERS_KEY, JSON.stringify([...activeFilters]));

  function buildFilterDefs(data) {
    const { sectors, portfolio, changes } = data;
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

  P.registerPage("watchlist", {
    title: "Watchlist",
    crumb: "Research",
    render(main, data, params) {
      const { stocks, flagDefinitions } = data;
      const filterDefs = buildFilterDefs(data);

      main.innerHTML = `
        <section class="panel" id="watchlist-card" aria-label="Watchlist">
          <div class="card-head-row">
            <h2>Watchlist</h2>
            <span class="stock-count" id="stock-count"></span>
          </div>
          <div class="tab-bar" id="watchlist-tabs" role="tablist">
            <button class="tab-btn active" data-tab="flags" role="tab">Top flags</button>
            <button class="tab-btn" data-tab="trending" role="tab">Trending</button>
            <button class="tab-btn" data-tab="sector" role="tab">By sector</button>
            <button class="tab-btn" data-tab="favorites" role="tab">★ Favorites</button>
          </div>
          <div class="filter-row">
            <span class="filter-label">Filters</span>
            <div class="filter-chips" id="filter-chips"></div>
          </div>
          <div class="filter-note fine" id="filter-note"></div>
          <div id="stock-list"></div>
        </section>`;

      const listEl = main.querySelector("#stock-list");
      const countEl = main.querySelector("#stock-count");
      const noteEl = main.querySelector("#filter-note");
      const searchCount = document.getElementById("global-search-count");
      const globalSearch = document.getElementById("global-search");

      let activeTab = "flags";
      let searchQuery = (params.get("q") || globalSearch.value || "").trim();
      if (globalSearch.value !== searchQuery) globalSearch.value = searchQuery;
      let showAllFlat = false;
      const FLAT_LIMIT = 25;

      const favoriteOptions = {
        onFavoriteToggle: () => { if (activeTab === "favorites") renderTab(activeTab); },
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
        const { matches: searched, fuzzy } = U.filterStocksByQuery(base, searchQuery);
        const { matched, missingData } = applyFilters(searched);

        const notes = [];
        if (fuzzy) notes.push(`No exact match for "${searchQuery}" — showing closest matches by letters in symbol/name/sector.`);
        if (activeFilters.size && missingData) notes.push(`${missingData} stock(s) excluded from an active filter because the required fundamentals field isn't collected for them yet.`);
        noteEl.textContent = notes.join(" ");

        const totalLabel = tab === "favorites" ? `${base.length} favorites` : `${stocks.length} tracked`;
        countEl.textContent = searchQuery || activeFilters.size ? `${matched.length} of ${totalLabel}` : totalLabel;
        if (searchCount) {
          searchCount.textContent = searchQuery ? `${matched.length} match${matched.length === 1 ? "" : "es"}` : "";
        }

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

      function renderChips() {
        const el = main.querySelector("#filter-chips");
        el.innerHTML = filterDefs
          .map((f) => {
            const count = stocks.filter(f.fn).length;
            return `<button class="filter-chip ${activeFilters.has(f.key) ? "active" : ""}" data-key="${f.key}" aria-pressed="${activeFilters.has(f.key)}">${f.label} <span class="mono">${count}</span></button>`;
          })
          .join("");
        el.querySelectorAll(".filter-chip").forEach((chip) => {
          chip.addEventListener("click", () => {
            const key = chip.dataset.key;
            if (activeFilters.has(key)) activeFilters.delete(key);
            else activeFilters.add(key);
            persistFilters();
            chip.classList.toggle("active", activeFilters.has(key));
            chip.setAttribute("aria-pressed", activeFilters.has(key));
            showAllFlat = false;
            renderTab(activeTab);
          });
        });
      }

      U.initTabs(main.querySelector("#watchlist-tabs"), (tab) => {
        showAllFlat = false;
        renderTab(tab);
      });
      renderChips();
      renderTab(activeTab);

      // Take live ownership of the topbar search while this page is mounted.
      P.setSearchHandler((value) => {
        searchQuery = value.trim();
        showAllFlat = false;
        renderTab(activeTab);
      });
    },
  });

  // =====================================================================================
  // PAGE: Portfolio
  // =====================================================================================
  const money = (v, digits = 0) => `₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: digits })}`;
  const signedMoney = (v, digits = 0) => `${v >= 0 ? "+" : "−"}${money(v, digits)}`;
  const pnCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");

  function summarisePortfolio(holdings, stockBySymbol) {
    const priced = holdings.filter((h) => h.current_price != null);
    const invested = priced.reduce((s, h) => s + h.buy_price * h.quantity, 0);
    const current = priced.reduce((s, h) => s + h.current_price * h.quantity, 0);
    const pnl = current - invested;
    const pnlPct = invested ? (pnl / invested) * 100 : 0;

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
      invested, current, pnl, pnlPct, dayChange, dayPct, dayCovered,
      best: ranked[0] || null,
      worst: ranked[ranked.length - 1] || null,
    };
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
    const pnlCls = pnCls(h.pnl ?? 0);
    const ind = stock?.indicators;
    const day = ind && ind.prev_close != null ? ((ind.close - ind.prev_close) / ind.prev_close) * 100 : null;
    const dayCls = day == null ? "flat" : pnCls(day);
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

  P.registerPage("portfolio", {
    title: "Portfolio",
    crumb: "Research",
    render(main, data) {
      const { portfolio, stocksBySymbol, flagDefinitions, meta } = data;
      const holdings = portfolio.holdings || [];

      main.innerHTML = `
        <div class="page-head">
          <div><h2>Portfolio</h2><div class="sub">Your holdings at the last published close · click any holding for its full breakdown</div></div>
          <div class="sub mono">Last run: ${U.formatUpdatedAt(meta.run_at)}</div>
        </div>
        <section class="kpi-row" id="pf-kpis" aria-label="Portfolio summary"></section>
        <div id="pf-data-note"></div>
        <section class="grid-main">
          <div class="panel" aria-label="Holdings">
            <div class="card-head-row"><h2>Holdings</h2><span class="stock-count" id="pf-count"></span></div>
            <div id="pf-holdings"></div>
          </div>
          <aside>
            <div class="side-card"><h5>Allocation</h5><div id="pf-allocation" class="empty-note">Loading…</div></div>
            <div class="side-card"><h5>Sector mix</h5><div id="pf-sectors" class="empty-note">Loading…</div></div>
            <div class="side-card"><h5>Risk conditions</h5><div id="pf-risk" class="empty-note sm">Loading…</div></div>
            <div class="side-card"><h5>Manage</h5>
              <div class="manage-buttons">
                <a class="btn btn-primary" href="https://github.com/subramanya1496/nse-dashboard/issues/new?template=add-holding.yml" target="_blank" rel="noopener">+ Add holding</a>
                <a class="btn btn-danger" href="https://github.com/subramanya1496/nse-dashboard/issues/new?template=remove-holding.yml" target="_blank" rel="noopener">− Remove holding</a>
              </div>
            </div>
          </aside>
        </section>`;

      if (!holdings.length) {
        main.querySelector("#pf-holdings").innerHTML = `<div class="empty-note">No holdings configured yet — add one via the Manage card.</div>`;
        main.querySelector("#pf-kpis").innerHTML = "";
        main.querySelector("#pf-allocation").innerHTML = `<div class="empty-note sm">No holdings.</div>`;
        main.querySelector("#pf-sectors").innerHTML = `<div class="empty-note sm">No holdings.</div>`;
        main.querySelector("#pf-risk").innerHTML = `<div class="empty-note sm">No holdings.</div>`;
        return;
      }

      const s = summarisePortfolio(holdings, stocksBySymbol);

      // Summary KPIs
      const kpis = main.querySelector("#pf-kpis");
      const dayHtml = s.dayCovered > 0
        ? `<div class="kpi-value mono ${pnCls(s.dayChange)}">${signedMoney(s.dayChange)}</div>
           <div class="kpi-sub ${pnCls(s.dayChange)}">${s.dayPct != null ? `${s.dayPct >= 0 ? "+" : ""}${s.dayPct.toFixed(2)}% today` : "today"}</div>`
        : `<div class="kpi-value">—</div><div class="kpi-sub">no per-stock data this run</div>`;
      kpis.innerHTML = `
        <div class="kpi-card"><div class="kpi-label">Invested</div>
          <div class="kpi-value mono">${money(s.invested)}</div>
          <div class="kpi-sub">${s.priced.length} of ${holdings.length} holdings priced</div></div>
        <div class="kpi-card"><div class="kpi-label">Current value</div>
          <div class="kpi-value mono">${money(s.current)}</div>
          <div class="kpi-sub">at last published close</div></div>
        <div class="kpi-card"><div class="kpi-label">Unrealized P&L</div>
          <div class="kpi-value mono ${pnCls(s.pnl)}">${signedMoney(s.pnl)}</div>
          <div class="kpi-sub ${pnCls(s.pnl)}">${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(2)}%</div></div>
        <div class="kpi-card"><div class="kpi-label">Day change</div>${dayHtml}</div>
        <div class="kpi-card"><div class="kpi-label">Best / worst</div>
          <div class="kpi-value pf-bw">
            ${s.best ? `<span class="up mono">${s.best.symbol} ${s.best.pnl_pct >= 0 ? "+" : ""}${s.best.pnl_pct.toFixed(1)}%</span>` : "—"}
          </div>
          <div class="kpi-sub">${s.worst ? `<span class="down mono">${s.worst.symbol} ${s.worst.pnl_pct >= 0 ? "+" : ""}${s.worst.pnl_pct.toFixed(1)}%</span>` : ""}</div></div>`;

      // Unpriced-note
      const noteEl = main.querySelector("#pf-data-note");
      if (s.unpriced.length) {
        const names = s.unpriced.map((h) => h.symbol).join(", ");
        noteEl.innerHTML = `<div class="callout compact"><b>${s.unpriced.length} holding(s) not priced this run:</b> ${names}.<br>
          Totals, allocation and P&L above cover only the ${s.priced.length} priced holding(s) — nothing is zero-filled or guessed. See dashboard health for per-symbol reasons.</div>`;
      }

      // Holdings
      const holdEl = main.querySelector("#pf-holdings");
      const sorted = [...holdings].sort((a, b) => {
        const av = a.current_price != null ? a.current_price * a.quantity : -1;
        const bv = b.current_price != null ? b.current_price * b.quantity : -1;
        return bv - av;
      });
      sorted.forEach((h) => holdEl.appendChild(holdingCard(h, stocksBySymbol[h.symbol], s, flagDefinitions)));
      main.querySelector("#pf-count").textContent = `${holdings.length} holding${holdings.length === 1 ? "" : "s"}`;

      // Allocation
      const allocEl = main.querySelector("#pf-allocation");
      allocEl.classList.remove("empty-note");
      if (!s.priced.length) {
        allocEl.innerHTML = `<div class="empty-note">No priced holdings to allocate.</div>`;
      } else {
        allocEl.innerHTML = [...s.priced]
          .map((h) => ({ h, value: h.current_price * h.quantity }))
          .sort((a, b) => b.value - a.value)
          .map(({ h, value }) => {
            const w = (value / s.current) * 100;
            return `<div class="alloc-row">
              <span class="ss">${h.symbol}</span>
              <span class="alloc-bar"><span style="width:${w.toFixed(1)}%" class="${pnCls(h.pnl ?? 0)}"></span></span>
              <span class="alloc-w mono">${w.toFixed(1)}%</span>
              <span class="alloc-v mono">${money(value)}</span>
            </div>`;
          })
          .join("") + `<div class="fine">Weight = holding value ÷ total priced value at the last close.</div>`;
      }

      // Risk conditions per holding — a count of named booleans from the pipeline's
      // decision block (the same 6 conditions shown in stock detail), never a meter.
      const riskEl = main.querySelector("#pf-risk");
      riskEl.classList.remove("empty-note", "sm");
      const withDecision = s.priced.filter((h) => stocksBySymbol[h.symbol]?.decision?.risk);
      if (!withDecision.length) {
        riskEl.innerHTML = `<div class="empty-note sm">Risk conditions appear after the next pipeline run publishes the decision block.</div>`;
      } else {
        const order = { high: 0, elevated: 1, low: 2 };
        riskEl.innerHTML = [...withDecision]
          .sort((a, b) => (order[stocksBySymbol[a.symbol].decision.risk.level] ?? 3) - (order[stocksBySymbol[b.symbol].decision.risk.level] ?? 3))
          .map((h) => `<div class="pf-risk-row"><span class="ss">${h.symbol}</span>${U.riskChipHtml(stocksBySymbol[h.symbol], { compact: true })}</div>`)
          .join("") +
          `<div class="fine">Count of 6 named risk conditions per holding (hover a chip for which fired) — observed conditions, not a risk rating.</div>`;
      }

      // Sector mix
      const secEl = main.querySelector("#pf-sectors");
      secEl.classList.remove("empty-note");
      if (!s.priced.length) {
        secEl.innerHTML = `<div class="empty-note">No priced holdings.</div>`;
      } else {
        const bySector = {};
        s.priced.forEach((h) => {
          const sec = h.sector || "Uncategorized";
          bySector[sec] = (bySector[sec] || 0) + h.current_price * h.quantity;
        });
        const entries = Object.entries(bySector).sort((a, b) => b[1] - a[1]);
        const top = entries[0];
        secEl.innerHTML = entries
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
    },
  });

  // =====================================================================================
  // PAGE: Sectors — heatmap + grouped stocks
  // =====================================================================================
  P.registerPage("sectors", {
    title: "Sectors",
    crumb: "Research",
    render(main, data, params) {
      const { stocks, sectors, flagDefinitions } = data;
      main.innerHTML = `
        <div class="page-head"><div><h2>Sectors</h2><div class="sub">Color = average % of the 8 bullish flags met across the sector's tracked stocks. Click a sector to expand its stocks below.</div></div></div>
        <section class="panel" aria-label="Sector strength heatmap">
          <div class="panel-head"><h2>Sector strength</h2><span class="panel-sub">teal ≥62.5% · amber mid · rose weak — a count of conditions, not a rating</span></div>
          <div class="heatmap-grid" id="sector-heatmap"></div>
        </section>
        <section class="panel" aria-label="Stocks by sector">
          <div class="panel-head"><h2>Stocks by sector</h2><span class="panel-sub" id="sector-filter-note">sorted by average flag strength</span></div>
          <div id="sector-groups"></div>
        </section>`;

      const groupsEl = main.querySelector("#sector-groups");
      const noteEl = main.querySelector("#sector-filter-note");
      let selected = params.get("sector") || null;

      function renderGroups() {
        const filtered = selected ? stocks.filter((s) => s.sector === selected) : stocks;
        noteEl.textContent = selected ? `showing ${selected} — click its heatmap cell again to clear` : "sorted by average flag strength";
        U.renderSectorGroupsInto(groupsEl, filtered, flagDefinitions, { forceExpand: !!selected });
      }

      renderHeatmapInto(main.querySelector("#sector-heatmap"), sectors, (sector) => {
        selected = selected === sector ? null : sector;
        renderGroups();
        groupsEl.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      renderGroups();
    },
  });

  // =====================================================================================
  // PAGE: Screener — the six transparent screens
  // =====================================================================================
  P.registerPage("screener", {
    title: "Screener",
    crumb: "Research",
    render(main, data) {
      main.innerHTML = `
        <div class="page-head"><div><h2>Screener</h2><div class="sub">Six transparent boolean conditions on today's data — conditions, not scores. Click a row to open the stock in the watchlist.</div></div></div>
        <section class="panel" aria-label="Screens"><div id="screener-grid"></div></section>`;
      renderScreensInto(main.querySelector("#screener-grid"), data, 8);
    },
  });

  // =====================================================================================
  // PAGE: Market Intelligence — news, sentiment mix, institutional activity
  // =====================================================================================
  P.registerPage("intelligence", {
    title: "Market Intelligence",
    crumb: "Intelligence",
    render(main, data) {
      const { news, stocks } = data;
      const items = news?.items || [];
      const counts = { positive: 0, negative: 0, neutral: 0 };
      items.forEach((i) => { counts[i.sentiment] = (counts[i.sentiment] || 0) + 1; });

      main.innerHTML = `
        <div class="page-head"><div><h2>Market Intelligence</h2><div class="sub">Headlines for holdings + top flag-count names, with keyword-tagged sentiment — labelled, transparent, not AI. Institutional flows appear when the NSE source responds.</div></div></div>
        <section class="kpi-row" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div class="kpi-card"><div class="kpi-label">Positive headlines</div><div class="kpi-value mono up">${counts.positive}</div><div class="kpi-sub">keyword sentiment · not AI</div></div>
          <div class="kpi-card"><div class="kpi-label">Negative headlines</div><div class="kpi-value mono down">${counts.negative}</div><div class="kpi-sub">keyword sentiment · not AI</div></div>
          <div class="kpi-card"><div class="kpi-label">Neutral / unmatched</div><div class="kpi-value mono">${counts.neutral}</div><div class="kpi-sub">unmatched headlines stay neutral — never guessed</div></div>
        </section>
        <section class="grid-main">
          <div class="panel" aria-label="Latest news">
            <div class="panel-head"><h2>Latest news</h2><span class="ext-tag">keyword sentiment · not AI</span></div>
            <div id="intel-news"></div>
          </div>
          <div>
            <div class="side-card"><h5>Institutional activity</h5><div id="intel-inst" class="empty-note">Loading…</div></div>
          </div>
        </section>`;
      renderNewsInto(main.querySelector("#intel-news"), news, { limit: 20 });
      renderInstitutionalInto(main.querySelector("#intel-inst"), stocks);
    },
  });

  // =====================================================================================
  // PAGE: Calendar — upcoming events grouped by date
  // =====================================================================================
  P.registerPage("calendar", {
    title: "Calendar",
    crumb: "Intelligence",
    render(main, data) {
      const { stocks } = data;
      const upcoming = collectEvents(stocks, 60);
      const collected = stocks.some((s) => s.events);

      let body;
      if (!upcoming.length) {
        body = `<div class="empty-note">${collected
          ? "No earnings or dividend dates within the next 60 days."
          : "Event dates (earnings, dividends) start populating as the fundamentals cache refreshes over the next pipeline runs."}
          <br><span class="fine">Bonus/split announcements are not in the current free feed — planned via the NSE corporate-actions source.</span></div>`;
      } else {
        const byDate = new Map();
        upcoming.forEach((i) => {
          const key = U.formatEventDate(i.date);
          if (!byDate.has(key)) byDate.set(key, []);
          byDate.get(key).push(i);
        });
        body = [...byDate.entries()]
          .map(([date, list]) => `
            <div class="side-card">
              <h5>${date}</h5>
              ${list.map((i) => `<div class="event-row">
                <span class="ss">${i.symbol}</span>
                <span class="sector-badge">${i.sector || "—"}</span>
                <span class="event-type">${i.type}</span>
              </div>`).join("")}
            </div>`)
          .join("");
        body += `<div class="fine">Yahoo calendar dates · bonus/split feed not covered yet.</div>`;
      }

      main.innerHTML = `
        <div class="page-head"><div><h2>Calendar</h2><div class="sub">Earnings and dividend dates across the watchlist for the next 60 days.</div></div></div>
        <section class="panel" aria-label="Upcoming events">${body}</section>`;
    },
  });

  // =====================================================================================
  // PAGE: Journal — every note saved in this browser, across all stocks
  // =====================================================================================
  const JOURNAL_KEY = "nse-dashboard-journal";
  const JOURNAL_FIELDS = [
    ["reason", "Reason for watching"],
    ["entry_plan", "Entry plan"],
    ["exit_plan", "Exit plan"],
    ["observations", "Observations"],
  ];

  P.registerPage("journal", {
    title: "Journal",
    crumb: "Intelligence",
    render(main, data) {
      let all = {};
      try { all = JSON.parse(localStorage.getItem(JOURNAL_KEY) || "{}"); } catch { /* corrupt -> empty */ }
      const entries = Object.entries(all).filter(([, v]) => JOURNAL_FIELDS.some(([k]) => v[k]));

      const grid = entries.length
        ? `<div class="journal-entry-grid">${entries
            .sort((a, b) => (b[1].updated_at || "").localeCompare(a[1].updated_at || ""))
            .map(([symbol, v]) => {
              const stock = data.stocksBySymbol[symbol];
              const chg = stock ? U.formatChangePct(stock.indicators.change_pct) : null;
              const fields = JOURNAL_FIELDS
                .map(([key, label]) => `<label class="journal-field"><span>${label}</span>
                  <textarea data-journal-field="${key}" rows="2" placeholder="—">${v[key] || ""}</textarea></label>`)
                .join("");
              return `<div class="journal-entry">
                <div class="journal-entry-head">
                  <button class="sym" data-symbol="${symbol}">${symbol}</button>
                  ${stock ? `<span class="sector-badge">${stock.sector || "—"}</span>
                    <span class="flag-count ${U.flagCountClass(stock.flags.flag_count, stock.flags.flag_total)}">${stock.flags.flag_count}/${stock.flags.flag_total}</span>
                    <span class="mono ${chg.cls}" style="font-size:11px">${U.formatPrice(stock.indicators.close)} ${chg.text}</span>` : `<span class="fine dim">not in today's universe</span>`}
                  <span class="when">${v.updated_at ? new Date(v.updated_at).toLocaleDateString("en-IN") : ""}</span>
                </div>
                <div class="journal-grid" data-journal-symbol="${symbol}">${fields}</div>
              </div>`;
            })
            .join("")}</div>`
        : `<div class="empty-note">No journal notes yet. Open any stock's detail panel in the watchlist and write in the "Personal journal" section — notes appear here automatically.</div>`;

      main.innerHTML = `
        <div class="page-head"><div><h2>Journal</h2><div class="sub">Your own notes per stock — saved in this browser only (GitHub Pages has no backend). Edits here save automatically.</div></div></div>
        <section class="panel" aria-label="Journal entries">${grid}</section>`;

      // Inline editing, same storage as the detail-panel journal
      main.querySelectorAll("[data-journal-symbol]").forEach((gridEl) => {
        const symbol = gridEl.dataset.journalSymbol;
        gridEl.querySelectorAll("textarea[data-journal-field]").forEach((area) => {
          area.addEventListener("input", () => {
            let store = {};
            try { store = JSON.parse(localStorage.getItem(JOURNAL_KEY) || "{}"); } catch { /* fresh */ }
            store[symbol] = { ...(store[symbol] || {}), [area.dataset.journalField]: area.value.trim(), updated_at: new Date().toISOString() };
            if (!area.value.trim()) delete store[symbol][area.dataset.journalField];
            localStorage.setItem(JOURNAL_KEY, JSON.stringify(store));
          });
        });
      });
      main.querySelectorAll(".journal-entry-head .sym").forEach((btn) => {
        btn.addEventListener("click", () => jump(btn.dataset.symbol));
      });
    },
  });

  // =====================================================================================
  // PAGE: Settings — theme, shortcuts, manage watchlist/holdings, pipeline health
  // =====================================================================================
  P.registerPage("settings", {
    title: "Settings",
    crumb: "System",
    render(main, data) {
      const { validation } = data;
      main.innerHTML = `
        <div class="page-head"><div><h2>Settings</h2><div class="sub">Appearance, data management and pipeline health.</div></div></div>
        <section class="grid-2">
          <div>
            <div class="panel" style="margin-bottom:var(--s4)">
              <div class="panel-head"><h2>Appearance</h2></div>
              <div style="display:flex;gap:var(--s2)">
                <button class="btn" id="set-theme-dark">🌙 Dark (default)</button>
                <button class="btn" id="set-theme-light">☀️ Light</button>
              </div>
              <div class="fine">Deep-navy terminal theme is the default; the original light glass palette stays available. Saved in this browser.</div>
            </div>
            <div class="panel" style="margin-bottom:var(--s4)">
              <div class="panel-head"><h2>Keyboard shortcuts</h2></div>
              <div class="health-row"><span class="hk">Focus search</span><span class="hv"><span class="kbd">/</span></span></div>
              <div class="health-row"><span class="hk">Clear search</span><span class="hv"><span class="kbd">Esc</span></span></div>
              <div class="health-row"><span class="hk">Navigate</span><span class="hv">left rail — fully keyboard-accessible (Tab / Enter)</span></div>
            </div>
            <div class="panel">
              <div class="panel-head"><h2>Manage watchlist &amp; holdings</h2><span class="panel-sub">changes apply on the next scheduled pipeline run</span></div>
              <div class="manage-buttons">
                <a class="btn btn-primary" href="https://github.com/subramanya1496/nse-dashboard/issues/new?template=add-stock.yml" target="_blank" rel="noopener">+ Add stock to watchlist</a>
                <a class="btn btn-danger" href="https://github.com/subramanya1496/nse-dashboard/issues/new?template=remove-stock.yml" target="_blank" rel="noopener">− Remove stock</a>
                <a class="btn btn-primary" href="https://github.com/subramanya1496/nse-dashboard/issues/new?template=add-holding.yml" target="_blank" rel="noopener">+ Add holding</a>
                <a class="btn btn-danger" href="https://github.com/subramanya1496/nse-dashboard/issues/new?template=remove-holding.yml" target="_blank" rel="noopener">− Remove holding</a>
                <a class="btn" href="https://github.com/subramanya1496/nse-dashboard/actions/workflows/daily-run.yml" target="_blank" rel="noopener">▶ Run pipeline now</a>
              </div>
            </div>
          </div>
          <div>
            <div class="panel" style="margin-bottom:var(--s4)">
              <div class="panel-head"><h2>Pipeline health</h2></div>
              <div id="settings-health"></div>
              ${validation && validation.result !== "pass" ? `<div class="callout compact"><b>Validation failed last run</b> — the previous publish stayed live instead.</div>` : ""}
            </div>
            <div class="panel">
              <div class="panel-head"><h2>About this terminal</h2></div>
              <div class="empty-note" style="color:var(--text-2)">
                Personal research terminal for the Indian NSE market. Most pages rank and explain by
                <b>flag count</b> — named conditions that fired. The Recommendations page (since 2026-07-18)
                additionally computes rule-based 0–100 scores, entry tiers, targets/stops and risk:reward —
                every formula is fixed, documented and shown with its point breakdown; nothing is AI-derived
                or a black box. Analyst consensus shown in stock detail is external third-party opinion,
                labelled as such. Data updates via the scheduled daily pipeline (GitHub Actions), not live
                ticks. Personal research only — not investment advice.
              </div>
            </div>
          </div>
        </section>`;

      renderRunStatusInto(main.querySelector("#settings-health"), data);
      main.querySelector("#set-theme-dark").addEventListener("click", () => { document.documentElement.dataset.theme = "dark"; localStorage.setItem("nse-terminal-theme", "dark"); });
      main.querySelector("#set-theme-light").addEventListener("click", () => { document.documentElement.dataset.theme = "light"; localStorage.setItem("nse-terminal-theme", "light"); });
    },
  });

  // ---------------- Boot the platform once all pages are registered ----------------
  P.boot();
})();
