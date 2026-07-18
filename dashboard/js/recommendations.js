// =====================================================================================
// RECOMMENDATIONS PAGE — "out of everything I track, which entries deserve attention
// today, and why?" Completely rule-based, computed client-side from the published
// per-stock JSON. HARD RULE (CLAUDE.md): no composite/weighted score, no buy/sell
// verdict, no target/stop-loss prices. The spec's "Opportunity Score / Confidence /
// Risk / Entry Quality" are therefore rendered as the established rule-compliant
// translations — counts of NAMED conditions with their reasons displayed:
//   Opportunity Score → bullish flag count (X/8)
//   Entry Quality     → count of named entry conditions (X/7, unevaluable checks
//                       shrink the denominator)
//   Risk              → count of the 6 named risk conditions from the pipeline
//   Confidence        → data-completeness count (present sources / 5)
//   Buy zone / target / stop loss → OBSERVED levels only (20-session S/R, ±2%
//                       EMA20/50 zone, ATR as typical daily swing), labelled as
//                       measurements, never advice. Range geometry (distance to
//                       resistance vs distance to support) replaces "risk:reward
//                       target" — it is measured from history, not projected.
//   "Avoid" tier      → "No setup today" (describes the setup, never commands).
// Every tier/action/wait-condition names the exact rule that produced it.
// =====================================================================================
(function () {
  const U = window.dashboardUtils;
  const P = window.Platform;
  const fp = U.formatPrice;

  // ---------------- Entry conditions (7 named checks) ----------------
  // value: true / false / null (null = not evaluable from today's data; the
  // denominator shrinks — never a guessed pass or fail).

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

  function buildEntryChecks(stock, sectorPct) {
    const ind = stock.indicators;
    const ratio = U.volumeRatio(ind);
    const geo = rangeGeometry(stock);
    const checks = [];
    const add = (key, label, value, detail) => checks.push({ key, label, value, detail });

    const trendOk = ind.ema50 != null && ind.ema200 != null && ind.close != null
      ? ind.ema50 > ind.ema200 && ind.close > ind.ema200
      : null;
    add("trend", "Strong trend", trendOk,
      trendOk === null ? "EMA data missing"
        : `EMA50 ${fp(ind.ema50)} ${ind.ema50 > ind.ema200 ? ">" : "<"} EMA200 ${fp(ind.ema200)}, close ${ind.close > ind.ema200 ? "above" : "below"} EMA200`);

    const isPullback = U.isNearBuyZone(stock);
    const isConfirmedBreakout = U.isBreakoutCandidate(stock) && ratio != null && ratio >= 1.5;
    add("proximity", "Healthy pullback / confirmed breakout", isPullback || isConfirmedBreakout,
      isPullback ? "uptrend, price within ±2% of its EMA20/50 zone"
        : isConfirmedBreakout ? `pressing upper band / 52w high with ${ratio.toFixed(1)}× volume`
        : "price is neither in the EMA20/50 pullback zone nor in a volume-confirmed breakout");

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
        geoDetail = "price is at/above its 20-session high — no measured upside left inside the range";
        geoVal = null; // not measurable, not a fail: breakout entries are judged by the proximity check
      } else if (geo.ratio != null) {
        geoVal = geo.ratio >= 1.5;
        geoDetail = `+${geo.upPct.toFixed(1)}% to resistance vs −${geo.downPct.toFixed(1)}% to support (${geo.ratio.toFixed(1)}:1 observed)`;
      } else if (geo.atBottom) {
        geoDetail = "price is at/below its 20-session low — measured downside distance is zero";
        geoVal = false;
      }
    }
    add("geometry", "Favourable range geometry (≥1.5:1)", geoVal, geoDetail);

    const evaluated = checks.filter((c) => c.value !== null);
    return {
      checks,
      passed: evaluated.filter((c) => c.value).length,
      evaluated: evaluated.length,
      geo,
    };
  }

  // ---------------- Entry tier (first-match threshold rules, like attention tiers) ----

  const TIERS = {
    excellent: { label: "Excellent entry conditions", cls: "t-excellent", order: 0 },
    good: { label: "Good entry conditions", cls: "t-good", order: 1 },
    watch: { label: "Watch — setup forming", cls: "t-watch", order: 2 },
    wait: { label: "Wait — not aligned", cls: "t-wait", order: 3 },
    none: { label: "No setup today", cls: "t-none", order: 4 },
  };

  function classifyTier(stock, entry) {
    const ind = stock.indicators;
    const F = stock.flags.flag_count;
    const R = stock.decision?.risk?.condition_count ?? null;
    const E = entry.passed;
    const enough = entry.evaluated >= 5; // too few evaluable checks → never above "watch"

    // Named disqualifiers for the top tiers (still shown transparently, never hidden):
    // a chase-risk extension or a failed range-geometry check caps the tier at Watch/Good.
    const extPct = ind.ema20 != null && ind.close != null ? ((ind.close - ind.ema20) / ind.ema20) * 100 : null;
    const extended = (ind.rsi14 != null && ind.rsi14 > 70) || (extPct != null && extPct >= 8);
    const geoFail = entry.checks.find((c) => c.key === "geometry")?.value === false;

    if (enough && E >= 6 && F >= 6 && R !== null && R <= 1 && !extended && !geoFail)
      return { key: "excellent", rule: "≥6/7 entry checks + ≥6/8 flags + ≤1 risk condition, no chase-risk extension, geometry check not failed" };
    if (enough && E >= 5 && F >= 5 && R !== null && R <= 2 && !extended)
      return { key: "good", rule: "≥5/7 entry checks + ≥5/8 flags + ≤2 risk conditions, no chase-risk extension" };
    if (F >= 5 || E >= 4)
      return {
        key: "watch",
        rule: extended && (F >= 5 || E >= 4)
          ? "chase-risk extension (RSI >70 or price ≥8% above EMA20) caps the tier at Watch"
          : enough ? "≥5/8 flags or ≥4/7 entry checks" : `only ${entry.evaluated}/7 entry checks evaluable — capped at Watch`,
      };
    if (F >= 3) return { key: "wait", rule: "3–4/8 flags — base conditions present, entry not aligned" };
    return { key: "none", rule: "≤2/8 flags" };
  }

  // ---------------- Signal timeframe (which timeframe today's conditions live on) ----
  // NOT a holding instruction — it names the scale of the observed signals. Intraday is
  // never emitted: this is a daily pipeline and the UI says so.

  function signalTimeframe(stock) {
    const pat = stock.decision?.patterns || {};
    const trend = stock.decision?.trend || {};
    const ind = stock.indicators;
    if (pat.breakout || pat.volume_surge)
      return { key: "momentum", label: "Short-term momentum", why: "breakout / volume-surge conditions resolve over days" };
    if (pat.near_buy_zone)
      return { key: "swing", label: "Swing pullback", why: "EMA20/50 pullback signals resolve over days–weeks" };
    if (trend.weekly === "bullish" && ind.ema200 != null && ind.close > ind.ema200)
      return { key: "positional", label: "Positional structure", why: "weekly trend + EMA200 alignment are week–month scale signals" };
    return { key: "mixed", label: "Mixed timeframe", why: "today's signals don't cluster on one timeframe" };
  }

  // ---------------- Action line (a statement of today's state, never an instruction) --

  function buildAction(stock, entry, tier) {
    const ind = stock.indicators;
    const ratio = U.volumeRatio(ind);
    const geo = entry.geo;
    const zone = pullbackZone(ind);
    const extPct = ind.ema20 != null && ind.close != null ? ((ind.close - ind.ema20) / ind.ema20) * 100 : null;

    if (tier.key === "excellent") return `Entry conditions are aligned at today's close — ${entry.passed}/${entry.evaluated} checks met.`;
    if ((extPct != null && extPct >= 8) || (ind.rsi14 != null && ind.rsi14 > 70)) {
      const bits = [];
      if (extPct != null && extPct >= 8) bits.push(`price ${extPct.toFixed(1)}% above EMA20`);
      if (ind.rsi14 != null && ind.rsi14 > 70) bits.push(`RSI ${ind.rsi14.toFixed(0)}`);
      return `Extended: ${bits.join(", ")} — chase-risk conditions are present.`;
    }
    if (U.isBreakoutCandidate(stock) && (ratio == null || ratio < 1.5) && geo?.sr)
      return `Breakout unconfirmed — the breakout check fires on a close above ${fp(geo.sr.resistance)} with volume ≥1.5× average (today ${ratio != null ? ratio.toFixed(1) : "—"}×).`;
    if (zone && ind.close > zone.hi && ind.ema50 != null && ind.ema200 != null && ind.ema50 > ind.ema200)
      return `Above the pullback zone — the pullback check fires between ${fp(zone.lo)} and ${fp(zone.hi)} (±2% of EMA20/50).`;
    if (geo?.sr && ind.close <= geo.sr.support * 1.02 && ind.rsi14 != null && ind.rsi14 < 45)
      return `Near 20-session support ${fp(geo.sr.support)} with RSI ${ind.rsi14.toFixed(0)} — no stabilization condition met yet.`;
    if (U.isNearBuyZone(stock) && zone)
      return `In the observed EMA20/50 pullback zone (${fp(zone.lo)}–${fp(zone.hi)}) with the uptrend intact — ${entry.passed}/${entry.evaluated} entry checks met.`;
    if (tier.key === "good" || tier.key === "watch")
      return `Setup forming — ${entry.passed}/${entry.evaluated} entry checks met; see what would change this below.`;
    return `No setup today — ${stock.flags.flag_count}/8 bullish flags.`;
  }

  // ---------------- "What would change this" (rule-compliant wait conditions) ---------
  // Each line states the exact observed number and the threshold at which the failed
  // check would fire — facts about the rules, not instructions to act.

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
          if (ind.ema200 != null) waits.push(`Trend check fires when close and EMA50 hold above EMA200 (${fp(ind.ema200)}); close is ${fp(ind.close)}.`);
          break;
        case "proximity": {
          if (zone && ind.close > zone.hi) waits.push(`Pullback check fires if price returns to ${fp(zone.lo)}–${fp(zone.hi)} (±2% of EMA20/50).`);
          if (geo?.sr && ind.close < geo.sr.resistance) waits.push(`Breakout check fires on a close above ${fp(geo.sr.resistance)} (20-session high) with volume ≥1.5× average.`);
          break;
        }
        case "macd":
          waits.push(`MACD ${ind.macd.toFixed(2)} is below its signal ${ind.macd_signal.toFixed(2)} — the check needs a cross above.`);
          break;
        case "rsi":
          waits.push(ind.rsi14 > 65
            ? `RSI ${ind.rsi14.toFixed(1)} is above the healthy band — the check fires back inside 40–65.`
            : `RSI ${ind.rsi14.toFixed(1)} is below the healthy band — the check fires back inside 40–65.`);
          break;
        case "volume":
          waits.push(`Volume is ${ratio.toFixed(1)}× the 20-day average — confirmation needs ≥1.2×.`);
          break;
        case "sector":
          waits.push(`${stock.sector || "The sector"} averages under 50% of the flags — the check fires when the sector strengthens.`);
          break;
        case "geometry":
          if (geo?.ratio != null) waits.push(`Observed range geometry is ${geo.ratio.toFixed(1)}:1 (needs ≥1.5:1) — it improves as price nears support ${fp(geo.sr.support)} or resistance rises.`);
          else if (geo?.atBottom) waits.push(`Price sits at its 20-session low — the geometry check needs the range to re-form above support.`);
          break;
      }
    });
    return waits.slice(0, 4);
  }

  // ---------------- Warnings (named risk conditions + observed context) ----------------

  function buildWarnings(stock, entry, data) {
    const ind = stock.indicators;
    const risk = stock.decision?.risk;
    const ratio = U.volumeRatio(ind);
    const geo = entry.geo;
    const warnings = [];
    if (risk) risk.conditions_on.forEach((k) => warnings.push(risk.conditions_detail?.[k] || k.replace(/_/g, " ")));
    if (geo?.sr && !geo.atTop && ind.close >= geo.sr.resistance * 0.98)
      warnings.push(`Within 2% of 20-session resistance ${fp(geo.sr.resistance)}`);
    if (ratio != null && ratio < 0.6) warnings.push(`Volume only ${ratio.toFixed(1)}× the 20-day average — thin participation`);
    if (geo?.ratio != null && geo.ratio < 1) warnings.push(`Observed downside to support (−${geo.downPct.toFixed(1)}%) exceeds upside to resistance (+${geo.upPct.toFixed(1)}%)`);
    const sectorPct = sectorPctFor(stock, data);
    if (sectorPct != null && sectorPct < 37.5) warnings.push(`Weak sector — ${stock.sector} averages ${sectorPct}% of the flags`);
    const ev = stock.events;
    if (ev && Array.isArray(ev.earnings_dates)) {
      const soon = ev.earnings_dates.map((d) => new Date(d)).find((d) => !isNaN(d) && d >= new Date() && d - new Date() < 14 * 24 * 3600 * 1000);
      if (soon) warnings.push(`Earnings within 2 weeks (${U.formatEventDate(soon.toISOString())})`);
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
    const tier = classifyTier(stock, entry);
    return {
      entry,
      tier,
      timeframe: signalTimeframe(stock),
      action: buildAction(stock, entry, tier),
      waits: buildWaits(stock, entry),
      warnings: buildWarnings(stock, entry, data),
    };
  }

  // ---------------- Rendering ----------------

  function ringBlock(fraction, label, caption, cls, title) {
    return `<div class="reco-gauge" title="${title}">
      ${P.ringHtml(fraction, label, { size: 48, stroke: 4.5, cls })}
      <span class="reco-gauge-cap">${caption}</span>
    </div>`;
  }

  function gaugesHtml(stock, evalr) {
    const f = stock.flags;
    const risk = stock.decision?.risk;
    const sources = [stock.indicators, stock.fundamentals, stock.analyst, stock.events, stock.shareholding];
    const present = sources.filter((s) => s != null).length;
    const entryCls = evalr.entry.evaluated && evalr.entry.passed / evalr.entry.evaluated >= 0.7 ? "up" : evalr.entry.passed / (evalr.entry.evaluated || 1) >= 0.4 ? "warn" : "down";
    return `<div class="reco-gauges">
      ${ringBlock(f.flag_count / f.flag_total, `${f.flag_count}/${f.flag_total}`, "Setup flags",
        U.flagCountClass(f.flag_count, f.flag_total) === "strong" ? "up" : U.flagCountClass(f.flag_count, f.flag_total) === "mid" ? "warn" : "down",
        `${f.flag_count} of ${f.flag_total} named bullish flags fired — the honest form of an 'opportunity score'`)}
      ${ringBlock(evalr.entry.evaluated ? evalr.entry.passed / evalr.entry.evaluated : 0, `${evalr.entry.passed}/${evalr.entry.evaluated}`, "Entry checks", entryCls,
        `${evalr.entry.passed} of ${evalr.entry.evaluated} evaluable entry conditions met (unevaluable checks shrink the denominator)`)}
      ${risk
        ? ringBlock(risk.condition_count / risk.condition_total, `${risk.condition_count}/${risk.condition_total}`, "Risk conds", risk.level === "low" ? "up" : risk.level === "elevated" ? "warn" : "down",
          `${risk.condition_count} of ${risk.condition_total} named risk conditions present: ${risk.conditions_on.map((k) => k.replace(/_/g, " ")).join(", ") || "none"}`)
        : `<div class="reco-gauge"><span class="empty-note sm">risk n/a</span></div>`}
      ${ringBlock(present / sources.length, `${present}/${sources.length}`, "Data", "accent",
        `${present} of ${sources.length} data sources present this run — the honest stand-in for a 'confidence %'`)}
    </div>`;
  }

  // Entry map — observed levels on one horizontal price scale. Support, resistance,
  // the ±2% EMA20/50 zone and an ATR whisker are all measurements from the stock's own
  // history; nothing here is a target, stop or instruction.
  function entryMapHtml(stock, evalr) {
    const ind = stock.indicators;
    const geo = evalr.entry.geo;
    const zone = pullbackZone(ind);
    if (!geo?.sr || ind.close == null) {
      return `<div class="empty-note sm">Entry map needs ≥10 sessions of price history — not available for this stock yet.</div>`;
    }
    const { sr } = geo;
    const atr = ind.atr14;
    const values = [sr.support, sr.resistance, ind.close];
    if (zone) values.push(zone.lo, zone.hi);
    if (atr != null) values.push(ind.close - atr, ind.close + atr);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const pad = span * 0.06;
    const x = (v) => (((v - (lo - pad)) / (span + 2 * pad)) * 100).toFixed(2);

    const zoneHtml = zone
      ? `<span class="em-zone" style="left:${x(zone.lo)}%;width:${(x(zone.hi) - x(zone.lo)).toFixed(2)}%" title="±2% of EMA20/50 — the observed pullback zone, not a buy order"></span>`
      : "";
    const atrHtml = atr != null
      ? `<span class="em-atr" style="left:${x(ind.close - atr)}%;width:${(x(ind.close + atr) - x(ind.close - atr)).toFixed(2)}%" title="±1 ATR(14) = typical daily swing ${fp(atr)}"></span>`
      : "";

    const geoLine = geo.atTop
      ? `Price is at/above its 20-session high — range geometry not measurable inside the range.`
      : geo.ratio != null
        ? `Range geometry: <b class="up">+${geo.upPct.toFixed(1)}%</b> to resistance vs <b class="down">−${geo.downPct.toFixed(1)}%</b> to support — <b>${geo.ratio.toFixed(1)}:1</b> observed, not a projected reward.`
        : `Price is at/below its 20-session low.`;

    return `<div class="entry-map">
      <div class="em-track">
        ${zoneHtml}${atrHtml}
        <span class="em-tick support" style="left:${x(sr.support)}%" title="20-session support (lowest close) ${fp(sr.support)}"></span>
        <span class="em-tick resistance" style="left:${x(sr.resistance)}%" title="20-session resistance (highest close) ${fp(sr.resistance)}"></span>
        <span class="em-price" style="left:${x(ind.close)}%" title="Last close ${fp(ind.close)}"></span>
      </div>
      <div class="em-labels mono">
        <span class="em-l down">S ${fp(sr.support)}</span>
        ${zone ? `<span class="em-l zone">zone ${fp(zone.lo)}–${fp(zone.hi)}</span>` : ""}
        <span class="em-l now">now ${fp(ind.close)}</span>
        <span class="em-l up">R ${fp(sr.resistance)}</span>
      </div>
      <div class="fine">${geoLine}</div>
      <div class="fine dim">Support/resistance = lowest/highest close of the last 20 sessions (${sr.basis}); shaded band = ±2% of EMA20/50; hatched span = ±1 ATR (${atr != null ? `${fp(atr)} ≈ ${((atr / ind.close) * 100).toFixed(1)}%/day` : "n/a"}). Observed levels — deliberately no target or stop-loss price.</div>
    </div>`;
  }

  function checklistHtml(evalr) {
    return evalr.entry.checks
      .map((c) => {
        const mark = c.value === null ? `<span class="mark na">·</span>` : `<span class="mark ${c.value ? "pass" : "fail"}">${c.value ? "✓" : "✗"}</span>`;
        return `<div class="check-row">${mark}<span class="label">${c.label} — ${c.detail}${c.value === null ? " (not evaluated)" : ""}</span></div>`;
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
    return `<span class="reco-move ${improved ? "up" : "down"}" title="Entry tier moved since ${prev.date} (stored in this browser)">${improved ? "▲" : "▼"} was: ${TIERS[prev.tier]?.label || prev.tier}</span>`;
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
          <span class="reco-tier ${tier.cls}" title="Rule: ${evalr.tier.rule} — a threshold on named conditions, not a verdict">${tier.label}</span>
          <span class="reco-tf" title="${evalr.timeframe.why}. Names the timeframe of the observed signals — not a holding instruction. Intraday is never shown: this is a daily pipeline.">${evalr.timeframe.label}</span>
          ${historyChip(prev, evalr.tier.key)}
        </div>
        ${gaugesHtml(stock, evalr)}
        <div class="reco-action">${evalr.action}</div>
        <div class="reco-badges">
          ${U.attentionStarsHtml(stock)}${U.riskChipHtml(stock, { compact: true })}${U.trendChipsHtml(stock)}${U.dataCompletenessHtml(stock)}
        </div>
        <button class="reco-expand" aria-expanded="false">Why · levels · what would change this <span class="reco-caret">▾</span></button>
        <div class="reco-detail" hidden>
          <div class="detail-section"><h6>Entry map <span class="ext-tag">observed levels · not targets or stops</span></h6>${entryMapHtml(stock, evalr)}</div>
          <div class="detail-section"><h6>Why this tier · ${evalr.entry.passed}/${evalr.entry.evaluated} entry checks</h6>${checklistHtml(evalr)}
            <div class="fine dim">Tier rule: ${evalr.tier.rule}.</div></div>
          <div class="detail-section"><h6>Warnings</h6>
            ${evalr.warnings.length ? evalr.warnings.map((w) => `<div class="exp-risk">⚠ ${w}</div>`).join("") : `<div class="fine">No named risk conditions present today — normal market risk still applies.</div>`}
            ${stock.events == null ? `<div class="fine dim">Earnings-date risk not evaluated — the events feed was not collected this run. Gap risk is not evaluated — the pipeline stores daily closes only.</div>` : `<div class="fine dim">Gap risk is not evaluated — the pipeline stores daily closes only.</div>`}
          </div>
          ${evalr.waits.length ? `<div class="detail-section"><h6>What would change this</h6>${evalr.waits.map((w) => `<div class="reco-wait">◦ ${w}</div>`).join("")}</div>` : ""}
          <div class="detail-section"><h6>Recommendation history <span class="ext-tag">this browser only</span></h6>${historyHtml(prev, evalr.tier.key, dataDate)}</div>
          <div class="reco-foot">
            <span class="fine dim">Every element above is a named rule on published data — nothing is weighted, predicted, or advised.</span>
            <button class="btn btn-ghost btn-sm" data-jump="${stock.symbol}">Full analysis →</button>
          </div>
        </div>
      </article>`;
  }

  // ---------------- Filters ----------------

  const RECO_FILTERS_KEY = "nse-reco-filters";

  function filterDefs() {
    return [
      { key: "excellent", group: "tier", label: "Excellent entry", fn: (r) => r.evalr.tier.key === "excellent" },
      { key: "good", group: "tier", label: "Good entry", fn: (r) => r.evalr.tier.key === "good" },
      { key: "watch", group: "tier", label: "Watch", fn: (r) => r.evalr.tier.key === "watch" },
      { key: "wait", group: "tier", label: "Wait", fn: (r) => r.evalr.tier.key === "wait" },
      { key: "none", group: "tier", label: "No setup", fn: (r) => r.evalr.tier.key === "none" },
      { key: "swing", group: "tf", label: "Swing", fn: (r) => r.evalr.timeframe.key === "swing" },
      { key: "momentum", group: "tf", label: "Momentum", fn: (r) => r.evalr.timeframe.key === "momentum" },
      { key: "positional", group: "tf", label: "Positional", fn: (r) => r.evalr.timeframe.key === "positional" },
      { key: "lowrisk", group: "cond", label: "≤1 risk condition", fn: (r) => (r.stock.decision?.risk?.condition_count ?? 9) <= 1 },
      { key: "fulldata", group: "cond", label: "Data ≥4/5", fn: (r) => [r.stock.indicators, r.stock.fundamentals, r.stock.analyst, r.stock.events, r.stock.shareholding].filter(Boolean).length >= 4 },
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

      // Evaluate every tracked stock once
      const rows = data.stocks.map((stock) => ({ stock, evalr: evaluate(stock, data) }));
      const history = snapshotHistory(dataDate, Object.fromEntries(rows.map((r) => [r.stock.symbol, r.evalr.tier.key])));
      rows.forEach((r) => { r.prev = previousTier(history, dataDate, r.stock.symbol); });
      rows.sort((a, b) =>
        TIERS[a.evalr.tier.key].order - TIERS[b.evalr.tier.key].order ||
        b.evalr.entry.passed - a.evalr.entry.passed ||
        b.stock.flags.flag_count - a.stock.flags.flag_count);

      const counts = Object.fromEntries(Object.keys(TIERS).map((k) => [k, rows.filter((r) => r.evalr.tier.key === k).length]));
      const defs = filterDefs();
      let active = new Set();
      try { active = new Set(JSON.parse(localStorage.getItem(RECO_FILTERS_KEY) || "[]")); } catch { /* fresh */ }
      const persist = () => localStorage.setItem(RECO_FILTERS_KEY, JSON.stringify([...active]));

      main.innerHTML = `
        <div class="page-head"><div><h2>Recommendations</h2>
          <div class="sub">Which entries deserve attention today — evaluated by <b>named, transparent rules</b> on the published data.
          Tiers are thresholds on condition counts; gauges are counts, never weighted scores; levels are measured from price history, never targets.
          The dashboard does not say buy or sell — you decide.</div></div>
          <div class="sub mono">data ${dataDate}</div>
        </div>
        <section class="kpi-row reco-summary" id="reco-summary" aria-label="Entry tier counts"></section>
        <section class="panel" aria-label="Recommendation filters and cards">
          <div class="filter-row"><span class="filter-label">Filters</span><div class="filter-chips" id="reco-chips"></div>
            <span class="stock-count" id="reco-count" style="margin-left:auto"></span></div>
          <div class="reco-grid" id="reco-grid"></div>
          <div class="show-more-row" id="reco-more"></div>
        </section>`;

      // Summary tiles (click = toggle that tier's filter — same counts as the chips)
      const tierIcons = { excellent: "◆", good: "●", watch: "◐", wait: "◔", none: "○" };
      const summaryEl = main.querySelector("#reco-summary");
      summaryEl.innerHTML = Object.entries(TIERS)
        .map(([key, t]) => `<button class="kpi-card reco-tile ${t.cls} ${active.has(key) ? "active" : ""}" data-tier="${key}">
            <div class="kpi-top"><span class="kpi-label">${t.label}</span><span class="reco-tile-glyph" aria-hidden="true">${tierIcons[key]}</span></div>
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
        const tierKeys = [...active].filter((k) => defs.find((d) => d.key === k)?.group === "tier");
        const others = [...active].filter((k) => defs.find((d) => d.key === k)?.group !== "tier");
        let out = rows;
        if (tierKeys.length) out = out.filter((r) => tierKeys.some((k) => defs.find((d) => d.key === k).fn(r)));
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

  // Exposed so the shell can show an honest nav badge (count of excellent+good tiers).
  window.RecoEngine = { evaluate, TIERS };
})();
