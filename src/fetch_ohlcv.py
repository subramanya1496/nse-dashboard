import json
import time
from datetime import datetime, timedelta, timezone

import pandas as pd
from SmartApi import SmartConnect

from src import config, run_stats
from src.logging_utils import get_logger, log_skip
from src.net_utils import Throttle

logger = get_logger(__name__)

LOOKBACK_DAYS = 450  # comfortably covers EMA200 + ATR/ADX warmup on trading days
OHLCV_COLUMNS = ["date", "open", "high", "low", "close", "volume"]

# Angel's historical endpoint allows ~3 requests/sec and its client uses an aggressive
# 7s read timeout. A single ReadTimeout used to drop the symbol for the whole day (a
# 2026-07-14 run lost 137/184 symbols that way). Defences, all logged:
#   1. throttle    - keep a minimum gap between calls so we stay under the rate limit
#                    (shared and thread-safe: the pipeline runs symbols concurrently)
#   2. retry       - transient timeouts/failures get another attempt with backoff
#   3. incremental - candle history is cached per symbol; a normal daily run only asks
#                    Angel for the last few days and merges them into the cache instead
#                    of re-downloading 450 days per symbol per day
#   4. same-day fallback - if Angel fails but an earlier run TODAY already fetched this
#                    symbol successfully, serve that cache (the close can't have changed
#                    after hours). A cache from yesterday is never served as today —
#                    stale data dressed as fresh is worse than an honest gap.
# Exhausted retries with no same-day cache still skip + log — never a fabricated candle.
_MAX_ATTEMPTS = 3
_INCREMENTAL_OVERLAP_DAYS = 5  # refetch a few trailing days so upstream corrections land
_SAME_DAY_FALLBACK_MAX_AGE_SEC = 12 * 3600
_CACHE_DIR = config.CACHE_DIR / "ohlcv"

_throttle_gate = Throttle(min_interval_sec=0.4)


def _cache_path(symbol: str):
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _CACHE_DIR / f"{symbol}.json"


def _read_cache(symbol: str) -> tuple[pd.DataFrame | None, float | None]:
    """Returns (candles DataFrame, cache age in seconds) or (None, None)."""
    path = _cache_path(symbol)
    if not path.exists():
        return None, None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        df = pd.DataFrame(payload["candles"], columns=OHLCV_COLUMNS)
        df["date"] = pd.to_datetime(df["date"])
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(payload["fetched_at"])).total_seconds()
        if df.empty:
            return None, None
        return df, age
    except (json.JSONDecodeError, KeyError, ValueError, OSError) as exc:
        log_skip(logger, symbol, "ohlcv_cache", f"unreadable cache: {exc!r}")
        return None, None


def _write_cache(symbol: str, df: pd.DataFrame) -> None:
    candles = df.copy()
    candles["date"] = candles["date"].dt.strftime("%Y-%m-%d %H:%M:%S")
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "candles": candles.values.tolist(),
    }
    try:
        _cache_path(symbol).write_text(json.dumps(payload), encoding="utf-8")
    except OSError as exc:
        log_skip(logger, symbol, "ohlcv_cache", f"could not write cache: {exc!r}")


def _request_candles(smart_connect: SmartConnect, symbol: str, params: dict):
    """One getCandleData call per attempt, with throttle + backoff. Returns rows or None."""
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        _throttle_gate.wait()
        run_stats.bump("api_calls_angel_ohlcv")
        try:
            response = smart_connect.getCandleData(params)
        except Exception as exc:  # SmartAPI raises assorted exceptions on network/auth failure
            wait = _throttle_gate.min_interval_sec * (2**attempt)
            log_skip(logger, symbol, "fetch_ohlcv", f"getCandleData raised {exc!r} (attempt {attempt}/{_MAX_ATTEMPTS}, backoff {wait:.1f}s)")
            run_stats.bump("retries_angel_ohlcv")
            time.sleep(wait)
            continue

        if not response or not response.get("status"):
            message = response.get("message") if response else "no response"
            wait = _throttle_gate.min_interval_sec * (2**attempt)
            log_skip(logger, symbol, "fetch_ohlcv", f"API returned failure: {message} (attempt {attempt}/{_MAX_ATTEMPTS}, backoff {wait:.1f}s)")
            run_stats.bump("retries_angel_ohlcv")
            time.sleep(wait)
            continue

        rows = response.get("data") or []
        if not rows:
            log_skip(logger, symbol, "fetch_ohlcv", "API returned zero candles")
            return None
        return rows

    log_skip(logger, symbol, "fetch_ohlcv", f"giving up after {_MAX_ATTEMPTS} attempts")
    return None


def _rows_to_df(rows: list) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=OHLCV_COLUMNS)
    # Angel stamps candles with an IST offset (+05:30). Strip the offset but KEEP the
    # IST wall-clock date — converting to UTC would shift every candle to the previous
    # evening — so cached and fresh candles always compare as naive timestamps.
    parsed = pd.to_datetime(df["date"])
    if parsed.dt.tz is not None:
        parsed = parsed.dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    df["date"] = parsed
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col])
    return df.sort_values("date").reset_index(drop=True)


def _merge_candles(cached: pd.DataFrame, fresh: pd.DataFrame) -> pd.DataFrame:
    """Fresh rows win on overlapping dates (Angel occasionally revises a candle)."""
    merged = pd.concat([cached, fresh], ignore_index=True)
    merged = merged.drop_duplicates(subset="date", keep="last")
    merged = merged.sort_values("date").reset_index(drop=True)
    cutoff = datetime.now() - timedelta(days=LOOKBACK_DAYS)
    return merged[merged["date"] >= cutoff].reset_index(drop=True)


def fetch_daily_ohlcv(smart_connect: SmartConnect, symbol: str, symboltoken: str) -> pd.DataFrame | None:
    """Fetch daily OHLCV candles for one symbol. Returns None (and logs) on any failure."""
    to_date = datetime.now()
    cached_df, cache_age = _read_cache(symbol)

    if cached_df is not None:
        # Incremental: only ask Angel for the window since the last cached candle.
        from_date = cached_df["date"].max() - timedelta(days=_INCREMENTAL_OVERLAP_DAYS)
        run_stats.bump("ohlcv_incremental_fetches")
    else:
        from_date = to_date - timedelta(days=LOOKBACK_DAYS)
        run_stats.bump("ohlcv_full_fetches")

    params = {
        "exchange": "NSE",
        "symboltoken": symboltoken,
        "interval": "ONE_DAY",
        "fromdate": from_date.strftime("%Y-%m-%d 09:00"),
        "todate": to_date.strftime("%Y-%m-%d 15:30"),
    }

    rows = _request_candles(smart_connect, symbol, params)
    if rows is None:
        if cached_df is not None and cache_age is not None and cache_age < _SAME_DAY_FALLBACK_MAX_AGE_SEC:
            log_skip(logger, symbol, "fetch_ohlcv", f"Angel failed; serving candles cached {cache_age/3600:.1f}h ago by an earlier run today")
            run_stats.bump("ohlcv_same_day_cache_served")
            return cached_df
        return None

    fresh = _rows_to_df(rows)
    df = _merge_candles(cached_df, fresh) if cached_df is not None else fresh
    _write_cache(symbol, df)

    logger.info(
        "fetched %d daily candles for symbol=%s (%s -> %s)%s",
        len(fresh),
        symbol,
        df["date"].iloc[0].date(),
        df["date"].iloc[-1].date(),
        " [incremental]" if cached_df is not None else "",
    )
    return df


if __name__ == "__main__":
    from src.angel_auth import login
    from src.instrument_master import build_nse_equity_token_map, get_token

    conn, _ = login()
    token_map = build_nse_equity_token_map()

    for test_symbol in ("RELIANCE", "TCS", "INFY"):
        tok = get_token(test_symbol, token_map)
        if tok is None:
            continue
        candles = fetch_daily_ohlcv(conn, test_symbol, tok)
        if candles is not None:
            logger.info("%s tail:\n%s", test_symbol, candles.tail(3).to_string(index=False))
