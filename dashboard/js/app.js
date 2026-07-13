const DATA_BASE = "../data/output";

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`failed to fetch ${path}: ${response.status}`);
  }
  return response.json();
}

async function loadMeta() {
  return fetchJson(`${DATA_BASE}/meta.json`);
}

async function loadFlagDefinitions() {
  return fetchJson(`${DATA_BASE}/flag_definitions.json`);
}

async function loadPortfolio() {
  return fetchJson(`${DATA_BASE}/portfolio.json`);
}

async function loadSectors() {
  return fetchJson(`${DATA_BASE}/sectors.json`);
}

async function loadStock(symbol) {
  return fetchJson(`${DATA_BASE}/stocks/${symbol}.json`);
}

// market.json / news.json only exist once the extended pipeline has run — return null
// (never fake values) so sections can show an explicit "not collected yet" state.
async function loadMarket() {
  try {
    return await fetchJson(`${DATA_BASE}/market.json`);
  } catch {
    return null;
  }
}

async function loadNews() {
  try {
    return await fetchJson(`${DATA_BASE}/news.json`);
  } catch {
    return null;
  }
}

async function loadAllStocks(meta) {
  const symbols = Object.entries(meta.symbols)
    .filter(([, info]) => info.status === "ok")
    .map(([symbol]) => symbol);
  const stocks = await Promise.all(
    symbols.map((symbol) => fetchJson(`${DATA_BASE}/stocks/${symbol}.json`))
  );
  return stocks;
}

function flagCountClass(count, total) {
  const ratio = count / total;
  if (ratio >= 0.625) return "strong"; // 5/8+
  if (ratio >= 0.375) return "mid"; // 3-4/8
  return "weak";
}

function pillStatusClass(count, total) {
  const ratio = count / total;
  if (ratio >= 0.625) return "ok";
  if (ratio >= 0.375) return "watch";
  return "review";
}

function formatPrice(value) {
  if (value === null || value === undefined) return "—";
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function formatChangePct(value) {
  if (value === null || value === undefined) return { text: "—", cls: "flat" };
  const cls = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "→";
  return { text: `${arrow} ${Math.abs(value).toFixed(2)}%`, cls };
}

function flagShortLabel(flagDefinitions, key) {
  const def = flagDefinitions.find((d) => d.key === key);
  return def ? def.label : key;
}

function sectorBarClass(avgFlagPct) {
  if (avgFlagPct >= 62.5) return "";
  if (avgFlagPct >= 37.5) return "mid";
  return "weak";
}

function kvGridHtml(entries) {
  return `<div class="kv-grid">${entries
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([label, value]) => `<div class="kv"><div class="k">${label}</div><div class="v">${value}</div></div>`)
    .join("")}</div>`;
}

function formatVolume(value) {
  if (value === null || value === undefined) return "—";
  if (value >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
  if (value >= 1e5) return `${(value / 1e5).toFixed(2)} L`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} K`;
  return `${Math.round(value)}`;
}

// ---- Derived metrics (all from real pipeline fields; return null when inputs missing) ----

function volumeRatio(ind) {
  if (!ind || !ind.volume || !ind.avg_volume20) return null;
  return ind.volume / ind.avg_volume20;
}

// Simple 20-session swing support/resistance from the shipped price history;
// falls back to Bollinger bands when history is too short.
function supportResistance(stock) {
  const hist = Array.isArray(stock.price_history) ? stock.price_history : [];
  const closes = hist.slice(-20).map((h) => h.close).filter((c) => c !== null && c !== undefined);
  if (closes.length >= 10) {
    return { support: Math.min(...closes), resistance: Math.max(...closes), basis: "20-session close" };
  }
  const ind = stock.indicators;
  if (ind.bb_low != null && ind.bb_high != null) {
    return { support: ind.bb_low, resistance: ind.bb_high, basis: "Bollinger band" };
  }
  return null;
}

// yfinance reports debtToEquity as a percentage for most tickers (e.g. 41.2 → 0.41x).
// Values ≤ 5 are assumed to already be a ratio.
function debtToEquityRatio(fund) {
  if (!fund || fund.debt_to_equity === null || fund.debt_to_equity === undefined) return null;
  return fund.debt_to_equity > 5 ? fund.debt_to_equity / 100 : fund.debt_to_equity;
}

function dividendYieldPct(fund) {
  if (!fund || fund.dividend_yield === null || fund.dividend_yield === undefined) return null;
  // yfinance ≥0.2.5x reports percent (0.66 = 0.66%); older builds reported a fraction.
  return fund.dividend_yield <= 0.25 && fund.dividend_yield > 0
    ? fund.dividend_yield * 100
    : fund.dividend_yield;
}

function returnOverSessions(stock, sessions) {
  const hist = Array.isArray(stock.price_history) ? stock.price_history : [];
  if (hist.length < sessions + 1) return null;
  const start = hist[hist.length - 1 - sessions].close;
  const end = hist[hist.length - 1].close;
  if (!start) return null;
  return ((end - start) / start) * 100;
}

// ---- Screen predicates (shared so index page + explanations agree) ----

function isBreakoutCandidate(stock) {
  const ind = stock.indicators;
  const aboveBB = ind.bb_high != null && ind.close > ind.bb_high;
  const at52wHigh = ind.high_52w != null && ind.close >= 0.995 * ind.high_52w;
  return aboveBB || at52wHigh;
}

function isSilentAccumulation(stock) {
  const ratio = volumeRatio(stock.indicators);
  const chg = stock.indicators.change_pct;
  return ratio !== null && ratio >= 1.4 && chg !== null && Math.abs(chg) <= 0.8;
}

function isNearBuyZone(stock) {
  const ind = stock.indicators;
  if (!(ind.ema50 != null && ind.ema200 != null && ind.ema50 > ind.ema200)) return false;
  const nearEma = (ema) => ema != null && ind.close >= 0.98 * ema && ind.close <= 1.02 * ema;
  return nearEma(ind.ema20) || nearEma(ind.ema50);
}

function isWeakening(stock) {
  const ind = stock.indicators;
  const longUptrend = ind.ema50 != null && ind.ema200 != null && ind.ema50 > ind.ema200;
  const shortTermWeak = ind.ema20 != null && ind.close < ind.ema20 && ind.rsi14 != null && ind.rsi14 < 50;
  const fiveDay = returnOverSessions(stock, 5);
  return longUptrend && (shortTermWeak || (fiveDay !== null && fiveDay < -3));
}

// ---- Rule-based explanation ("why highlighted" + risks) ----
// Deterministic prose generated from the flags and indicators already computed by the
// pipeline. It never produces a verdict or score — it restates which conditions fired
// and which risks are visible. The Claude AI layer (Phase 3) will replace the wording,
// not the logic.
function buildExplanation(stock, flagDefinitions) {
  const ind = stock.indicators;
  const { flag_count, flag_total, flags_on } = stock.flags;
  const firedLabels = flags_on.map((k) => flagShortLabel(flagDefinitions, k));
  const failed = flagDefinitions.filter((d) => !stock.flags.flags[d.key]).map((d) => d.label);

  let summary;
  if (flag_count === 0) {
    summary = `None of the ${flag_total} bullish conditions fired — the setup is weak across trend, momentum and volume measures.`;
  } else if (flag_count === flag_total) {
    summary = `All ${flag_total} bullish conditions fired: ${firedLabels.join(", ")}.`;
  } else {
    summary = `${flag_count} of ${flag_total} bullish conditions fired — ${firedLabels.join(", ")}. Still missing: ${failed.join(", ")}.`;
  }

  const highlights = [];
  const ratio = volumeRatio(ind);
  if (ratio !== null && ratio >= 1.4) highlights.push(`Volume today is ${ratio.toFixed(1)}× the 20-day average.`);
  if (isBreakoutCandidate(stock)) highlights.push("Price is pressing its upper Bollinger band / 52-week high — breakout territory.");
  if (isSilentAccumulation(stock)) highlights.push("Elevated volume with a flat price move — the quiet-accumulation pattern.");
  if (isNearBuyZone(stock)) highlights.push("In an uptrend (EMA50 > EMA200) and pulled back near its EMA20/50 support zone.");

  const risks = [];
  if (ind.rsi14 != null && ind.rsi14 > 70) risks.push(`RSI ${ind.rsi14.toFixed(1)} is in overbought territory — extended in the short term.`);
  if (ind.rsi14 != null && ind.rsi14 < 30) risks.push(`RSI ${ind.rsi14.toFixed(1)} is oversold — the downtrend is strong even if a bounce is due.`);
  if (ind.high_52w != null && ind.close < ind.high_52w) {
    const off = ((ind.high_52w - ind.close) / ind.high_52w) * 100;
    if (off > 20) risks.push(`Trading ${off.toFixed(0)}% below its 52-week high — significant overhead supply.`);
  }
  if (ind.atr14 != null && ind.close) {
    const atrPct = (ind.atr14 / ind.close) * 100;
    if (atrPct > 3) risks.push(`ATR is ${atrPct.toFixed(1)}% of price — daily swings are large; position sizing matters.`);
  }
  if (ratio !== null && ratio < 0.6) risks.push(`Volume is only ${ratio.toFixed(1)}× the 20-day average — thin participation behind the current move.`);
  if (ind.macd != null && ind.macd_signal != null && ind.macd < ind.macd_signal && flag_count >= 5) {
    risks.push("MACD has slipped below its signal line while other conditions hold — momentum may be fading.");
  }
  if (ind.ema200 != null && ind.close < ind.ema200) risks.push("Price is below the 200-day EMA — the long-term trend is still down.");
  if (isWeakening(stock)) risks.push("Recently weakening: the longer uptrend is intact but short-term price has dropped below EMA20.");
  if (!risks.length) risks.push("No standout risk flags from the tracked indicators — normal market risk still applies.");

  return { summary, highlights, risks };
}

function explanationSectionHtml(stock, flagDefinitions) {
  // If the Phase 3 pipeline has produced a Claude explanation, show it (clearly
  // labelled). Until then, show the deterministic rule-based text, also labelled.
  const isAi = typeof stock.ai_explanation === "string" && stock.ai_explanation.length > 0;
  const exp = buildExplanation(stock, flagDefinitions);
  const bodyHtml = isAi
    ? `<p>${stock.ai_explanation}</p>`
    : `<p>${exp.summary}</p>${exp.highlights.map((h) => `<p class="exp-highlight">▸ ${h}</p>`).join("")}`;
  return `<div class="detail-section">
    <h6>Why this stock is here <span class="ext-tag">${isAi ? "Claude AI explanation" : "rule-based · from the flags above · AI wording arrives in Phase 3"}</span></h6>
    <div class="explanation">${bodyHtml}
      <div class="exp-risks"><span class="exp-risk-title">Risks to watch</span>
        ${exp.risks.map((r) => `<div class="exp-risk">⚠ ${r}</div>`).join("")}
      </div>
    </div>
  </div>`;
}

function formatEventDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function eventsSectionHtml(stock) {
  const ev = stock.events;
  if (!ev) {
    return `<div class="detail-section"><h6>Upcoming events</h6><span class="empty-note">Not collected yet — populates as the fundamentals cache refreshes on the next pipeline runs.</span></div>`;
  }
  const rows = [];
  (ev.earnings_dates || []).slice(0, 2).forEach((d) => rows.push(["Earnings", formatEventDate(d)]));
  if (ev.ex_dividend_date) rows.push(["Ex-dividend", formatEventDate(ev.ex_dividend_date)]);
  if (ev.dividend_date) rows.push(["Dividend pay", formatEventDate(ev.dividend_date)]);
  if (!rows.length) {
    return `<div class="detail-section"><h6>Upcoming events</h6><span class="empty-note">No dated events in the current feed.</span></div>`;
  }
  return `<div class="detail-section"><h6>Upcoming events <span class="ext-tag">Yahoo calendar · bonus/split feed not covered yet</span></h6>${kvGridHtml(rows)}</div>`;
}

// Inline SVG line chart (close + EMA50). No chart library — keeps the dashboard
// dependency-free and works offline on GitHub Pages. Non-scaling strokes keep the
// line crisp even though the SVG stretches to the panel width.
function buildPriceChartSvg(history) {
  if (!Array.isArray(history) || history.length < 2) return "";
  const closes = history.map((h) => h.close);
  const emas = history.map((h) => (h.ema50 === null || h.ema50 === undefined ? null : h.ema50));
  const values = closes.concat(emas.filter((v) => v !== null));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const W = 320, H = 90, pad = 4;
  const xAt = (i) => pad + (i / (history.length - 1)) * (W - 2 * pad);
  const yAt = (v) => pad + (1 - (v - min) / span) * (H - 2 * pad);
  const closePts = closes.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  const emaPts = emas
    .map((v, i) => (v === null ? null : `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  const rising = closes[closes.length - 1] >= closes[0];
  const stroke = rising ? "var(--teal)" : "var(--rose)";
  const areaFill = rising ? "rgba(31,122,99,0.10)" : "rgba(168,64,58,0.10)";
  const area = `${pad},${H - pad} ${closePts} ${(W - pad).toFixed(1)},${H - pad}`;
  return `<svg class="price-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Recent price line chart">
    <polygon points="${area}" fill="${areaFill}"></polygon>
    ${emaPts ? `<polyline points="${emaPts}" fill="none" stroke="var(--amber)" stroke-width="1" stroke-dasharray="3 3" opacity="0.75" vector-effect="non-scaling-stroke"></polyline>` : ""}
    <polyline points="${closePts}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>
  </svg>`;
}

function priceChartSectionHtml(stock) {
  const history = stock.price_history;
  if (!Array.isArray(history) || history.length < 2) {
    return `<div class="detail-section"><h6>Price trend</h6><span class="empty-note">Chart available after the next pipeline run.</span></div>`;
  }
  const first = history[0].date;
  const last = history[history.length - 1].date;
  return `<div class="detail-section">
    <h6>Price trend · last ${history.length} sessions</h6>
    <div class="chart-wrap">${buildPriceChartSvg(history)}</div>
    <div class="chart-legend">
      <span><i class="swatch close"></i> Close</span>
      <span><i class="swatch ema"></i> EMA50</span>
      <span class="range mono">${first} → ${last}</span>
    </div>
  </div>`;
}

function rangeSectionHtml(ind) {
  if (ind.low_52w === null || ind.low_52w === undefined || ind.high_52w === null || ind.high_52w === undefined) {
    return "";
  }
  const span = ind.high_52w - ind.low_52w || 1;
  const pos = Math.max(0, Math.min(100, ((ind.close - ind.low_52w) / span) * 100));
  const fromLow = (((ind.close - ind.low_52w) / ind.low_52w) * 100).toFixed(1);
  const fromHigh = (((ind.close - ind.high_52w) / ind.high_52w) * 100).toFixed(1);
  return `<div class="detail-section">
    <h6>52-week range</h6>
    <div class="range-row">
      <span class="range-end mono">${formatPrice(ind.low_52w)}</span>
      <div class="range-track"><div class="range-marker" style="left:${pos.toFixed(1)}%"></div></div>
      <span class="range-end mono">${formatPrice(ind.high_52w)}</span>
    </div>
    <div class="range-sub">Now ${formatPrice(ind.close)} · <span class="up">+${fromLow}%</span> from low · <span class="down">${fromHigh}%</span> from high</div>
  </div>`;
}

const ANALYST_LABELS = {
  strong_buy: "Strong Buy",
  buy: "Buy",
  hold: "Hold",
  underperform: "Underperform",
  sell: "Sell",
};

function analystClass(rec) {
  if (rec === "strong_buy" || rec === "buy") return "ok";
  if (rec === "hold") return "watch";
  if (rec === "underperform" || rec === "sell") return "review";
  return "watch";
}

// External third-party analyst consensus, shown as-is and clearly labelled. The dashboard
// never turns this (or the flags) into its own buy/hold/sell verdict — CLAUDE.md hard rule.
function analystSectionHtml(stock) {
  const a = stock.analyst;
  if (!a) {
    return `<div class="detail-section"><h6>Analyst view <span class="ext-tag">external</span></h6><span class="empty-note">No analyst coverage available this run.</span></div>`;
  }
  const label = ANALYST_LABELS[a.recommendation] || (a.recommendation || "—");
  const cls = analystClass(a.recommendation);
  const close = stock.indicators.close;

  let targetHtml = "";
  if (a.target_low != null && a.target_high != null && a.target_mean != null) {
    const span = a.target_high - a.target_low || 1;
    const meanPos = Math.max(0, Math.min(100, ((a.target_mean - a.target_low) / span) * 100));
    const nowPos = Math.max(0, Math.min(100, ((close - a.target_low) / span) * 100));
    const upside = (((a.target_mean - close) / close) * 100).toFixed(1);
    const upsideCls = a.target_mean >= close ? "up" : "down";
    targetHtml = `
      <div class="target-row">
        <span class="range-end mono">${formatPrice(a.target_low)}</span>
        <div class="range-track target">
          <div class="range-tick now" style="left:${nowPos.toFixed(1)}%" title="Current price"></div>
          <div class="range-marker mean" style="left:${meanPos.toFixed(1)}%" title="Mean target"></div>
        </div>
        <span class="range-end mono">${formatPrice(a.target_high)}</span>
      </div>
      <div class="range-sub">Mean target ${formatPrice(a.target_mean)} · <span class="${upsideCls}">${a.target_mean >= close ? "+" : ""}${upside}%</span> vs current · ● now ◆ target</div>`;
  }

  return `<div class="detail-section">
    <h6>Analyst view <span class="ext-tag">external · third-party opinion, not this dashboard's</span></h6>
    <div class="analyst-head">
      <span class="pill-status ${cls}">${label}</span>
      <span class="analyst-meta mono">${a.num_analysts != null ? `${a.num_analysts} analysts` : ""}${a.recommendation_mean != null ? ` · mean ${a.recommendation_mean.toFixed(2)}/5` : ""}</span>
    </div>
    ${targetHtml}
  </div>`;
}

function renderDetailPanelHtml(stock, flagDefinitions) {
  const checkRows = flagDefinitions
    .map((def) => {
      const isOn = stock.flags.flags[def.key];
      const detail = stock.flags.flags_detail[def.key];
      return `<div class="check-row">
        <span class="mark ${isOn ? "pass" : "fail"}">${isOn ? "✓" : "✗"}</span>
        <span class="label">${def.label} — ${detail}</span>
      </div>`;
    })
    .join("");

  const ind = stock.indicators;
  const indicatorsHtml = kvGridHtml([
    ["Close", formatPrice(ind.close)],
    ["EMA20", formatPrice(ind.ema20)],
    ["EMA50", formatPrice(ind.ema50)],
    ["EMA200", formatPrice(ind.ema200)],
    ["RSI(14)", ind.rsi14?.toFixed(2)],
    ["MACD", ind.macd?.toFixed(2)],
    ["MACD signal", ind.macd_signal?.toFixed(2)],
    ["ATR(14)", ind.atr14?.toFixed(2)],
    ["ADX(14)", ind.adx14?.toFixed(2)],
    ["+DI", ind.adx_pos?.toFixed(2)],
    ["-DI", ind.adx_neg?.toFixed(2)],
    ["BB high", formatPrice(ind.bb_high)],
    ["BB mid", formatPrice(ind.bb_mid)],
    ["BB low", formatPrice(ind.bb_low)],
    ["VWAP(20)", formatPrice(ind.vwap20)],
    ["Volume", formatVolume(ind.volume)],
    ["Avg vol (20d)", formatVolume(ind.avg_volume20)],
  ]);

  let fundamentalsHtml = "";
  if (stock.fundamentals) {
    const f = stock.fundamentals;
    fundamentalsHtml = `<div class="detail-section"><h6>Fundamentals</h6>${kvGridHtml([
      ["PE (trailing)", f.pe_trailing?.toFixed(2)],
      ["PE (forward)", f.pe_forward?.toFixed(2)],
      ["EPS (trailing)", f.eps_trailing],
      ["ROE", f.roe !== null && f.roe !== undefined ? `${(f.roe * 100).toFixed(1)}%` : null],
      ["ROCE", f.roce !== null && f.roce !== undefined ? `${(f.roce * 100).toFixed(1)}%` : null],
      ["Profit margin", f.profit_margin !== null && f.profit_margin !== undefined ? `${(f.profit_margin * 100).toFixed(1)}%` : null],
      ["Revenue growth YoY", f.revenue_growth_yoy !== null && f.revenue_growth_yoy !== undefined ? `${(f.revenue_growth_yoy * 100).toFixed(1)}%` : null],
      ["Market cap", f.market_cap ? `₹${(f.market_cap / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr` : null],
      ["Debt / equity", debtToEquityRatio(f) !== null ? `${debtToEquityRatio(f).toFixed(2)}x` : null],
      ["Dividend yield", dividendYieldPct(f) !== null ? `${dividendYieldPct(f).toFixed(2)}%` : null],
      ["Price / book", f.price_to_book !== null && f.price_to_book !== undefined ? f.price_to_book.toFixed(2) : null],
    ])}</div>`;
  } else {
    fundamentalsHtml = `<div class="detail-section"><h6>Fundamentals</h6><span class="empty-note">Not available this run.</span></div>`;
  }

  let shareholdingHtml = "";
  if (stock.shareholding) {
    shareholdingHtml = `<div class="detail-section"><h6>Shareholding change</h6>${kvGridHtml([
      ["Promoter", stock.shareholding.promoter_holding_change_pct],
      ["FII", stock.shareholding.fii_holding_change_pct],
      ["DII", stock.shareholding.dii_holding_change_pct],
    ])}</div>`;
  } else {
    shareholdingHtml = `<div class="detail-section"><h6>Shareholding change</h6><span class="empty-note">Not available this run (NSE source often blocks automated requests).</span></div>`;
  }

  return `
    ${priceChartSectionHtml(stock)}
    ${rangeSectionHtml(ind)}
    ${explanationSectionHtml(stock, flagDefinitions)}
    <div class="detail-section"><h6>Why ${stock.flags.flag_count}/${stock.flags.flag_total}</h6>${checkRows}</div>
    <div class="detail-section"><h6>Indicators (${ind.date})</h6>${indicatorsHtml}</div>
    ${fundamentalsHtml}
    ${eventsSectionHtml(stock)}
    ${analystSectionHtml(stock)}
    ${shareholdingHtml}
  `;
}

function attachRowToggle(container, rowEl, stock, flagDefinitions) {
  rowEl.addEventListener("click", () => {
    const existingPanel = container.querySelector(".detail-panel");
    const wasOpen = existingPanel !== null;
    if (existingPanel) existingPanel.remove();
    container.classList.toggle("expanded", !wasOpen);
    if (wasOpen) return;

    const panel = document.createElement("div");
    panel.className = "detail-panel";
    panel.innerHTML = renderDetailPanelHtml(stock, flagDefinitions);
    container.appendChild(panel);
  });
}

const FAVORITES_KEY = "nse-dashboard-favorites";

function getFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function isFavorite(symbol) {
  return getFavorites().has(symbol);
}

function toggleFavorite(symbol) {
  const favs = getFavorites();
  if (favs.has(symbol)) {
    favs.delete(symbol);
  } else {
    favs.add(symbol);
  }
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(favs)));
  return favs.has(symbol);
}

function filterFavorites(stocks) {
  const favs = getFavorites();
  return stocks.filter((stock) => favs.has(stock.symbol));
}

function emaStatusHtml(ind) {
  const emas = [["20", ind.ema20], ["50", ind.ema50], ["200", ind.ema200]];
  return emas
    .map(([label, ema]) => {
      if (ema === null || ema === undefined) return `<span class="ema-dot na" title="EMA${label} unavailable">E${label}</span>`;
      const above = ind.close > ema;
      return `<span class="ema-dot ${above ? "above" : "below"}" title="Close ${above ? "above" : "below"} EMA${label}">E${label}</span>`;
    })
    .join("");
}

function mini52wBarHtml(ind) {
  if (ind.low_52w === null || ind.low_52w === undefined || ind.high_52w === null || ind.high_52w === undefined) return "";
  const span = ind.high_52w - ind.low_52w || 1;
  const pos = Math.max(0, Math.min(100, ((ind.close - ind.low_52w) / span) * 100));
  return `<span class="mini-range" title="52-week range · ${formatPrice(ind.low_52w)} – ${formatPrice(ind.high_52w)}">
    <span class="mini-range-track"><span class="mini-range-marker" style="left:${pos.toFixed(1)}%"></span></span>
    <span class="mini-range-label">52w</span>
  </span>`;
}

function createStockBlock(stock, rank, flagDefinitions, options = {}) {
  const { flag_count, flag_total, flags_on } = stock.flags;
  const ind = stock.indicators;
  const change = formatChangePct(ind.change_pct);

  const block = document.createElement("div");
  block.className = "stock-block";

  const ratio = volumeRatio(ind);
  const sr = supportResistance(stock);
  const atrPct = ind.atr14 != null && ind.close ? (ind.atr14 / ind.close) * 100 : null;
  const macdBull = ind.macd != null && ind.macd_signal != null ? ind.macd > ind.macd_signal : null;

  const metrics = [
    ["RSI", ind.rsi14 != null ? ind.rsi14.toFixed(1) : "—", ind.rsi14 != null ? (ind.rsi14 >= 50 ? "up" : "down") : ""],
    ["MACD", macdBull === null ? "—" : macdBull ? "▲ bull" : "▼ bear", macdBull === null ? "" : macdBull ? "up" : "down"],
    ["ATR", ind.atr14 != null ? `${ind.atr14.toFixed(1)}${atrPct !== null ? ` (${atrPct.toFixed(1)}%)` : ""}` : "—", ""],
    ["Vol", ratio !== null ? `${ratio.toFixed(1)}×20d` : "—", ratio === null ? "" : ratio >= 1.4 ? "up" : ratio < 0.6 ? "down" : ""],
    ["Sup", sr ? formatPrice(sr.support) : "—", ""],
    ["Res", sr ? formatPrice(sr.resistance) : "—", ""],
  ];
  const metricsHtml = metrics
    .map(([k, v, cls]) => `<span class="m"><span class="mk">${k}</span> <span class="mv ${cls}">${v}</span></span>`)
    .join("");

  const chips = flags_on
    .map((k) => `<span class="flag on sm">${flagShortLabel(flagDefinitions, k)}</span>`)
    .join("");
  const missing = flag_total - flag_count;

  const row = document.createElement("div");
  row.className = "stock-row enhanced";
  row.innerHTML = `
    <div class="sr-top">
      <div class="left">
        <button type="button" class="star-btn" aria-label="Toggle favorite" title="Favorite"></button>
        <div class="rank">${rank}</div>
        <div class="name-wrap">
          <div class="name">${stock.symbol}<span class="sector-badge">${stock.sector || "—"}</span></div>
          <div class="flags-mini"><span class="flag-count ${flagCountClass(flag_count, flag_total)}">${flag_count}/${flag_total}</span></div>
        </div>
      </div>
      <div class="mid">${emaStatusHtml(ind)}${mini52wBarHtml(ind)}</div>
      <div class="right">
        <div class="price">${formatPrice(ind.close)}</div>
        <div class="chg ${change.cls}">${change.text}</div>
      </div>
    </div>
    <div class="sr-metrics mono">${metricsHtml}</div>
    <div class="sr-flags">${chips || `<span class="no-flags">no bullish flags fired</span>`}${missing > 0 && chips ? `<span class="flags-missing">+${missing} not met</span>` : ""}</div>
  `;

  const starBtn = row.querySelector(".star-btn");
  const applyStarState = (fav) => {
    starBtn.textContent = fav ? "★" : "☆";
    starBtn.classList.toggle("active", fav);
  };
  applyStarState(isFavorite(stock.symbol));
  starBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowFav = toggleFavorite(stock.symbol);
    applyStarState(nowFav);
    if (options.onFavoriteToggle) options.onFavoriteToggle(stock.symbol, nowFav);
  });

  block.appendChild(row);
  attachRowToggle(block, row, stock, flagDefinitions);
  return block;
}

function filterStocksByQuery(stocks, query) {
  if (!query) return stocks;
  const q = query.toLowerCase();
  return stocks.filter(
    (stock) =>
      stock.symbol.toLowerCase().includes(q) ||
      (stock.name && stock.name.toLowerCase().includes(q)) ||
      (stock.sector && stock.sector.toLowerCase().includes(q))
  );
}

function renderStockListInto(container, stocks, flagDefinitions, options = {}) {
  container.innerHTML = "";
  stocks.forEach((stock, index) => {
    container.appendChild(createStockBlock(stock, index + 1, flagDefinitions, options));
  });
}

function renderSectorGroupsInto(container, stocks, flagDefinitions, options = {}) {
  const forceExpand = !!options.forceExpand;
  container.innerHTML = "";
  const groups = new Map();
  stocks.forEach((stock) => {
    const sector = stock.sector || "Uncategorized";
    if (!groups.has(sector)) groups.set(sector, []);
    groups.get(sector).push(stock);
  });

  const sectorNames = Array.from(groups.keys()).sort((a, b) => {
    const avgA = groups.get(a).reduce((s, st) => s + st.flags.flag_count / st.flags.flag_total, 0) / groups.get(a).length;
    const avgB = groups.get(b).reduce((s, st) => s + st.flags.flag_count / st.flags.flag_total, 0) / groups.get(b).length;
    return avgB - avgA;
  });

  sectorNames.forEach((sector) => {
    const sectorStocks = groups.get(sector).sort((a, b) => b.flags.flag_count - a.flags.flag_count);
    const group = document.createElement("div");
    group.className = "sector-group" + (forceExpand ? "" : " collapsed");

    const header = document.createElement("div");
    header.className = "sector-group-header";
    header.innerHTML = `
      <span class="name"><span class="chevron">▸</span> ${sector}</span>
      <span class="meta">${sectorStocks.length} stock${sectorStocks.length === 1 ? "" : "s"}</span>
    `;
    header.addEventListener("click", () => group.classList.toggle("collapsed"));
    group.appendChild(header);

    const list = document.createElement("div");
    list.className = "sector-group-body";
    sectorStocks.forEach((stock, index) => list.appendChild(createStockBlock(stock, index + 1, flagDefinitions, options)));
    group.appendChild(list);
    container.appendChild(group);
  });
}

function initTabs(tabBarEl, onChange) {
  const buttons = Array.from(tabBarEl.querySelectorAll(".tab-btn"));
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(btn.dataset.tab);
    });
  });
}

function initRefreshButton(buttonEl, renderFn) {
  buttonEl.addEventListener("click", async () => {
    if (buttonEl.classList.contains("is-loading")) return;
    const icon = buttonEl.querySelector(".icon");
    const label = buttonEl.querySelector(".label");
    const originalLabel = label ? label.textContent : "";
    buttonEl.classList.add("is-loading");
    if (icon) icon.classList.add("spin");
    if (label) label.textContent = "Refreshing…";
    try {
      await renderFn();
    } catch (err) {
      console.error(err);
    } finally {
      buttonEl.classList.remove("is-loading");
      if (icon) icon.classList.remove("spin");
      if (label) label.textContent = originalLabel;
    }
  });
}

function formatUpdatedAt(isoString) {
  if (!isoString) return "unknown";
  const date = new Date(isoString);
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
}

window.dashboardUtils = {
  loadMeta,
  loadFlagDefinitions,
  loadPortfolio,
  loadSectors,
  loadStock,
  loadAllStocks,
  loadMarket,
  loadNews,
  volumeRatio,
  supportResistance,
  debtToEquityRatio,
  dividendYieldPct,
  returnOverSessions,
  isBreakoutCandidate,
  isSilentAccumulation,
  isNearBuyZone,
  isWeakening,
  buildExplanation,
  formatVolume,
  formatEventDate,
  flagCountClass,
  pillStatusClass,
  sectorBarClass,
  formatPrice,
  formatChangePct,
  flagShortLabel,
  renderDetailPanelHtml,
  attachRowToggle,
  filterStocksByQuery,
  filterFavorites,
  isFavorite,
  toggleFavorite,
  createStockBlock,
  renderStockListInto,
  renderSectorGroupsInto,
  initTabs,
  initRefreshButton,
  formatUpdatedAt,
};
