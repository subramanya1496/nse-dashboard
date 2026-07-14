# NSE Stock Intelligence Dashboard — Project Brief

## What this is
A personal-use stock analysis dashboard for the Indian NSE market, built for one user
(Subramanya). It answers one question daily: "Out of everything I track, what deserves
my attention today, and why?" It is a research/explanation tool, not a trading signal
generator, and not a recommendation service.

**This is NOT the options trading bot.** That's a separate, already-running system
(bot_v26.py, intraday options signals via Angel One + Telegram/Discord). Do not merge
code, credentials, repos, or Telegram bots between the two projects. They may share
some API credentials (Angel One account) but are otherwise independent.

## Scope & constraints
- Personal use only. No friends, no distribution, no public sharing of output.
  This keeps it outside SEBI research-analyst territory — do not add multi-user
  features, sharing, or "give advice to others" functionality without this being
  explicitly re-discussed.
- Sequencing: this project's build only starts once bot_v26's paper-trading
  validation window is complete. If that's still open when a build session starts,
  say so and confirm before proceeding — don't assume it's done.

## Build order (do not skip ahead)
1. **Phase 1 — Foundation** (build and validate fully before Phase 2):
   watchlist config, daily data collection, technical indicators (EMA 20/50/200,
   RSI, MACD, ATR, VWAP, ADX, Bollinger), portfolio page.
2. **Phase 2 — Ranking & Alerts**: sector strength, flag-based ranking, Telegram briefings.
3. **Phase 3 — AI Explanation Layer**: Claude Haiku explains flags in plain language,
   lightweight news summaries.
4. **Phase 4 — Optional, later**: backtesting flag combinations, historical flag charts,
   custom flag weighting. Do not build this until explicitly asked.

## Ranking philosophy — the one hard rule
**Never build a composite/weighted score (no 0–100 number, no single "verdict").**
Rank and explain everything by **flag count** (e.g. "6/8 bullish conditions met") and
name which specific flags fired. This was a deliberate correction from an earlier
ChatGPT-authored plan that used weighted composite scores — do not reintroduce that
pattern even if it seems like a simplification. If asked to add scoring later, flag
the tension with this rule before proceeding.

**Exception, by explicit decision (2026-07-09):** the stock detail panel shows an
*external* analyst-consensus block (yfinance `recommendationKey`/target prices, e.g.
"Buy · 21 analysts"). This is **not** a rule violation: it is third-party opinion
displayed as-is and clearly labelled "external · not this dashboard's" — the dashboard
never derives its own buy/hold/sell verdict from the flags or anything else. Keep that
labelling; do not let this grow into a dashboard-generated verdict.

## Dashboard layout (redesigned 2026-07-13 — Bloomberg-dense, still light glassmorphism)
The home page (`dashboard/index.html` + `dashboard/js/home.js`) is a single dense
multi-section research view. `dashboard/js/app.js` remains the shared utility layer
(also used by `portfolio.html`); page assets are cache-busted with `?v=3`.
Sections, top to bottom:
0. **Sticky header** — nav + an always-visible **global search** (`#global-search`) that
   filters the watchlist from anywhere on the page (Enter scrolls to it). It stays in sync
   with the in-panel `#stock-search`; both drive one query. The panel search alone was
   effectively invisible — it sits far below the fold.
1. **Sticky market strip** — NIFTY 50, SENSEX, BANK NIFTY, India VIX with sparklines
   (from `data/output/market.json`), watchlist advance/decline, market open/closed
   status (IST clock; NSE holidays are not checked and the tooltip says so), and the
   data age ("2h ago", amber ⚠ past ~3 days). The dashboard is not a live ticker — prices
   only move when the pipeline runs — so the age is always shown, never implied.
2. **KPI cards** — 8/8-flag count, breakout candidates, silent-accumulation count,
   strongest sector, portfolio unrealized P&L. Each card is a **button**: clicking it
   opens a shared detail drawer listing the underlying stocks (or holdings for P&L),
   and each row jumps to that stock in the watchlist. No new number is invented — the
   drawer just enumerates what the count already represents.
3. **Sector strength heatmap** — colored cards (replaced the progress bars); click a
   sector to filter the watchlist. Color = avg flag % (teal ≥62.5, amber mid, rose weak).
4. **Today's opportunities** — top 5 by flag count with expandable explanation +
   "risks to watch".
5. **Market breadth** — above-EMA200 %, new 52-week highs/lows, breakout count,
   A/D ratio; all computed client-side from the published per-stock JSON.
5b. **Keep an eye on** (added 2026-07-14) — up to 6 stocks meeting ≥5/8 flags **and** a
   named pattern (near buy zone / breakout / silent accumulation). Each card names the
   conditions that fired and shows **observed levels**: 20-session support & resistance,
   current price, 52-week high, and ATR as a typical daily swing.
   **Rule boundary — read before changing this.** It was asked for as "stocks good to buy
   and when to sell". It is deliberately *not* that: it shows the same transparent booleans
   the screens use, plus levels measured from the stock's own price history, and says in
   the UI that these are observed levels, not targets or advice. It must never emit an
   entry/exit price, a target, a rating, or a verdict — that would be the composite-score
   rule in a new costume. If asked to make it more prescriptive, flag this tension first.
6. **Screens** — six transparent boolean conditions (Trending · Silent accumulation
   [vol ≥1.4× 20d avg + |chg| ≤0.8%] · Near buy zone [EMA50>EMA200 + price within ±2%
   of EMA20/50] · Breakout [close > upper BB or ≥99.5% of 52w high] · High volume
   movers [≥1.5× avg] · Recently weakening). Conditions, not scores — keep them that way.
7. **Watchlist** — dense cards: price, change, 52w mini-range, EMA20/50/200 status
   badges, RSI, MACD, ATR, volume vs 20d avg, 20-session support/resistance, sector
   badge, fired-flag chips; expandable detail panel. Tabs (top flags / trending /
   by sector / favorites) + filter chips (only buy zone, ROE ≥15%, debt/equity <1×,
   strong sectors, dividend ≥1%, breakouts). Filters that need a missing fundamentals
   field exclude those stocks and display how many were excluded.
8. **Right rail** — institutional activity (promoter/FII/DII; explicit note while the
   NSE source keeps blocking), upcoming events, news with sentiment badges, portfolio
   analytics (allocation, sector mix, unrealized P&L, CAGR shown only after ≥3 months
   held, estimated dividend income from yields), run status, manage buttons.

**Portfolio page** (`portfolio.html` + `dashboard/js/portfolio.js`, redesigned 2026-07-14)
mirrors the same language: summary KPIs (invested, current value, unrealized P&L, day
change, best/worst), dense holding cards (qty/avg/LTP/day/invested/value/weight + flags,
expandable into the shared detail panel), and an allocation + sector-mix rail. Holdings the
pipeline could not price are shown as an explicit dashed card and **excluded from every
total** (never zero-filled), with a callout naming them and why.

**Empty-state rule (UI mirror of the logging discipline):** any section whose data
isn't collected yet renders an explicit note saying why and when it fills in — never
a placeholder number, never silently hidden.

**The explanation panel is rule-based, NOT the Phase 3 AI layer:** the "Why this
stock is here / risks to watch" prose is deterministic, generated in
`app.js buildExplanation()` from the already-computed flags/indicators, and labelled
"rule-based". When Phase 3 lands, the pipeline will add a `stock.ai_explanation`
field which renders instead (labelled as Claude). Do not treat the current panel as
Phase 3 being done, and never let either version emit a verdict or score.

**News sentiment is keyword-based, NOT AI:** `src/fetch_market.py` tags headlines
positive/negative/neutral with a transparent regex wordlist and stamps
`sentiment_source: "keyword"` in `news.json`; the UI labels it "keyword sentiment ·
not AI". Unmatched headlines stay neutral — never guessed.

## Data sources (all free — do not introduce paid data sources without asking)
| Data | Source | Notes |
|---|---|---|
| Price/volume/OHLCV | Angel One SmartAPI | Reuse bot's existing account/auth. Use `getMarketData` bulk endpoint for equities; avoid `ltpData()` patterns known to be unreliable for options (not relevant here, but keep the lesson in mind). **Throttle + retry (added 2026-07-14):** the client uses a 7s read timeout and a single `ReadTimeout` used to drop a symbol for the whole day — one run lost 137/184 symbols that way, emptying the dashboard and portfolio. `fetch_ohlcv` now keeps ≥0.4s between calls (Angel allows ~3/sec) and retries 3× with backoff before skipping. Exhausted retries still skip + log — never a fabricated candle. |
| Technical indicators | Computed locally from OHLCV | No external service. |
| Fundamentals (PE, EPS, ROE, margins, market cap, statements) | `yfinance` (ticker format: `SYMBOL.NS`) | No API key needed. |
| ROCE, multi-year growth | Computed from `yfinance` raw financial statements | Not pulled pre-built — this is intentional (builds real judgment instead of trusting an opaque number). |
| Promoter/FII/DII shareholding, corporate filings, quarterly results | `nsepython` / `nselib` / `jugaad_data` | Public NSE data, no key needed. Source has been blocking automated requests — every skip is logged and the UI says so explicitly. **Circuit breaker (added 2026-07-14):** each blocked call hangs ~22s before failing, which across ~180 symbols burned ~65 min — essentially the entire pipeline runtime — and pushed the evening brief hours late. After 3 consecutive failures `fetch_shareholding` stops trying for the rest of the run (`reset_circuit()` per run gives it a fresh chance). Every skip is still logged individually. |
| Index levels — India (NIFTY 50 `^NSEI`, SENSEX `^BSESN`, BANK NIFTY `^NSEBANK`, India VIX `^INDIAVIX`) + global (S&P 500, Nasdaq, Dow, Nikkei, Hang Seng, FTSE, USD/INR, Brent, Gold) | `yfinance` via `src/fetch_market.py` | Written to `data/output/market.json` (`indices` = India, `global_indices` = global). The morning brief refreshes indices live via `python -m src.fetch_market --indices-only` (no Angel/secrets needed). |
| Debt/equity, dividend yield, price/book, event dates (earnings, ex-div, dividend pay) | `yfinance` `info` + `calendar` in `src/fetch_fundamentals.py` | Added 2026-07-13 (fundamentals cache version 2 — old caches refetch once). Bonus/split announcements are NOT in this feed; planned via the NSE corporate-actions source. |
| News headlines | **Google News RSS** (India edition) via `src/fetch_market.py` | Only for holdings + top-10 flag-count names (keeps request volume small). Written to `data/output/news.json` with keyword-based sentiment, labelled as such. **Do not go back to `yfinance` `.news`** — Yahoo blocks GitHub's runner IPs, so it silently returned an empty list for every symbol in CI (2026-07-14 published 0 items). The RSS feed answers from CI and is searched by *company name* (a bare ticker like "BEL" pulls in noise), so `write_news_output` takes a `{symbol: name}` map. |
| AI explanations | Claude Haiku via Anthropic API | Explains flags already computed in code. Never invents a signal, score, or verdict — it explains, it doesn't decide. |
| Explicitly NOT used | Screener.in (free tier disables export; paid tier not needed since the above covers the same fields) | Don't reintroduce this dependency. |

## Telegram briefings (Phase 2) — timing & content
Two **separate** scheduled workflows, both in `src/telegram_notify.py`. Cron is UTC;
IST = UTC+5:30. Built with `parse_mode: Markdown`; every message stamps the IST send
time and the data date so staleness is always visible (never silently implied).
- **Morning — 09:00 IST** (`morning-briefing.yml`, cron `30 3 * * 1-5`): refreshes
  global + India index levels **live** first, then sends: global overnight/Asia markets,
  India previous close, and the top watchlist leaders by flag count (from the last
  published pipeline run). yfinance only — no Angel login.
- **Evening — ~16:00 IST** (`daily-run.yml`, pipeline cron `15 10 * * 1-5` = 15:45 IST):
  the brief is the **last step of the pipeline**, sent only after every output file is
  written, so it is always internally consistent and reflects that day's close. Content:
  India indices, top gainers/losers across the watchlist, strongest sectors, and the
  portfolio breakdown with total unrealized P&L. It is intentionally coupled to the
  pipeline (not a fixed clock) so it never reads torn or stale files; on a slow run it
  drifts a little later but always carries same-day data.

Do not reuse the trading bot's Telegram token/channels — this is a separate bot.

**Why briefings can still arrive late — and what is actually fixable.** Two separate
causes, only one of which is ours:
1. *Pipeline runtime (fixed 2026-07-14).* The shareholding circuit breaker + Angel
   throttle/retry cut a ~66-minute run to a few minutes, so the evening brief now follows
   the pipeline start closely instead of an hour later.
2. *GitHub's scheduler (not fixable here).* Scheduled workflows on free runners are
   best-effort and are queued under load — the 2026-07-14 evening run was triggered
   **87 minutes** after its cron (`10:15 UTC` → started `11:42 UTC`). Nothing in this repo
   controls that; scheduling earlier does not help because the delay is random, and the
   close data does not exist before 15:30 IST anyway.
   This is why every message stamps its IST send time and data date: when GitHub drifts,
   the brief says so rather than implying it is punctual. If exact delivery times ever
   become a hard requirement, the fix is an external trigger (e.g. a cron on the existing
   Railway app) calling the workflow — do not contend for the bot's PythonAnywhere slot.

## Hosting & delivery
- **Default hosting: GitHub Actions (scheduled workflow) + GitHub Pages.** Fully free,
  no server to maintain, fits the periodic (not continuously-live) nature of this data.
- Alternative considered: running alongside the existing Railway app (blogwizard.in) —
  only if GitHub Actions/Pages turns out insufficient, and only after checking Railway
  usage headroom first.
- Do not use the bot's PythonAnywhere always-on task slot — that's a known binding
  constraint for the bot and should not be contended for.
- Delivery: responsive single web dashboard (mobile + desktop from one build, no
  native app) + Telegram briefings (morning/evening) via a **new, separate** Telegram
  bot — do not reuse the trading bot's token or channels.
- Domain: no new domain purchase needed. Use the free GitHub Pages URL, or a
  subdomain of the already-owned domain (e.g. `stocks.blogwizard.in`) via a CNAME
  record — optional, low priority, do last.

## Watchlist — must be editable, never hardcoded
- Store as a simple config (JSON/CSV file in the repo, or a DB table) — not baked
  into code.
- Adding a stock must "just work" on the next scheduled run: fetch OHLCV history
  (yfinance backfills historical data instantly, so EMA/RSI/etc. can compute
  immediately, no multi-day wait), pull fundamentals, and include it in ranking/alerts
  automatically.
- Removing a stock just drops it from the config; no cleanup of historical data required.
- Start with a rough/partial list (20–30 names) rather than waiting for the full
  120–150 stock universe to be finalized.

## Secrets — never hardcode
Store all of these as GitHub Actions repo secrets (Settings → Secrets and variables
→ Actions), read only as environment variables at runtime:
- `ANGEL_API_KEY`, `ANGEL_CLIENT_ID`, `ANGEL_PIN`, `ANGEL_TOTP_SECRET` (reused from bot)
- `ANTHROPIC_API_KEY` (reused from bot, or a separate key for isolated usage tracking)
- `TELEGRAM_BOT_TOKEN` (new bot, separate from the trading bot)
- No keys needed for `yfinance`, `nsepython`/`nselib`/`jugaad_data`

## Logging discipline (carried over from the bot's hard-won lessons)
Every skip, rejection, fallback, or missing-data path must emit an explicit log line.
No silent failures, no fake placeholder values (e.g. never silently substitute a
fallback RSI/ADX value on a fetch failure — log it and skip that stock's ranking
for that cycle instead). This was the single most costly bug class in the trading
bot's history (v25 forensic analysis) — do not repeat it here.

## Visual style
- **Light background only. No dark mode, ever, anywhere.**
- Glassmorphism: translucent white cards, backdrop blur, soft shadows, cool
  light-blue/mint gradient background.
- Color meaning is functional, not decorative: teal = bullish/positive flag,
  amber = caution/neutral, rose = bearish/weak — reserved for flag/status
  indicators only.
- Fonts used in the approved guide/mockup: Sora (headings), Inter (body),
  JetBrains Mono (tickers, prices, numeric data).

## Reference
The full build guide, cost breakdown, and visual mockup were already produced and
approved: `stock-dashboard-guide.html`. Check it for the agreed-on look and feel
before making independent visual design decisions. The 2026-07-13 redesign (see
"Dashboard layout" above) supersedes the mockup's *layout* — denser, multi-section —
but keeps its visual language (light glass, teal/amber/rose semantics, same fonts).
