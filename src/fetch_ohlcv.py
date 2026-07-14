import time
from datetime import datetime, timedelta

import pandas as pd
from SmartApi import SmartConnect

from src.logging_utils import get_logger, log_skip

logger = get_logger(__name__)

LOOKBACK_DAYS = 450  # comfortably covers EMA200 + ATR/ADX warmup on trading days
OHLCV_COLUMNS = ["date", "open", "high", "low", "close", "volume"]

# Angel's historical endpoint allows ~3 requests/sec and its client uses an aggressive
# 7s read timeout. A single ReadTimeout used to drop the symbol for the whole day (a
# 2026-07-14 run lost 137/184 symbols that way). Two defences, both logged:
#   1. throttle - keep a minimum gap between calls so we stay under the rate limit
#   2. retry    - transient timeouts/failures get another attempt with backoff before
#                 the symbol is skipped, so a slow patch on Angel's side doesn't wipe
#                 out the run. Still no fake candles: exhausted retries -> skip + log.
_MIN_INTERVAL_SEC = 0.4
_MAX_ATTEMPTS = 3
_last_call_ts = 0.0


def _throttle() -> None:
    global _last_call_ts
    elapsed = time.monotonic() - _last_call_ts
    if elapsed < _MIN_INTERVAL_SEC:
        time.sleep(_MIN_INTERVAL_SEC - elapsed)
    _last_call_ts = time.monotonic()


def _request_candles(smart_connect: SmartConnect, symbol: str, params: dict):
    """One getCandleData call per attempt, with throttle + backoff. Returns rows or None."""
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        _throttle()
        try:
            response = smart_connect.getCandleData(params)
        except Exception as exc:  # SmartAPI raises assorted exceptions on network/auth failure
            wait = _MIN_INTERVAL_SEC * (2**attempt)
            log_skip(logger, symbol, "fetch_ohlcv", f"getCandleData raised {exc!r} (attempt {attempt}/{_MAX_ATTEMPTS}, backoff {wait:.1f}s)")
            time.sleep(wait)
            continue

        if not response or not response.get("status"):
            message = response.get("message") if response else "no response"
            wait = _MIN_INTERVAL_SEC * (2**attempt)
            log_skip(logger, symbol, "fetch_ohlcv", f"API returned failure: {message} (attempt {attempt}/{_MAX_ATTEMPTS}, backoff {wait:.1f}s)")
            time.sleep(wait)
            continue

        rows = response.get("data") or []
        if not rows:
            log_skip(logger, symbol, "fetch_ohlcv", "API returned zero candles")
            return None
        return rows

    log_skip(logger, symbol, "fetch_ohlcv", f"giving up after {_MAX_ATTEMPTS} attempts")
    return None


def fetch_daily_ohlcv(smart_connect: SmartConnect, symbol: str, symboltoken: str) -> pd.DataFrame | None:
    """Fetch daily OHLCV candles for one symbol. Returns None (and logs) on any failure."""
    to_date = datetime.now()
    from_date = to_date - timedelta(days=LOOKBACK_DAYS)

    params = {
        "exchange": "NSE",
        "symboltoken": symboltoken,
        "interval": "ONE_DAY",
        "fromdate": from_date.strftime("%Y-%m-%d 09:00"),
        "todate": to_date.strftime("%Y-%m-%d 15:30"),
    }

    rows = _request_candles(smart_connect, symbol, params)
    if rows is None:
        return None

    df = pd.DataFrame(rows, columns=OHLCV_COLUMNS)
    df["date"] = pd.to_datetime(df["date"])
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col])
    df = df.sort_values("date").reset_index(drop=True)

    logger.info(
        "fetched %d daily candles for symbol=%s (%s -> %s)",
        len(df),
        symbol,
        df["date"].iloc[0].date(),
        df["date"].iloc[-1].date(),
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
