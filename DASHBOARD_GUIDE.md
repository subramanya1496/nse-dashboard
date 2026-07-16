# Stock Intelligence Dashboard — Complete End-to-End Guide

**For someone new to the dashboard: how data flows, how it's calculated, and what you're seeing.**

---

## Part 1: The Big Picture

```
EVERY DAY
    ↓
[Pipeline Runs] (3 min after market close, ~16:00 IST)
    ↓
[Fetches Price Data] (Angel One API)
    ↓
[Calculates Technical Indicators] (EMA, RSI, Bollinger Bands, etc.)
    ↓
[Evaluates 8 Bullish Flags] (how many conditions are met?)
    ↓
[Ranks Stocks by Flag Count] (6/8 = better than 5/8, etc.)
    ↓
[Publishes to GitHub Pages] (you see it on the live dashboard)
    ↓
[Sends Evening Telegram Brief] (tells you the day's movers + your portfolio)
```

**Key insight:** The dashboard is NOT live. Prices only move when the pipeline runs (~once per day). If you refresh at 3 PM, you see yesterday's close. At 4:15 PM, you see today's close.

---

## Part 2: Where the Data Comes From

### Daily Data (Pipeline, ~15:45 IST)

| What | Source | Refreshed | Used For |
|---|---|---|---|
| **Prices (OHLCV)** | Angel One SmartAPI | Daily 15:45 IST | Indicators, P&L, flags |
| **Technical indicators** | Calculated locally | Daily 15:45 IST | EMA, RSI, MACD, ATR, Bollinger Bands |
| **Fundamentals** (PE, ROE, debt/equity) | yfinance | Daily 15:45 IST | Stock detail panel, filters |
| **Corporate events** (earnings, dividends) | yfinance | Daily 15:45 IST | "Upcoming events" rail |
| **Shareholding** (promoter/FII/DII %) | NSE via nsepython | Daily 15:45 IST | "Institutional activity" rail (often blocked) |
| **News headlines** | Google News RSS | Daily 15:45 IST | "Latest news" rail with sentiment |

### Real-Time Data (Morning Brief, ~09:00 IST)

| What | Source | Refreshed | Used For |
|---|---|---|---|
| **Global indices** (S&P 500, Nasdaq, Dow, Nikkei, Hang Seng, FTSE, commodities, FX) | yfinance | Morning 09:00 IST | Morning Telegram brief (overnight tone) |
| **India indices** (NIFTY 50, SENSEX, BANK NIFTY, VIX) | yfinance | Both morning & evening | Market strip at the top of the dashboard |

---

## Part 3: How the Pipeline Works (Step-by-Step)

### Step 1: Load Your Watchlist & Portfolio

```
config/watchlist.json        (172 stocks you're tracking)
config/portfolio.json        (your 11 holdings: BAJAJHFL, BEL, JIOFIN, ...)
```

The pipeline processes every stock in both.

### Step 2: Fetch Historical Price Data

For each stock, Angel One provides the last **450 days** of daily candles (Open, High, Low, Close, Volume).

```
RELIANCE: Jan 2024 → Jul 2026 (450 days of OHLCV)
TCS:      Jan 2024 → Jul 2026
... (for all 172 stocks)
```

**If this fails:** The stock is skipped that day (logged, but visible to you: "no data this cycle").

### Step 3: Calculate Technical Indicators

From the 450 candles, compute:

| Indicator | What It Means | Used By |
|---|---|---|
| **EMA 20** | 20-day exponential moving average | Trend + near-buy-zone flag |
| **EMA 50** | 50-day exponential moving average | Trend + near-buy-zone flag |
| **EMA 200** | 200-day exponential moving average | Long-term trend + near-buy-zone flag |
| **RSI 14** | Overbought/oversold (-100 to +100) | Shown in watchlist, used for context |
| **MACD** | Momentum (difference of two exponentials) | Shown in watchlist, used for context |
| **ATR 14** | Average True Range (typical daily swing) | Shown in "Keep an eye on", used for volatility |
| **Bollinger Bands** | Upper/lower bands (±2 std dev from EMA20) | Breakout flag, shown in watchlist |
| **VWAP** | Volume-weighted average price | Shown in watchlist, context |
| **ADX 14** | Trend strength (0-100, higher = stronger) | Trending flag |
| **20-session support/resistance** | Lowest/highest close in last 20 days | Shown in watchlist + "Keep an eye on" |
| **52-week high/low** | Highest/lowest price in last year | Shown in watchlist + "Keep an eye on", breakout flag |

All of these are computed from the price history — no external API needed.

### Step 4: Evaluate the 8 Bullish Flags

The dashboard asks: "Does this stock show bullish conditions?" There are 8 binary YES/NO flags:

| Flag | Condition | What It Checks |
|---|---|---|
| **1. Price above EMA 20** | Current price > 20-day average | Stock is above short-term trend |
| **2. EMA 20 above EMA 50** | 20-day avg > 50-day avg | Short-term stronger than medium-term |
| **3. EMA 50 above EMA 200** | 50-day avg > 200-day avg | Medium-term stronger than long-term |
| **4. RSI not extreme** | RSI between 30–70 | Not overbought, not oversold |
| **5. MACD positive** | MACD > signal line | Momentum is positive |
| **6. Price above Bollinger lower band** | Price > lower BB | Not at the bottom band |
| **7. ADX > 20** | Trend strength > 20 | Trend is real, not noise |
| **8. Volume above 20-day average** | Today's vol > 20-day avg | Volume backing the move |

**Result:** A flag_count (e.g., 6/8 = 6 flags are YES, 2 are NO).

**The golden rule:** Stock with 8/8 flags is in a strong uptrend. Stock with 0/8 flags is not showing bullish conditions. Everything in between = mixed signals.

### Step 5: Fetch Fundamentals & External Data

In parallel:
- **PE, EPS, ROE, debt/equity, margins** from yfinance
- **Analyst consensus** (Buy/Hold/Sell from yfinance)
- **Upcoming earnings/dividend dates**
- **Shareholding changes** (promoter/FII/DII %)
- **News headlines** (Google News RSS, India edition)

If any of these fail, it's **logged but doesn't break the stock** — you see "not available this run" in the UI.

### Step 6: Write Output Files

The pipeline writes one JSON file per stock:

```
data/output/stocks/RELIANCE.json     (all indicators + flags)
data/output/stocks/TCS.json
... (172 files)

data/output/meta.json                (summary: how many OK, how many skipped)
data/output/portfolio.json           (your holdings with P&L)
data/output/sectors.json             (sector strength)
data/output/market.json              (India + global indices)
data/output/news.json                (headlines with sentiment)
```

### Step 7: Dashboard Reads These Files

When you load `index.html`:
1. Browser fetches all 172 stock files
2. JavaScript calculates rankings (sorts by flag_count descending)
3. Renders the page with live data

---

## Part 4: How the Dashboard Displays Everything

### Market Strip (Top)

```
NIFTY 50 24,211 ▲ 0.02%     SENSEX 77,616 ▲ 0.06%     Data: 3h ago
```

**What it shows:** India's major indices + data age.

**Data age color code:**
- Green: < 1 day (fresh)
- Amber: 1–3 days (market was closed)
- Red: > 3 days (something's wrong, pipeline may have failed)

---

### KPI Cards (Key Numbers Today)

```
┌─────────────────────────────────────────────────────────────────┐
│  ALL 8/8 FLAGS    │  BREAKOUT CANDIDATES    │  SILENT ACCUM  │
│      19           │         11              │       3        │
│  (19 stocks)      │  (11 stocks)            │  (3 stocks)    │
└─────────────────────────────────────────────────────────────────┘
```

**What it shows:** Simplified counts. Click any card to see the actual stocks.

**Calculation:**
```
ALL 8/8 FLAGS = count stocks where flag_count === 8
BREAKOUT = count stocks where (close > upper_bollinger_band OR close >= 99.5% of 52w_high)
SILENT ACCUM = count stocks where (volume >= 1.4× 20d_avg AND price_change <= 0.8%)
```

---

### Sector Strength Heatmap

```
┌──────────────┬──────────────┬──────────────┐
│   REALTY     │  JEWELLERY   │ ELECTRONICS  │
│   92.9%      │   87.5%      │   82.5%      │
│  7 stocks    │  3 stocks    │  5 stocks    │
└──────────────┴──────────────┴──────────────┘
```

**What it shows:** For each sector, the **average flag %** (sum of all flag_counts ÷ sum of flag_totals).

**Calculation:**
```
REALTY sector has 7 stocks
  PHOENIX: 7/8 flags
  LODHA: 8/8 flags
  DLF: 8/8 flags
  ... (4 more)
Average = (7+8+8+...)/8 = 92.9%
```

**Color code:**
- 🟢 Teal: ≥62.5% (strong sector)
- 🟡 Amber: 37.5–62.5% (neutral)
- 🔴 Rose: <37.5% (weak sector)

Click a sector to filter the watchlist.

---

### Today's Opportunities (Top 5)

```
1. AUBANK (Banking) — 8/8 ⬆ 1.04%
   Why: All 8 bullish conditions met.
   Risks: Volume below 20d avg. Watch the level ₹1,020 (support).

2. BAJFINANCE (NBFC) — 8/8 ⬆ 2.31%
   Why: Price breaking above EMA20, volume strong.
   Risks: RSI at 68 (nearing overbought). Resistance ₹7,100.
```

**What it shows:** Top 5 stocks by flag_count, with:
- Rule-based explanation (which specific flags fired)
- Specific risks to watch (contradicting flags, resistance levels)

---

### Keep an Eye On (NEW)

```
┌─────────────────────────────────────────────────────────────┐
│ AUBANK       Banking       8/8       ₹1,061 ▼ 1.04%       │
│                                                              │
│ ▸ Uptrend (EMA50 > EMA200), pulled back to its EMA20/50    │
│                                                              │
│  SUPPORT        NOW          RESISTANCE      52W HIGH       │
│  ₹1,020.85      ₹1,061       ₹1,072.1        ₹1,090.4       │
│  -3.8%                       +1.0%           +2.8%          │
│                                                              │
│ Support/resistance = lowest/highest close of last 20        │
│ sessions. Typical daily swing (ATR) ₹27.11 ≈ 2.6%.         │
│ These are observed price levels, NOT targets or advice.     │
└─────────────────────────────────────────────────────────────┘
```

**What it shows:** Stocks meeting ≥5/8 flags AND a named pattern (near buy zone / breakout / silent accumulation).

**Calculation:**
```
SUPPORT = lowest close in last 20 sessions = ₹1,020.85
RESISTANCE = highest close in last 20 sessions = ₹1,072.1
NOW = today's closing price = ₹1,061

Distance to support = (1061 - 1020.85) / 1061 = 3.8% upside needed to fall
Distance to resistance = (1072.1 - 1061) / 1061 = 1.0% downside before hitting resistance
```

**Key rule:** This is NOT a buy signal. It's showing you where price has turned before, based on its own history. You decide what to do with that information.

---

### Screens (Transparent Conditions)

```
┌────────────────────────────────────────────────────────────────┐
│ TRENDING (ADX > 20)                                    25 stocks │
│ SILENT ACCUMULATION (vol≥1.4x, chg≤0.8%)              3 stocks  │
│ NEAR BUY ZONE (EMA50>EMA200, price within ±2% of EMA20/50) ... │
│ BREAKOUT (close > upper BB OR ≥99.5% of 52w high)     11 stocks │
│ HIGH VOLUME MOVERS (vol ≥1.5x 20d avg)                 18 stocks │
│ RECENTLY WEAKENING (RSI < 40, ADX < 30)               19 stocks │
└────────────────────────────────────────────────────────────────┘
```

**What it shows:** Six simple YES/NO conditions. Click a row to filter the watchlist.

**Calculation example (BREAKOUT):**
```
For each stock, check:
  IF close > upper_bollinger_band  OR  close >= 99.5% of 52w_high
    → Include in BREAKOUT screen
```

---

### Watchlist (Dense Cards)

```
┌────────────────────────────────────────────────────────────────────┐
│ TCS              IT            7/8       ₹2,181.50 ▲ 5.44%        │
│                                                                     │
│ 52w: ₹1,850 — ₹2,350 │ EMA20: ₹2,140 EMA50: ₹2,100 EMA200: ₹2,050 │
│ RSI: 68 (⚠ high) │ MACD: bullish │ ATR: ₹42.31 │ Vol: 1.2×avg    │
│ Support: ₹2,100 │ Resistance: ₹2,200                               │
│                                                                     │
│ [price_above_ema20] [ema20_above_ema50] [volume_above_avg]        │
└────────────────────────────────────────────────────────────────────┘
```

**What it shows:** Everything you need at a glance:
- **Price & % change**
- **52-week range** (visual bar)
- **EMA status badges** (green = bullish, red = bearish)
- **RSI, MACD, ATR, volume ratio** (context)
- **Support & resistance** (20-session levels)
- **Fired flags** (colored badges)

**Click a card to expand** → full technical breakdown + fundamentals + news + analyst view + shareholding.

---

### Portfolio Page

Shows your 11 holdings with:

| Metric | Calculation | Example |
|---|---|---|
| **Invested** | sum(qty × buy_price) | 11 holdings × ₹12,500 invested |
| **Current Value** | sum(qty × current_price) | Current prices → ₹12,969 |
| **Unrealized P&L** | current_value - invested | ₹12,969 - ₹12,500 = +₹469 |
| **P&L %** | P&L / invested × 100 | ₹469 / ₹12,500 × 100 = +3.75% |
| **Day Change** | Σ(current_price - prev_close) × qty | This session's move |
| **Allocation %** | (qty × price) / current_value | BAJAJHFL = 8.2% of portfolio |
| **Best/Worst** | Stock with highest/lowest P&L % | Best: BAJAJHFL +5%, Worst: YESBANK -1% |

**Unpriced holdings** (those the pipeline couldn't fetch) show explicitly: "Not priced this run" and are excluded from totals.

---

## Part 5: How Ranking Works (The Golden Rule)

**The dashboard NEVER emits a score (like "70/100: Good to buy").**

Instead, everything is ranked by **flag count** (0/8 to 8/8) and **explained by which specific flags fired.**

```
Example ranking (by flag_count descending):

Rank 1: AUBANK — 8/8 flags ✓✓✓✓✓✓✓✓ (perfect uptrend)
Rank 2: BAJFINANCE — 8/8 flags ✓✓✓✓✓✓✓✓
Rank 3: DIVISLAB — 7/8 flags ✓✓✓✓✓✓✓ (one flag off)
...
Rank 170: SCTL — 1/8 flags ✓ (very weak)
Rank 171: RCOM — 0/8 flags (no bullish signals)
```

**Why?** Because the number of conditions met is transparent. You can see exactly why a stock is ranked where it is, and you can disagree with the weights if you want.

### The Decision-Support Layer (added 2026-07-16)

On top of the flags, the dashboard now answers "what deserves my attention first?" —
still with counts of named conditions, never a weighted score:

| Construct | How it works | Where |
|---|---|---|
| **Attention tier ★–★★★★★** | Threshold rules on flag count + named patterns (e.g. ★★★★★ = ≥7 flags AND breakout/volume surge). Tier 1 is "Quiet today" — a priority label, never "ignore" advice | Stars on every card; reasons in the panel |
| **Risk conditions** | 6 named booleans (high ATR%, RSI extreme, below EMA200, stretched above EMA20, big day move, near 52w low). Level = the count: 0–1 low, 2–3 elevated, ≥4 high | Chip on cards; full list with numbers in the panel |
| **Weekly / Daily trend** | Weekly: close vs a rising/falling 10-week EMA. Daily: EMA alignment. Intraday: honestly "not collected" | W/D chips on cards |
| **Checklist X/7** | Trend, momentum, MACD, volume, sector strength, near-52w-high, low risk — anything unevaluable says so and shrinks the denominator | Detail panel |
| **What changed today** | The pipeline diffs each run against the previously published one: flags gained/lost by name, RSI/MACD/EMA200 crossings, new 52w extremes, volume surges, support/resistance shifts | Its own section near the top |
| **Data completeness** | "Data 4/5" = how many sources (indicators, fundamentals, analyst, events, shareholding) are present for this stock | Chip in the panel |
| **Personal journal** | Reason / entry plan / exit plan / observations per stock — saved in your browser's localStorage only (there is no server) | Bottom of the detail panel |

Extra UX: sections collapse (and remember it), filters persist between visits,
press `/` anywhere to search, `Esc` to clear.

---

## Part 6: Telegram Briefings

### Morning Brief (~09:00 IST)

```
🌅 Good morning — Market brief
13 Jul 2026, 09:00 AM IST

🌍 Global (overnight / Asia):
• S&P 500: 7,526.01 ▼ 0.65%
• Nasdaq: 25,939.64 ▼ 1.30%
• Nikkei 225: 68,557.73 ▲ 1.20%
...

🇮🇳 India (previous close):
• NIFTY 50: 24,211.00 ▲ 0.02%
• SENSEX: 77,616.40 ▲ 0.06%
...

👀 Watchlist leaders (by flags, 2026-07-13 close):
1. AUBANK (Banking) — 8/8 · price_above_ema20, ema20_above_ema50
2. BAJFINANCE (NBFC) — 8/8 · price_above_ema20, ema20_above_ema50
...

Ranked by flag count, not a score — you make every decision.
```

**Purpose:** Tell you the overnight tone (are global markets helping or hurting India?) and what your watchlist's leaders are today.

**Sent:** 09:00 IST every weekday (before market opens).

### Evening Brief (~16:00 IST)

```
📊 Evening wrap — market close
13 Jul 2026, 16:00 PM IST · data as of 2026-07-13

172/177 symbols updated.
⚠️ 5 skipped (see dashboard for reasons).

🇮🇳 Indices:
• NIFTY 50: 24,211 ▲ 0.02%
...

🔼 Top gainers (watchlist):
1. TCS ▲ 5.44% · ₹2,181.50
2. HCLTECH ▲ 4.91% · ₹1,221.20
...

🔽 Top losers (watchlist):
1. ASTRAMICRO ▼ 4.66% · ₹1,719.70
...

🏆 Strongest sectors: Realty 92.9%, Jewellery 87.5%

💼 Your portfolio:
• BAJAJHFL: ▲ 5.00% (₹625)
• BEL: ▼ 1.20% (-₹150)
...
Total unrealized: +₹469 (+3.75%)

Not a recommendation service — you make every decision.
```

**Purpose:** Tell you the day's winners/losers and how your portfolio moved.

**Sent:** ~16:00 IST every weekday (after market close, once pipeline finishes).

---

## Part 7: How the Pipeline Stays Fast and Reliable (Overhauled 2026-07-15)

The pipeline used to take 70–90 minutes. Profiling showed almost all of it was retry
backoff against sources that block GitHub's runner IPs. The current architecture:

### Parallel workers
Symbols are processed 4 at a time (configurable via `PIPELINE_WORKERS`). Each external
API keeps its own rate-limit throttle shared across workers, so concurrency overlaps
*different* APIs instead of hammering any single one harder.

### Circuit breakers
When a source fails 3 symbols in a row (NSE shareholding blocking, Yahoo rate-limiting
CI), the pipeline stops calling it for the rest of the run instead of paying ~22s of
retry backoff per symbol to be told "no" 180 times. Every skip is still logged. The
breaker resets fresh each run.

### Cache tiers (matched to how fast data actually changes)
| Data | Cache | Why |
|---|---|---|
| OHLCV candles | Per-symbol, rolling | Enables incremental fetch (below) |
| Fundamentals | 7 days | PE/ROE move on quarterly results |
| Shareholding | 30 days | Patterns are filed quarterly |
| Instrument tokens | 24 hours | Rarely change |

### Incremental price fetch
A daily run fetches only the last ~5 days of candles per symbol and merges them into
the cached 450-day history — not a full re-download of everything every day.

### Validation before publish
After the pipeline, `validate_output.py` checks the output (≥60% of symbols priced,
sane values, portfolio complete, fresh timestamps). If it fails, nothing is published —
yesterday's good dashboard stays live and no misleading Telegram brief goes out.

### Run report
Every run writes `data/output/run_report.json`: per-stage timings, API call counts,
cache hits/misses, retries, and every failed symbol with its reason.

### One honest limitation
Yahoo blocks GitHub's runner IPs for the quote endpoint entirely, so **fundamentals
cannot be fetched from CI at all** — the breaker makes that cheap (seconds, not an
hour), but PE/ROE/analyst data only appears when the cache has been populated by a
run from a non-blocked network (e.g. a local run). News (Google RSS) and index levels
(a different Yahoo endpoint) work fine from CI.

---

## Part 8: FAQ

### Q: If I refresh the dashboard at 3 PM, what am I seeing?

**A:** Yesterday's closing prices (from the previous day's ~16:00 pipeline run). The "data: 1d ago" label at the top tells you this. Refresh at 4:15 PM to see today's close.

### Q: Why are some of my holdings showing "Not priced this run"?

**A:** The pipeline couldn't fetch that stock (either no NSE symbol token, or Angel One timed out 3 times, or yfinance had no fundamentals). It's not dropped from your portfolio — just marked as unpriceable and excluded from the totals. Click "Reload" to try again.

### Q: If all 8 flags are green, should I buy?

**A:** No. The dashboard is showing you the conditions, not a verdict. A stock with 8/8 flags is in a strong uptrend (by definition), but strong uptrends can reverse. Use the "Keep an eye on" section to see support/resistance levels, then decide based on your own risk tolerance.

### Q: Why is my portfolio showing +3.75% but I only bought yesterday?

**A:** CAGR (annualized return) only shows if you've held for ≥3 months. For shorter holds, it would be meaningless (yesterday's 1% gain ≠ 365% annualized). The "P&L %" shown is just the simple return: (current – cost) / cost × 100.

### Q: Why do Telegram briefs sometimes arrive late?

**A:** Two causes:

1. **Pipeline was slow** (fixed 2026-07-14 — now 3–5 min instead of 70 min)
2. **GitHub queued the workflow late** (not fixable — GitHub's free runners are best-effort; a cron that says "run at 15:45 IST" might run at 17:15 IST if the platform is busy)

Every message stamps the IST send time and data date, so drift is visible, never hidden.

### Q: What does "silent accumulation" mean?

**A:** High volume but flat price. The flag checks: `volume >= 1.4× 20-day average` AND `price change <= ±0.8%`. This pattern (high activity, flat price) often precedes a breakout. But it's not a signal to buy — just something worth noting.

### Q: Can I customize the watchlist?

**A:** Yes — edit `config/watchlist.json` and add a stock. On the next pipeline run (~16:00 IST the next day), it'll fetch 450 days of history and include it in all calculations. No waiting, no manual setup.

### Q: Are the analyst consensus ("Buy · 21 analysts") and news sentiment part of the 8 flags?

**A:** No. The 8 flags are technical + volume (100% computed locally). External analyst views and sentiment are shown for context, but the ranking never depends on them. The dashboard's verdict is always: "Here's what the price action says (8 flags) and here's what others think (analysts/news)."

---

## Summary

The dashboard answers one question daily: **"Out of everything I track, what deserves my attention today, and why?"**

It does this by:

1. **Fetching** 450 days of price history for every stock
2. **Computing** 8 technical + volume indicators
3. **Counting** how many bullish conditions are met (0–8)
4. **Ranking** stocks by that count (8/8 at top)
5. **Showing** you specific reasons why (which flags, support/resistance levels, sector trends)
6. **Never** emitting a verdict (no "buy" or "sell" — you decide)

That's it. Everything else is context (news, analyst views, fundamentals, events, shareholding changes) to help you think clearly.

---

**Last updated:** 2026-07-14 (added "Keep an eye on" section, circuit breaker + retry fixes)
