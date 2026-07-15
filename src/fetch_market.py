"""Market-wide data for the dashboard header: index levels (NIFTY/SENSEX/BANKNIFTY/VIX)
and a lightweight news feed for the most relevant symbols.

All of it comes from yfinance (free, no key). Same discipline as the rest of the
pipeline: throttle between calls, retry with backoff, and log every skip — a missing
index or empty news list must never fail silently or be replaced with a fake value.
"""

import json
import re
import time
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import requests
import yfinance as yf

from src import config, run_stats
from src.logging_utils import get_logger, log_skip
from src.net_utils import CircuitBreaker, Throttle

logger = get_logger(__name__)

_MAX_RETRIES = 3
_throttle_gate = Throttle(min_interval_sec=1.5)
# Yahoo's chart endpoint usually answers from CI, but on 2026-07-15 it rate-limited a
# whole run: 13 indices x full retry backoff burned ~5 minutes and produced nothing.
# All indices share one endpoint, so once a few fail in a row the rest will too.
index_breaker = CircuitBreaker("yfinance-index-history", logger, max_consecutive_failures=3)


def _throttle() -> None:
    _throttle_gate.wait()

INDICES = [
    {"key": "nifty50", "label": "NIFTY 50", "yahoo": "^NSEI"},
    {"key": "sensex", "label": "SENSEX", "yahoo": "^BSESN"},
    {"key": "banknifty", "label": "BANK NIFTY", "yahoo": "^NSEBANK"},
    {"key": "india_vix", "label": "INDIA VIX", "yahoo": "^INDIAVIX"},
]

# Global markets for the morning brief: India opens after the US close and during the
# Asian session, so an overnight read of these gives the day's likely tone. Kept short
# to bound the throttled request count. FX/commodities go through the same daily fetch.
GLOBAL_INDICES = [
    {"key": "sp500", "label": "S&P 500", "yahoo": "^GSPC"},
    {"key": "nasdaq", "label": "Nasdaq", "yahoo": "^IXIC"},
    {"key": "dow", "label": "Dow Jones", "yahoo": "^DJI"},
    {"key": "nikkei", "label": "Nikkei 225", "yahoo": "^N225"},
    {"key": "hangseng", "label": "Hang Seng", "yahoo": "^HSI"},
    {"key": "ftse", "label": "FTSE 100", "yahoo": "^FTSE"},
    {"key": "usdinr", "label": "USD / INR", "yahoo": "INR=X"},
    {"key": "brent", "label": "Brent Crude", "yahoo": "BZ=F"},
    {"key": "gold", "label": "Gold", "yahoo": "GC=F"},
]

_HISTORY_DAYS = 30


def _fetch_index(entry: dict) -> dict | None:
    for attempt in range(1, _MAX_RETRIES + 1):
        if index_breaker.is_open:
            index_breaker.skip(entry["key"], "fetch_index")
            return None
        _throttle()
        run_stats.bump("api_calls_yfinance_history")
        try:
            hist = yf.Ticker(entry["yahoo"]).history(period="3mo", interval="1d")
        except Exception as exc:
            wait = _throttle_gate.min_interval_sec * (2**attempt)
            log_skip(logger, entry["key"], "fetch_index", f"history raised {exc!r} (attempt {attempt}/{_MAX_RETRIES}, backoff {wait:.1f}s)")
            run_stats.bump("retries_yfinance_history")
            time.sleep(wait)
            continue
        if hist is None or hist.empty or "Close" not in hist:
            wait = _throttle_gate.min_interval_sec * (2**attempt)
            log_skip(logger, entry["key"], "fetch_index", f"empty history (attempt {attempt}/{_MAX_RETRIES}, backoff {wait:.1f}s)")
            run_stats.bump("retries_yfinance_history")
            time.sleep(wait)
            continue
        index_breaker.record_success()
        closes = hist["Close"].dropna()
        if len(closes) < 2:
            log_skip(logger, entry["key"], "fetch_index", "fewer than 2 closes; cannot compute change")
            return None
        last = float(closes.iloc[-1])
        prev = float(closes.iloc[-2])
        tail = closes.iloc[-_HISTORY_DAYS:]
        return {
            "key": entry["key"],
            "label": entry["label"],
            "close": round(last, 2),
            "prev_close": round(prev, 2),
            "change_pct": round((last - prev) / prev * 100, 3) if prev else None,
            "as_of": tail.index[-1].date().isoformat(),
            "history": [
                {"date": idx.date().isoformat(), "close": round(float(val), 2)}
                for idx, val in tail.items()
            ],
        }
    # Exhausted retries: count it toward the shared breaker so a fully rate-limited run
    # stops after ~3 indices instead of burning full backoff on all 13.
    index_breaker.record_failure(entry["key"], "fetch_index", f"unusable after {_MAX_RETRIES} attempts")
    return None


def _fetch_index_group(entries: list[dict]) -> list[dict]:
    results = []
    for entry in entries:
        result = _fetch_index(entry)
        if result is None:
            log_skip(logger, entry["key"], "write_market_output", "index unavailable this run; omitted (frontend shows explicit gap)")
            continue
        results.append(result)
    return results


def _previous_market_output() -> dict:
    path = config.OUTPUT_DIR / "market.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("could not read previous market.json: %r", exc)
        return {}


def write_market_output() -> None:
    """Fetch Indian + global index quotes and write data/output/market.json.

    The dashboard's sticky strip reads `indices` (India); the morning Telegram brief
    also reads `global_indices`. Individual failed indices are omitted (logged) rather
    than given placeholder values.

    If an ENTIRE group comes back empty (Yahoo rate-limited the whole run, as on
    2026-07-15), the previous run's group is kept instead of clobbering good data with
    nothing: each index entry carries its own `as_of` date, so the staleness stays
    visible, and `<group>_stale_from` records when the kept data was fetched.
    """
    indices = _fetch_index_group(INDICES)
    global_indices = _fetch_index_group(GLOBAL_INDICES)

    previous = _previous_market_output()
    payload: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    for group_key, fetched in (("indices", indices), ("global_indices", global_indices)):
        kept = previous.get(group_key) or []
        if not fetched and kept:
            logger.warning(
                "%s: fetch produced nothing this run; keeping the %d previously published "
                "entries (fetched %s) instead of publishing an empty strip — per-entry "
                "as_of dates show their true age",
                group_key, len(kept), previous.get("updated_at"),
            )
            payload[group_key] = kept
            payload[f"{group_key}_stale_from"] = previous.get(f"{group_key}_stale_from") or previous.get("updated_at")
            run_stats.bump(f"stale_kept_{group_key}")
        else:
            payload[group_key] = fetched

    (config.OUTPUT_DIR / "market.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    logger.info(
        "wrote market.json with %d/%d India + %d/%d global indices%s",
        len(payload["indices"]), len(INDICES), len(payload["global_indices"]), len(GLOBAL_INDICES),
        " [stale groups kept]" if any(k.endswith("_stale_from") for k in payload) else "",
    )


# --- News -----------------------------------------------------------------------
# Sentiment here is a transparent keyword tagger, clearly labelled in the payload and
# the UI as "keyword" — it is NOT the Phase 3 AI layer and must not pretend to be.
# Unmatched headlines stay "neutral" rather than being guessed.

_POSITIVE_RE = re.compile(
    r"\b(surge[sd]?|soar(s|ed)?|rall(y|ies|ied)|jump(s|ed)?|gain(s|ed)?|record high|beat[s]?|"
    r"profit rises|upgrade[sd]?|wins?|order win|bonus|buyback|strong|growth|expands?|approval)\b",
    re.IGNORECASE,
)
_NEGATIVE_RE = re.compile(
    r"\b(fall[s]?|fell|plunge[sd]?|slump(s|ed)?|drop(s|ped)?|crash(es|ed)?|los(s|ses|es)|miss(es|ed)?|"
    r"downgrade[sd]?|probe|fraud|penalt(y|ies)|fine[sd]?|weak|decline[sd]?|layoff[s]?|default)\b",
    re.IGNORECASE,
)


def _classify_headline(title: str) -> str:
    pos = bool(_POSITIVE_RE.search(title))
    neg = bool(_NEGATIVE_RE.search(title))
    if pos and not neg:
        return "positive"
    if neg and not pos:
        return "negative"
    return "neutral"


# Source: Google News RSS, India edition. yfinance's `.news` endpoint returns an empty
# list from GitHub's runners (Yahoo blocks datacenter IPs) — a 2026-07-14 run published
# news.json with 0 items for all 21 symbols. This RSS feed answers from CI, returns
# same-day India-focused coverage, and needs no key. Titles carry a " - Publisher"
# suffix which we strip into the publisher field.
_GOOGLE_NEWS_RSS = "https://news.google.com/rss/search?q={query}&hl=en-IN&gl=IN&ceid=IN:en"
_NEWS_TIMEOUT_SEC = 15
_NEWS_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; nse-dashboard/1.0)"}


def _rss_published_iso(text: str | None) -> str | None:
    if not text:
        return None
    try:
        return parsedate_to_datetime(text).astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError):
        return None


def _split_title_publisher(raw_title: str, source_el) -> tuple[str, str | None]:
    publisher = source_el.text.strip() if source_el is not None and source_el.text else None
    title = raw_title.strip()
    if publisher and title.endswith(f" - {publisher}"):
        title = title[: -(len(publisher) + 3)].strip()
    return title, publisher


def fetch_news_for_symbol(symbol: str, name: str | None = None, max_items: int = 3) -> list[dict]:
    """Recent headlines for one symbol. Returns [] (and logs) if the feed is unusable."""
    query = urllib.parse.quote(f"{name or symbol} share")
    url = _GOOGLE_NEWS_RSS.format(query=query)

    _throttle()
    try:
        response = requests.get(url, timeout=_NEWS_TIMEOUT_SEC, headers=_NEWS_HEADERS)
    except Exception as exc:
        log_skip(logger, symbol, "fetch_news", f"news RSS request raised {exc!r}")
        return []
    if not response.ok:
        log_skip(logger, symbol, "fetch_news", f"news RSS returned HTTP {response.status_code}")
        return []

    try:
        root = ET.fromstring(response.content)
    except ET.ParseError as exc:
        log_skip(logger, symbol, "fetch_news", f"news RSS not parseable: {exc!r}")
        return []

    items = []
    for entry in root.findall(".//item")[:max_items]:
        raw_title = entry.findtext("title")
        if not raw_title:
            log_skip(logger, symbol, "fetch_news", "news item without title; skipped")
            continue
        title, publisher = _split_title_publisher(raw_title, entry.find("source"))
        items.append(
            {
                "symbol": symbol,
                "title": title,
                "publisher": publisher,
                "link": entry.findtext("link"),
                "published_at": _rss_published_iso(entry.findtext("pubDate")),
                "sentiment": _classify_headline(title),
                "sentiment_source": "keyword",
            }
        )
    if not items:
        log_skip(logger, symbol, "fetch_news", "no usable news items this run")
    return items


def write_news_output(symbols: list[str] | dict[str, str]) -> None:
    """Fetch a small news feed and write data/output/news.json.

    Accepts either a list of symbols or a {symbol: company_name} map — the company name
    makes the search far more accurate than the bare ticker (e.g. "BEL" alone is noise).
    """
    name_by_symbol = symbols if isinstance(symbols, dict) else {s: s for s in symbols}
    all_items: list[dict] = []
    seen_titles: set[str] = set()
    for symbol, name in name_by_symbol.items():
        for item in fetch_news_for_symbol(symbol, name):
            key = item["title"].strip().lower()
            if key in seen_titles:
                continue
            seen_titles.add(key)
            all_items.append(item)

    all_items.sort(key=lambda i: i.get("published_at") or "", reverse=True)
    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "symbols_covered": list(name_by_symbol),
        "source": "google_news_rss",
        "items": all_items,
    }
    (config.OUTPUT_DIR / "news.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    logger.info("wrote news.json with %d items across %d symbols", len(all_items), len(name_by_symbol))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Refresh market.json (and optionally news.json).")
    parser.add_argument(
        "--indices-only",
        action="store_true",
        help="Only refresh index levels (used by the morning brief; skips the slower news fetch).",
    )
    parser.add_argument("--news", nargs="*", help="Symbols to fetch news for when not --indices-only.")
    args = parser.parse_args()

    write_market_output()
    if not args.indices_only:
        write_news_output(args.news or ["RELIANCE", "TCS"])
