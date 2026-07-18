// =====================================================================================
// RECOMMENDATIONS PAGE — "out of every stock I track, which ones deserve my attention
// today?" Completely rule-based, computed client-side from the published per-stock
// JSON. No AI, no black boxes: every score is a fixed, documented weighted formula
// whose point-by-point breakdown is displayed on the card.
//
// NOTE (2026-07-18): the earlier "no composite score / no targets / no verdicts"
// hard rule was explicitly revoked by the owner. This page now shows:
//   Opportunity Score (0–100)  — weighted: flags 50 + entry checks 30 + sector 10
//                                + risk headroom 10
//   Entry Quality (0–100)      — weighted entry checks (weights shown per check)
//   Risk Meter (0–100)         — risk conditions 70 + ATR volatility 30
//   Confidence (0–100)         — data completeness 60 + check evaluability 40
//   Entry tiers incl. "Avoid", ideal buy zone, target, stop loss, risk:reward,
//   holding style, and directive actions ("Can be considered today", "Avoid
//   chasing", …).
// The transparency requirement stays: unevaluable inputs are shown as missing
// (never guessed), and every number's formula is visible in the UI.
// =====================================================================================
(function () {
  const U = window.dashboardUtils;
  const P = window.Platform;
  const fp = U.formatPrice;

  // ---------------- Entry conditions (7 named checks, weighted) ----------------
  // value: true / false / null (null = not evaluable from today's data — excluded
  // from both numerator and denominator, never guessed).

  const CHECK_WEIGHTS = { proximity: 25, trend: 20, macd: 15, rsi: 12, volume: 10, geometry: 10, sector: 8 };

  function rangeGeometry(stock) {
    const ind = stock.indicators;
    const sr = U.supportResistance(stock);
    if (!sr || ind.close == null) return null;
    const up = sr.resistance - ind.close;
    const down = ind.close - sr.support;
    return {
      sr,
      upPct: (up / ind.close) * 100,
      downPct: (down / ind.close) * 100,
      ratio: up > 0 && down > 0 ? up / down : null,
      atTop: ind.close >= sr.resistance,
      atBottom: ind.close <= sr.support,
    };
  }

  function pullbackZone(ind) {
    const emas = [ind.ema20, ind.ema50].filter((e) => e != null);
    if (!emas.length) return null;
    return { lo: Math.min(...emas) * 0.98, hi: Math.max(...emas) * 1.02 };
  }

  // Target / stop-loss / risk:reward from the 20-session range and ATR.
  // Range setup: target = resistance, stop = support − 0.5×ATR.
  // Breakout (close at/above resistance): target = close + range height (measured
  // move), stop = resistance − 0.5×ATR (failed-retest invalidation).
  function tradeLevels(stock, geo) {
    const ind = stock.indicators;
    if (!geo?.sr || ind.close == null) return null;
    const atrPad = ind.atr14 != null ? 0.5 * ind.atr14 : 0;
    let target, stop, basis;
    if (geo.atTop) {
      target = ind.close + (geo.sr.resistance - geo.sr.support);
      stop = geo.sr.resistance - atrPad;
      basis = "breakout: target = close + 20-session range height; stop = resistance − 0.5×ATR";
    } else {
      target = geo.sr.resistance;
      stop = geo.sr.support - atrPad;
      basis = "range: target = 20-session resistance; stop = support − 0.5×ATR";
    }
    const rr = target > ind.close && ind.close > stop ? (target - ind.close) / (ind.close - stop) : null;
    return { target, stop, rr, basis };
  }

  function buildEntryChecks(stock, sectorPct) {
    const ind = stock.indicators;
    const ratio = U.volumeRatio(ind);
    const geo = rangeGeometry(stock);
    const checks = [];
    const add = (key, label, value, detail) => checks.push({ key, label, value, detail, weight: CHECK_WEIGHTS[key] });

    const trendOk = ind.ema50 != null && ind.ema200 != null && ind.close != null
      ? ind.ema50 > ind.ema200 && ind.close > ind.ema200
      : null;
    add("trend", "Strong trend", trendOk,
      trendOk === null ? "EMA data missing"
        : `EMA50 ${fp(ind.ema50)} ${ind.ema50 > ind.ema200 ? ">" : "<"} EMA200 ${fp(ind.ema200)}, close ${ind.close > ind.ema200 ? "above" : "below"} EMA200`);

    const isPullback = U.isNearBuyZone(stock);
    const isConfirmedBreakout = U.isBreakoutCandidate(stock) && ratio != null && ratio >= 1.5;
    add("proximity", "Healthy pullback / confirmed breakout", isPullback || isConfirmedBreakout,
      isPullback ? "uptrend, price within ±2% of its EMA20/50 buy zone"
        : isConfirmedBreakout ? `pressing upper band / 52w high with ${ratio.toFixed(1)}× volume`
        : "price is neither in the EMA20/50 buy zone nor in a volume-confirmed breakout");

    const macdOk = ind.macd != null && ind.macd_signal != null ? ind.macd > ind.macd_signal : null;
    add("macd", "MACD bullish", macdOk,
      macdOk === null ? "MACD data missing" : `MACD ${ind.macd.toFixed(2)} vs signal ${ind.macd_signal.toFixed(2)}`);

    const rsiOk = ind.rsi14 != null ? ind.rsi14 >= 40 && ind.rsi14 <= 65 : null;
    add("rsi", "RSI healthy (40–65)", rsiOk,
      rsiOk === null ? "RSI data missing"
        : `RSI(14) ${ind.rsi14.toFixed(1)}${rsiOk ? "" : ind.rsi14 > 65 ? " — extended" : " — weak"}`);

    const volOk = ratio != null ? ratio >= 1.2 : null;
    add("volume", "Volume confirmation (≥1.2×)", volOk,
      volOk === null ? "volume data missing" : `today ${ratio.toFixed(1)}× the 20-day average`);

    add("sector", "Sector strength (≥50% avg flags)", sectorPct != null ? sectorPct >= 50 : null,
      sectorPct != null ? `${stock.sector || "sector"} averages ${sectorPct}% of the 8 flags` : "sector data missing");

    let geoVal = null, geoDetail = "20-session range not measurable (short history)";
    if (geo) {
      if (geo.atTop) {
        geoDetail = "price is at/above its 20-session high — breakout geometry applies (see target/stop)";
        geoVal = null;
      } else if (geo.ratio != null) {
        geoVal = geo.ratio >= 1.5;
        geoDetail = `+${geo.upPct.toFixed(1)}% to resistance vs −${geo.downPct.toFixed(1)}% to support (${geo.ratio.toFixed(1)}:1)`;
      } else if (geo.atBottom) {
        geoDetail = "price is at/below its 20-session low — downside distance is zero";
        geoVal = false;
      }
    }
    add("geometry", "Good risk:reward geometry (≥1.5:1)", geoVal, geoDetail);

    const evaluated = checks.filter((c) => c.value !== null);
    return {
      checks,
      passed: evaluated.filter((c) => c.value).length,
      evaluated: evaluated.length,
      geo,
      levels: tradeLevels(stock, geo),
    };
  }

  // ---------------- The four scores (fixed weighted formulas, breakdown shown) -------

  function opportunityScore(stock, entry, sectorPct) {
    const risk = stock.decision?.risk;
    const parts = [];
    const flagPts = (stock.flags.flag_count / stock.flags.flag_total) * 50;
    parts.push({ label: `Bullish flags ${stock.flags.flag_count}/${stock.flags.flag_total}`, pts: flagPts, max: 50 });
    const entryPts = entry.evaluated ? (entry.passed / entry.evaluated) * 30 : 0;
    parts.push({ label: `Entry checks ${entry.passed}/${entry.evaluated}`, pts: entryPts, max: 30 });
    const sectorPts = sectorPct != null ? (sectorPct / 100) * 10 : 0;
    parts.push({ label: sectorPct != null ? `Sector strength ${sectorPct}%` : "Sector strength (missing → 0)", pts: sectorPts, max: 10 });
    const riskPts = risk ? (1 - risk.condition_count / risk.condition_total) * 10 : 0;
    parts.push({ label: risk ? `Risk headroom (${risk.condition_count}/${risk.condition_total} conditions)` : "Risk headroom (missing → 0)", pts: riskPts, max: 10 });
    return { value: Math.round(parts.reduce((s, p) => s + p.pts, 0)), parts };
  }

  function entryQualityScore(entry) {
    const evaluated = entry.checks.filter((c) => c.value !== null);
    const denom = evaluated.reduce((s, c) => s + c.weight, 0);
    if (!denom) return { value: 0, parts: [{ label: "no checks evaluable", pts: 0, max: 100 }] };
    const num = evaluated.filter((c) => c.value).reduce((s, c) => s + c.weight, 0);
    return {
      value: Math.round((num / denom) * 100),
      parts: entry.checks.map((c) => ({
        label: `${c.label} (w${c.weight})`,
        pts: c.value ? c.weight : 0,
        max: c.weight,
        na: c.value === null,
      })),
    };
  }

  function riskScore(stock) {
    const risk = stock.decision?.risk;
    const ind = stock.indicators;
    if (!risk) return null; // decision block missing — shown as n/a, never guessed
    const parts = [];
    const condPts = (risk.condition_count / risk.condition_total) * 70;
    parts.push({ label: `Risk conditions ${risk.condition_count}/${risk.condition_total} (${risk.conditions_on.map((k) => k.replace(/_/g, " ")).join(", ") || "none"})`, pts: condPts, max: 70 });
    const atrPct = ind.atr14 != null && ind.close ? (ind.atr14 / ind.close) * 100 : null;
    const volPts = atrPct != null ? Math.min(1, atrPct / 5) * 30 : 0;
    parts.push({ label: atrPct != null ? `Volatility — ATR ${atrPct.toFixed(1)}% of price (5% = max)` : "Volatility (ATR missing → 0)", pts: volPts, max: 30 });
    return { value: Math.round(condPts + volPts), parts };
  }

  function confidenceScore(stock, entry) {
    const sources = [stock.indicators, stock.fundamentals, stock.analyst, stock.events, stock.shareholding];
    const present = sources.filter(Boolean).length;
    const parts = [
      { label: `Data sources present ${present}/5`, pts: (present / 5) * 60, max: 60 },
      { label: `Entry checks evaluable ${entry.evaluated}/7`, pts: (entry.evaluated / 7) * 40, max: 40 },
    ];
    return { value: Math.round(parts.reduce((s, p) => s + p.pts, 0)), parts };
  }

  // ---------------- Recommendation tier (score thresholds; "Avoid" included) ---------

  const TIERS = {
    excellent: { label: "Excellent Entry", cls: "t-excellent", order: 0 },
    good: { label: "Good Entry", cls: "t-good", order: 1 },
    watch: { label: "Watch", cls: "t-watch", order: 2 },
    wait: { label: "Wait", cls: "t-wait", order: 3 },
    avoid: { label: "Avoid", cls: "t-none", order: 4 },
    none: { label: "No setup today", cls: "t-none", order: 4 }, // legacy history key
  };

  function isExtended(ind) {
    const extPct = ind.ema20 != null && ind.close != null ? ((ind.close - ind.ema20) / ind.ema20) * 100 : null;
    return (ind.rsi14 != null && ind.rsi14 > 70) || (extPct != null && extPct >= 8);
  }

  function classifyTier(stock, scores, entry) {
    const { opp, eq, risk } = scores;
    const extended = isExtended(stock.indicators);
    const rr = entry.levels?.rr;
    if (risk != null && risk.value >= 75)
      return { key: "avoid", rule: `Risk meter ${risk.value} ≥75 forces Avoid` };
    if (opp.value >= 75 && eq.value >= 70 && (risk == null || risk.value <= 35) && !extended && (rr == null || rr >= 1))
      return { key: "excellent", rule: "Opportunity ≥75 + Entry quality ≥70 + Risk ≤35, not extended, R:R ≥1 when computable" };
    if (opp.value >= 60 && eq.value >= 55 && (risk == null || risk.value <= 55) && !extended)
      return { key: "good", rule: "Opportunity ≥60 + Entry quality ≥55 + Risk ≤55, not extended" };
    if (opp.value >= 45 || eq.value >= 50)
      return {
        key: "watch",
        rule: extended ? "extended (RSI >70 or ≥8% above EMA20) caps the tier at Watch" : "Opportunity ≥45 or Entry quality ≥50",
      };
    if (opp.value >= 30) return { key: "wait", rule: "Opportunity 30–44 — base strength present, entry not there" };
    return { key: "avoid", rule: "Opportunity <30" };
  }

  // ---------------- Holding style (auto-determined from the setup) ----------------
  // Intraday is never assigned — the pipeline only has daily data, and the UI says so.

  function holdingStyle(stock) {
    const trend = stock.decision?.trend || {};
    const pat = stock.decision?.patterns || {};
    const ind = stock.indicators;
    const risk = stock.decision?.risk;
    if (trend.weekly === "bullish" && ind.ema200 != null && ind.close > ind.ema200 && stock.flags.flag_count >= 6 && risk && risk.level === "low")
      return { key: "longterm", label: "Long Term", why: "weekly + daily structure aligned, ≥6/8 flags, low risk — durable trend" };
    if (trend.weekly === "bullish" && trend.daily === "bullish")
      return { key: "positional", label: "Positional", why: "weekly and daily trends aligned — weeks-to-months structure" };
    if (pat.breakout || pat.volume_surge || pat.near_buy_zone || trend.daily === "bullish")
      return { key: "swing", label: "Swing", why: "breakout / volume / pullback signals — days-to-weeks setups" };
    return { key: "unclear", label: "Unclear", why: "today's signals don't support a defined holding style" };
  }

  // ---------------- Action ----------------

  function buildAction(stock, entry, tier, scores) {
    const ind = stock.indicators;
    const ratio = U.volumeRatio(ind);
    const geo = entry.geo;
    const zone = pullbackZone(ind);
    const extPct = ind.ema20 != null && ind.close != null ? ((ind.close - ind.ema20) / ind.ema20) * 100 : null;

    if (tier.key === "avoid")
      return scores.risk != null && scores.risk.value >= 75
        ? `Avoid — risk meter ${scores.risk.value}/100 (${stock.decision.risk.condition_count}/6 risk conditions + volatility).`
        : `No setup today — opportunity score ${scores.opp.value}/100.`;
    if (isExtended(ind)) {
      const bits = [];
      if (extPct != null && extPct >= 8) bits.push(`${extPct.toFixed(1)}% above EMA20`);
      if (ind.rsi14 != null && ind.rsi14 > 70) bits.push(`RSI ${ind.rsi14.toFixed(0)}`);
      return `Avoid chasing — ${bits.join(", ")}.${zone ? ` Watch for a pullback to ${fp(zone.lo)}–${fp(zone.hi)}.` : ""}`;
    }
    if (tier.key === "excellent") return `Can be considered today — ${entry.passed}/${entry.evaluated} entry checks aligned at ${fp(ind.close)}.`;
    if (tier.key === "good" && U.isNearBuyZone(stock) && zone)
      return `Can be considered near the buy zone — price is inside ${fp(zone.lo)}–${fp(zone.hi)}.`;
    if (U.isBreakoutCandidate(stock) && (ratio == null || ratio < 1.5) && geo?.sr)
      return `Wait for breakout — needs a close above ${fp(geo.sr.resistance)} with volume ≥1.5× average (today ${ratio != null ? ratio.toFixed(1) : "—"}×).`;
    if (zone && ind.close > zone.hi && ind.ema50 != null && ind.ema200 != null && ind.ema50 > ind.ema200)
      return `Watch for pullback to ${fp(zone.lo)}–${fp(zone.hi)} (±2% of EMA20/50).`;
    if (geo?.sr && ind.close <= geo.sr.support * 1.02)
      return `Wait near support ${fp(geo.sr.support)} — no stabilization signal yet${ind.rsi14 != null ? ` (RSI ${ind.rsi14.toFixed(0)})` : ""}.`;
    if (tier.key === "good" || tier.key === "watch")
      return `Setup forming — ${entry.passed}/${entry.evaluated} entry checks met; see wait conditions below.`;
    return `Wait — opportunity ${scores.opp.value}/100, entry quality ${scores.eq.value}/100.`;
  }

  // ---------------- Wait conditions ----------------

  function buildWaits(stock, entry) {
    const ind = stock.indicators;
    const ratio = U.volumeRatio(ind);
    const zone = pullbackZone(ind);
    const geo = entry.geo;
    const waits = [];
    entry.checks.forEach((c) => {
      if (c.value !== false) return;
      switch (c.key) {
        case "trend":
          if (ind.ema200 != null) waits.push(`Wait until close and EMA50 hold above EMA200 (${fp(ind.ema200)}); close is ${fp(ind.close)}.`);
          break;
        case "proximity": {
          if (zone && ind.close > zone.hi) waits.push(`Wait until price returns to the buy zone ${fp(zone.lo)}–${fp(zone.hi)} (±2% of EMA20/50).`);
          if (geo?.sr && ind.close < geo.sr.resistance) waits.push(`Or: wait for a breakout close above ${fp(geo.sr.resistance)} with volume ≥1.5× average.`);
          break;
        }
        case "macd":
          waits.push(`Wait for MACD (${ind.macd.toFixed(2)}) to cross above its signal (${ind.macd_signal.toFixed(2)}).`);
          break;
        case "rsi":
          waits.push(ind.rsi14 > 65
            ? `Wait for RSI ${ind.rsi14.toFixed(1)} to cool back into 40–65.`
            : `Wait for RSI ${ind.rsi14.toFixed(1)} to recover into 40–65.`);
          break;
        case "volume":
          waits.push(`Wait for volume ≥1.2× the 20-day average (today ${ratio.toFixed(1)}×).`);
          break;
        case "sector":
          waits.push(`Sector is weak — the check passes when ${stock.sector || "the sector"} averages ≥50% of the flags.`);
          break;
        case "geometry":
          if (geo?.ratio != null) waits.push(`Risk:reward geometry is ${geo.ratio.toFixed(1)}:1 (needs ≥1.5:1) — improves near support ${fp(geo.sr.support)}.`);
          else if (geo?.atBottom) waits.push(`Price sits at its 20-session low — wait for the range to re-form above support.`);
          break;
      }
    });
    return waits.slice(0, 4);
  }

  // ---------------- Warnings ----------------

  function buildWarnings(stock, entry, data) {
    const ind = stock.indicators;
    const risk = stock.decision?.risk;
    const ratio = U.volumeRatio(ind);
    const geo = entry.geo;
    const warnings = [];
    if (risk) risk.conditions_on.forEach((k) => warnings.push(risk.conditions_detail?.[k] || k.replace(/_/g, " ")));
    if (geo?.sr && !geo.atTop && ind.close >= geo.sr.resistance * 0.98)
      warnings.push(`Near resistance — within 2% of ${fp(geo.sr.resistance)}`);
    if (ratio != null && ratio < 0.6) warnings.push(`Low volume — only ${ratio.toFixed(1)}× the 20-day average`);
    if (entry.levels?.rr != null && entry.levels.rr < 1) warnings.push(`Poor risk:reward — ${entry.levels.rr.toFixed(1)}:1 to target vs stop`);
    const sectorPct = sectorPctFor(stock, data);
    if (sectorPct != null && sectorPct < 37.5) warnings.push(`Weak sector — ${stock.sector} averages ${sectorPct}% of the flags`);
    const ev = stock.events;
    if (ev && Array.isArray(ev.earnings_dates)) {
      const soon = ev.earnings_dates.map((d) => new Date(d)).find((d) => !isNaN(d) && d >= new Date() && d - new Date() < 14 * 24 * 3600 * 1000);
      if (soon) warnings.push(`Upcoming earnings within 2 weeks (${U.formatEventDate(soon.toISOString())})`);
    }
    return warnings;
  }

  function sectorPctFor(stock, data) {
    return data.sectors?.find((s) => s.sector === stock.sector)?.avg_flag_pct ?? null;
  }

  // ---------------- History (localStorage, this browser only — no backend) ------------

  const HIST_KEY = "nse-reco-history";

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || "{}"); } catch { return {}; }
  }

  function snapshotHistory(dataDate, tiersBySymbol) {
    const all = loadHistory();
    all[dataDate] = tiersBySymbol;
    const dates = Object.keys(all).sort();
    while (dates.length > 30) delete all[dates.shift()];
    try { localStorage.setItem(HIST_KEY, JSON.stringify(all)); } catch { /* storage full/private */ }
    return all;
  }

  function previousTier(history, dataDate, symbol) {
    const prevDate = Object.keys(history).filter((d) => d < dataDate).sort().pop();
    if (!prevDate) return null;
    const tier = history[prevDate]?.[symbol];
    return tier ? { date: prevDate, tier } : null;
  }

  // ---------------- Evaluate one stock ----------------

  function evaluate(stock, data) {
    const sectorPct = sectorPctFor(stock, data);
    const entry = buildEntryChecks(stock, sectorPct);
    const scores = {
      opp: opportunityScore(stock, entry, sectorPct),
      eq: entryQualityScore(entry),
      risk: riskScore(stock),
      conf: confidenceScore(stock, entry),
    };
    const tier = classifyTier(stock, scores, entry);
    return {
      entry,
      scores,
      tier,
      style: holdingStyle(stock),
      action: buildAction(stock, entry, tier, scores),
      waits: buildWaits(stock, entry),
      warnings: buildWarnings(stock, entry, data),
    };
  }

  // ---------------- Rendering ----------------

  function gaugeBlock(score, caption, cls, title, invert = false) {
    if (score == null) return `<div class="reco-gauge" title="${title}"><span class="empty-note sm">n/a</span><span class="reco-gauge-cap">${caption}</span></div>`;
    return `<div class="reco-gauge" title="${title}">
      ${P.ringHtml(score.value / 100, `${score.value}`, { size: 48, stroke: 4.5, cls })}
      <span class="reco-gauge-cap">${caption}</span>
    </div>`;
  }

  function scoreCls(v, invert = false) {
    const x = invert ? 100 - v : v;
    return x >= 65 ? "up" : x >= 40 ? "warn" : "down";
  }

  function gaugesHtml(evalr) {
    const { opp, eq, risk, conf } = evalr.scores;
    return `<div class="reco-gauges">
      ${gaugeBlock(opp, "Opportunity", scoreCls(opp.value), "Opportunity Score 0–100: flags ×50 + entry checks ×30 + sector ×10 + risk headroom ×10 — breakdown in the card")}
      ${gaugeBlock(eq, "Entry quality", scoreCls(eq.value), "Entry Quality 0–100: weighted entry checks (weights shown in the checklist)")}
      ${gaugeBlock(risk, "Risk", risk ? scoreCls(risk.value, true) : "", "Risk Meter 0–100: risk conditions ×70 + ATR volatility ×30 — higher = riskier")}
      ${gaugeBlock(conf, "Confidence", "accent", "Confidence 0–100: data sources present ×60 + entry checks evaluable ×40")}
    </div>`;
  }

  function scoreBreakdownHtml(evalr) {
    const row = (name, score) => score == null
      ? `<div class="score-part"><span class="sp-name">${name}</span><span class="sp-pts mono">n/a — decision block missing</span></div>`
      : `<div class="score-part head"><span class="sp-name">${name}</span><span class="sp-pts mono">${score.value}/100</span></div>` +
        score.parts.map((p) => `<div class="score-part sub${p.na ? " na" : ""}"><span class="sp-name">${p.label}${p.na ? " (not evaluated)" : ""}</span><span class="sp-pts mono">${p.na ? "—" : `${p.pts.toFixed(0)}/${p.max}`}</span></div>`).join("");
    return row("Opportunity Score", evalr.scores.opp) + row("Entry Quality", evalr.scores.eq) + row("Risk Meter", evalr.scores.risk) + row("Confidence", evalr.scores.conf);
  }

  // Entry map — buy zone, support, resistance, target, stop loss and last close on one
  // horizontal price scale, with the risk:reward ratio underneath.
  function entryMapHtml(stock, evalr) {
    const ind = stock.indicators;
    const geo = evalr.entry.geo;
    const zone = pullbackZone(ind);
    const lv = evalr.entry.levels;
    if (!geo?.sr || ind.close == null) {
      return `<div class="empty-note sm">Entry map needs ≥10 sessions of price history — not available for this stock yet.</div>`;
    }
    const { sr } = geo;
    const atr = ind.atr14;
    const values = [sr.support, sr.resistance, ind.close];
    if (zone) values.push(zone.lo, zone.hi);
    if (lv) values.push(lv.target, lv.stop);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const pad = span * 0.06;
    const x = (v) => (((v - (lo - pad)) / (span + 2 * pad)) * 100).toFixed(2);

    const zoneHtml = zone
      ? `<span class="em-zone" style="left:${x(zone.lo)}%;width:${(x(zone.hi) - x(zone.lo)).toFixed(2)}%" title="Ideal buy zone: ±2% of EMA20/50 (${fp(zone.lo)}–${fp(zone.hi)})"></span>`
      : "";

    const rrLine = lv?.rr != null
      ? `Risk:reward <b>${lv.rr.toFixed(1)}:1</b> — target ${fp(lv.target)} (<b class="up">+${(((lv.target - ind.close) / ind.close) * 100).toFixed(1)}%</b>) vs stop ${fp(lv.stop)} (<b class="down">−${(((ind.close - lv.stop) / ind.close) * 100).toFixed(1)}%</b>).`
      : `Risk:reward not computable at the current price (outside the target/stop bracket).`;

    return `<div class="entry-map">
      <div class="em-track">
        ${zoneHtml}
        ${lv ? `<span class="em-tick stop" style="left:${x(lv.stop)}%" title="Stop loss ${fp(lv.stop)}"></span>` : ""}
        <span class="em-tick support" style="left:${x(sr.support)}%" title="20-session support ${fp(sr.support)}"></span>
        <span class="em-tick resistance" style="left:${x(sr.resistance)}%" title="20-session resistance ${fp(sr.resistance)}"></span>
        ${lv ? `<span class="em-tick target" style="left:${x(lv.target)}%" title="Target ${fp(lv.target)}"></span>` : ""}
        <span class="em-price" style="left:${x(ind.close)}%" title="Last close ${fp(ind.close)}"></span>
      </div>
      <div class="em-labels mono">
        ${lv ? `<span class="em-l down">SL ${fp(lv.stop)}</span>` : ""}
        <span class="em-l down">S ${fp(sr.support)}</span>
        ${zone ? `<span class="em-l zone">buy ${fp(zone.lo)}–${fp(zone.hi)}</span>` : ""}
        <span class="em-l now">now ${fp(ind.close)}</span>
        <span class="em-l up">R ${fp(sr.resistance)}</span>
        ${lv ? `<span class="em-l target">T ${fp(lv.target)}</span>` : ""}
      </div>
      <div class="fine">${rrLine}</div>
      <div class="fine dim">${lv ? lv.basis : ""}. S/R = lowest/highest close of the last 20 sessions (${sr.basis}); buy zone = ±2% of EMA20/50${atr != null ? `; ATR ${fp(atr)} ≈ ${((atr / ind.close) * 100).toFixed(1)}%/day` : ""}.</div>
    </div>`;
  }

  function checklistHtml(evalr) {
    return evalr.entry.checks
      .map((c) => {
        const mark = c.value === null ? `<span class="mark na">·</span>` : `<span class="mark ${c.value ? "pass" : "fail"}">${c.value ? "✓" : "✗"}</span>`;
        return `<div class="check-row">${mark}<span class="label">${c.label} <span class="dim">(w${c.weight})</span> — ${c.detail}${c.value === null ? " (not evaluated)" : ""}</span></div>`;
      })
      .join("");
  }

  function historyHtml(prev, tierKey, dataDate) {
    if (!prev) return `<div class="fine dim">Recommendation history starts today (${dataDate}) — snapshots are stored in this browser only.</div>`;
    const from = TIERS[prev.tier]?.label || prev.tier;
    const to = TIERS[tierKey].label;
    const moved = prev.tier !== tierKey;
    return `<div class="reco-history-row">
      <span class="reco-hist-tier ${TIERS[prev.tier]?.cls || ""}">${from}</span>
      <span class="reco-hist-arrow">${moved ? "→" : "="}</span>
      <span class="reco-hist-tier ${TIERS[tierKey].cls}">${to}</span>
      <span class="fine dim">${prev.date} → ${dataDate}${moved ? "" : " · unchanged"}</span>
    </div>`;
  }

  function historyChip(prev, tierKey) {
    if (!prev || prev.tier === tierKey) return "";
    const improved = (TIERS[prev.tier]?.order ?? 9) > TIERS[tierKey].order;
    return `<span class="reco-move ${improved ? "up" : "down"}" title="Recommendation moved since ${prev.date} (stored in this browser)">${improved ? "▲" : "▼"} was: ${TIERS[prev.tier]?.label || prev.tier}</span>`;
  }

  function cardHtml(stock, evalr, prev, dataDate, rank) {
    const ind = stock.indicators;
    const chg = U.formatChangePct(ind.change_pct);
    const tier = TIERS[evalr.tier.key];
    return `
      <article class="reco-card ${tier.cls}" data-symbol="${stock.symbol}">
        <div class="reco-head">
          <div class="reco-id">
            <span class="reco-rank mono">${rank}</span>
            <div class="reco-namewrap">
              <button class="reco-sym" data-jump="${stock.symbol}" title="Open ${stock.symbol} in the watchlist">${stock.symbol}</button>
              <div class="reco-name">${stock.name || ""}<span class="sector-badge">${stock.sector || "—"}</span></div>
            </div>
          </div>
          <div class="reco-price-col">
            <div class="reco-price mono">${fp(ind.close)}</div>
            <div class="chg mono ${chg.cls}">${chg.text}</div>
          </div>
        </div>
        <div class="reco-tier-row">
          <span class="reco-tier ${tier.cls}" title="Rule: ${evalr.tier.rule}">${tier.label}</span>
          <span class="reco-tf" title="${evalr.style.why}. Auto-determined from the setup. Intraday is never assigned — daily pipeline.">${evalr.style.label}</span>
          ${historyChip(prev, evalr.tier.key)}
        </div>
        ${gaugesHtml(evalr)}
        <div class="reco-action">${evalr.action}</div>
        <div class="reco-badges">
          ${U.attentionStarsHtml(stock)}${U.riskChipHtml(stock, { compact: true })}${U.trendChipsHtml(stock)}${U.dataCompletenessHtml(stock)}
        </div>
        <button class="reco-expand" aria-expanded="false">Why · entry zone · scores · history <span class="reco-caret">▾</span></button>
        <div class="reco-detail" hidden>
          <div class="detail-section"><h6>Entry zone</h6>${entryMapHtml(stock, evalr)}</div>
          <div class="detail-section"><h6>Why recommended · ${evalr.entry.passed}/${evalr.entry.evaluated} entry checks</h6>${checklistHtml(evalr)}
            <div class="fine dim">Tier rule: ${evalr.tier.rule}.</div></div>
          <div class="detail-section"><h6>Score breakdown</h6><div class="score-parts">${scoreBreakdownHtml(evalr)}</div></div>
          <div class="detail-section"><h6>Risks</h6>
            ${evalr.warnings.length ? evalr.warnings.map((w) => `<div class="exp-risk">⚠ ${w}</div>`).join("") : `<div class="fine">No named risk conditions present today — normal market risk still applies.</div>`}
            ${stock.events == null ? `<div class="fine dim">Earnings-date risk not evaluated — the events feed was not collected this run. Gap risk is not evaluated — the pipeline stores daily closes only.</div>` : `<div class="fine dim">Gap risk is not evaluated — the pipeline stores daily closes only.</div>`}
          </div>
          ${evalr.waits.length ? `<div class="detail-section"><h6>Wait conditions</h6>${evalr.waits.map((w) => `<div class="reco-wait">◦ ${w}</div>`).join("")}</div>` : ""}
          <div class="detail-section"><h6>Recommendation history <span class="ext-tag">this browser only</span></h6>${historyHtml(prev, evalr.tier.key, dataDate)}</div>
          <div class="reco-foot">
            <span class="fine dim">Rule-based — every score's formula and inputs are shown above; missing data is shown as missing, never guessed. Personal research, not investment advice.</span>
            <button class="btn btn-ghost btn-sm" data-jump="${stock.symbol}">Full analysis →</button>
          </div>
        </div>
      </article>`;
  }

  // ---------------- Filters ----------------

  const RECO_FILTERS_KEY = "nse-reco-filters";

  function filterDefs() {
    return [
      { key: "excellent", group: "tier", label: "Excellent Entry", fn: (r) => r.evalr.tier.key === "excellent" },
      { key: "good", group: "tier", label: "Good Entry", fn: (r) => r.evalr.tier.key === "good" },
      { key: "watch", group: "tier", label: "Watch", fn: (r) => r.evalr.tier.key === "watch" },
      { key: "wait", group: "tier", label: "Wait", fn: (r) => r.evalr.tier.key === "wait" },
      { key: "avoid", group: "tier", label: "Avoid", fn: (r) => r.evalr.tier.key === "avoid" },
      { key: "swing", group: "tf", label: "Swing", fn: (r) => r.evalr.style.key === "swing" },
      { key: "positional", group: "tf", label: "Positional", fn: (r) => r.evalr.style.key === "positional" },
      { key: "longterm", group: "tf", label: "Long Term", fn: (r) => r.evalr.style.key === "longterm" },
      { key: "highconf", group: "cond", label: "High confidence ≥70", fn: (r) => r.evalr.scores.conf.value >= 70 },
      { key: "lowrisk", group: "cond", label: "Low risk ≤35", fn: (r) => r.evalr.scores.risk != null && r.evalr.scores.risk.value <= 35 },
      { key: "goodrr", group: "cond", label: "R:R ≥1.5", fn: (r) => r.evalr.entry.levels?.rr != null && r.evalr.entry.levels.rr >= 1.5 },
      { key: "pullback", group: "cond", label: "Pullback", fn: (r) => U.isNearBuyZone(r.stock) },
      { key: "breakout", group: "cond", label: "Breakout", fn: (r) => U.isBreakoutCandidate(r.stock) },
      { key: "nearsupport", group: "cond", label: "Near support", fn: (r) => r.evalr.entry.geo?.sr != null && r.stock.indicators.close <= r.evalr.entry.geo.sr.support * 1.02 },
    ];
  }

  // ---------------- Page ----------------

  P.registerPage("recommendations", {
    title: "Recommendations",
    crumb: "Overview",
    render(main, data) {
      const dataDate = (data.changes?.data_date) || (data.meta.run_at || "").slice(0, 10) || "today";

      const rows = data.stocks.map((stock) => ({ stock, evalr: evaluate(stock, data) }));
      const history = snapshotHistory(dataDate, Object.fromEntries(rows.map((r) => [r.stock.symbol, r.evalr.tier.key])));
      rows.forEach((r) => { r.prev = previousTier(history, dataDate, r.stock.symbol); });
      rows.sort((a, b) =>
        TIERS[a.evalr.tier.key].order - TIERS[b.evalr.tier.key].order ||
        b.evalr.scores.opp.value - a.evalr.scores.opp.value ||
        b.evalr.scores.eq.value - a.evalr.scores.eq.value);

      const tierKeys = ["excellent", "good", "watch", "wait", "avoid"];
      const counts = Object.fromEntries(tierKeys.map((k) => [k, rows.filter((r) => r.evalr.tier.key === k).length]));
      const defs = filterDefs();
      let active = new Set();
      try { active = new Set(JSON.parse(localStorage.getItem(RECO_FILTERS_KEY) || "[]")); } catch { /* fresh */ }
      const persist = () => localStorage.setItem(RECO_FILTERS_KEY, JSON.stringify([...active]));

      main.innerHTML = `
        <div class="page-head"><div><h2>Recommendations</h2>
          <div class="sub">Which stocks deserve attention today — rule-based scores computed from the published data.
          Every score is a fixed weighted formula whose point breakdown is shown on the card; missing data is shown as missing, never guessed.
          Personal research, not investment advice — you make every decision.</div></div>
          <div class="sub mono">data ${dataDate}</div>
        </div>
        <section class="kpi-row reco-summary" id="reco-summary" aria-label="Recommendation tier counts"></section>
        <section class="panel" aria-label="Recommendation filters and cards">
          <div class="filter-row"><span class="filter-label">Filters</span><div class="filter-chips" id="reco-chips"></div>
            <span class="stock-count" id="reco-count" style="margin-left:auto"></span></div>
          <div class="reco-grid" id="reco-grid"></div>
          <div class="show-more-row" id="reco-more"></div>
        </section>`;

      const tierIcons = { excellent: "◆", good: "●", watch: "◐", wait: "◔", avoid: "○" };
      const summaryEl = main.querySelector("#reco-summary");
      summaryEl.innerHTML = tierKeys
        .map((key) => `<button class="kpi-card reco-tile ${TIERS[key].cls} ${active.has(key) ? "active" : ""}" data-tier="${key}">
            <div class="kpi-top"><span class="kpi-label">${TIERS[key].label}</span><span class="reco-tile-glyph" aria-hidden="true">${tierIcons[key]}</span></div>
            <div class="kpi-value mono">${counts[key]}</div>
            <div class="kpi-sub">of ${rows.length} tracked</div>
          </button>`)
        .join("");

      const gridEl = main.querySelector("#reco-grid");
      const moreEl = main.querySelector("#reco-more");
      const countEl = main.querySelector("#reco-count");
      const LIMIT = 12;
      let showAll = false;

      function applyFilters() {
        const tierSel = [...active].filter((k) => defs.find((d) => d.key === k)?.group === "tier");
        const others = [...active].filter((k) => defs.find((d) => d.key === k)?.group !== "tier");
        let out = rows;
        if (tierSel.length) out = out.filter((r) => tierSel.some((k) => defs.find((d) => d.key === k).fn(r)));
        others.forEach((k) => { const d = defs.find((x) => x.key === k); if (d) out = out.filter(d.fn); });
        return out;
      }

      function renderGrid() {
        const filtered = applyFilters();
        countEl.textContent = active.size ? `${filtered.length} of ${rows.length}` : `${rows.length} tracked`;
        const visible = showAll ? filtered : filtered.slice(0, LIMIT);
        gridEl.innerHTML = visible.length
          ? visible.map((r, i) => cardHtml(r.stock, r.evalr, r.prev, dataDate, i + 1)).join("")
          : `<div class="empty-note">No stocks match the current filters — the tiers above show where everything sits today.</div>`;

        moreEl.innerHTML = "";
        if (filtered.length > LIMIT) {
          const btn = document.createElement("button");
          btn.className = "btn btn-ghost btn-sm";
          btn.textContent = showAll ? `Show top ${LIMIT} only` : `Show all ${filtered.length}`;
          btn.addEventListener("click", () => { showAll = !showAll; renderGrid(); });
          moreEl.appendChild(btn);
        }

        gridEl.querySelectorAll(".reco-expand").forEach((btn) => {
          btn.addEventListener("click", () => {
            const detail = btn.nextElementSibling;
            const open = detail.hidden;
            detail.hidden = !open;
            btn.setAttribute("aria-expanded", String(open));
            btn.closest(".reco-card").classList.toggle("open", open);
          });
        });
        gridEl.querySelectorAll("[data-jump]").forEach((btn) => {
          btn.addEventListener("click", (e) => { e.stopPropagation(); P.jumpToStock(btn.dataset.jump); });
        });
      }

      function renderChips() {
        const el = main.querySelector("#reco-chips");
        el.innerHTML = defs
          .map((d) => `<button class="filter-chip ${active.has(d.key) ? "active" : ""}" data-key="${d.key}" aria-pressed="${active.has(d.key)}">${d.label} <span class="mono">${rows.filter(d.fn).length}</span></button>`)
          .join("");
        el.querySelectorAll(".filter-chip").forEach((chip) => {
          chip.addEventListener("click", () => {
            const k = chip.dataset.key;
            active.has(k) ? active.delete(k) : active.add(k);
            persist();
            showAll = false;
            renderChips();
            syncTiles();
            renderGrid();
          });
        });
      }

      function syncTiles() {
        summaryEl.querySelectorAll(".reco-tile").forEach((tile) => tile.classList.toggle("active", active.has(tile.dataset.tier)));
      }

      summaryEl.querySelectorAll(".reco-tile").forEach((tile) => {
        tile.addEventListener("click", () => {
          const k = tile.dataset.tier;
          active.has(k) ? active.delete(k) : active.add(k);
          persist();
          showAll = false;
          renderChips();
          syncTiles();
          renderGrid();
        });
      });

      renderChips();
      renderGrid();
    },
  });

  // Exposed so the shell can show the nav badge (count of Excellent + Good entries).
  window.RecoEngine = { evaluate, TIERS };
})();
