import json
from datetime import datetime, timezone

import nsepython

from src import config, run_stats
from src.logging_utils import get_logger, log_skip
from src.net_utils import CircuitBreaker

logger = get_logger(__name__)

# NSE's public endpoints (wrapped by nsepython) are known to be flaky - they frequently
# block non-browser/datacenter traffic with a non-JSON response after hanging ~22s.
# Per CLAUDE.md, this is treated as best-effort: log the failure explicitly and skip
# this section for the stock this cycle rather than fabricating a shareholding figure.
#
# Two layers keep this cheap:
#   - 30-day disk cache (monthly tier): shareholding patterns are filed quarterly, so
#     a rare successful fetch is worth keeping for a month. Also serves as the stale
#     fallback (logged) when the source is blocking.
#   - Circuit breaker: when NSE blocks, it blocks for the whole run; after 3 straight
#     failures we stop paying ~22s per symbol to be told the same "no". Every skip is
#     still logged individually. The pipeline resets the circuit each run.

SHAREHOLDING_FIELDS = {
    "pPromoterChangePerc": "promoter_holding_change_pct",
    "pFIIChangePerc": "fii_holding_change_pct",
    "pDIIChangePerc": "dii_holding_change_pct",
}

_CACHE_TTL_SEC = 30 * 24 * 3600
_CACHE_DIR = config.CACHE_DIR / "shareholding"

breaker = CircuitBreaker("nse-shareholding", logger, max_consecutive_failures=3)


def reset_circuit() -> None:
    """Called at the start of a pipeline run so a fresh run always retries the source."""
    breaker.reset()


def _cache_path(symbol: str):
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _CACHE_DIR / f"{symbol}.json"


def _read_cache(symbol: str) -> dict | None:
    path = _cache_path(symbol)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        log_skip(logger, symbol, "shareholding_cache", f"unreadable cache: {exc!r}")
        return None


def _cache_age_sec(cached: dict) -> float | None:
    try:
        fetched = datetime.fromisoformat(cached["fetched_at"])
    except (KeyError, ValueError):
        return None
    return (datetime.now(timezone.utc) - fetched).total_seconds()


def _write_cache(symbol: str, result: dict) -> None:
    payload = {"fetched_at": datetime.now(timezone.utc).isoformat(), "result": result}
    try:
        _cache_path(symbol).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except OSError as exc:
        log_skip(logger, symbol, "shareholding_cache", f"could not write cache: {exc!r}")


def fetch_shareholding(symbol: str) -> dict | None:
    cached = _read_cache(symbol)
    if cached:
        age = _cache_age_sec(cached)
        if age is not None and age < _CACHE_TTL_SEC:
            run_stats.bump("cache_hits_shareholding")
            return cached["result"]
    run_stats.bump("cache_misses_shareholding")

    if breaker.is_open:
        breaker.skip(symbol, "fetch_shareholding")
        if cached:
            run_stats.bump("stale_cache_served_shareholding")
            return cached["result"]
        return None

    run_stats.bump("api_calls_nse_shareholding")
    try:
        data = nsepython.nse_eq(symbol)
    except Exception as exc:
        breaker.record_failure(symbol, "fetch_shareholding", f"nsepython.nse_eq raised {exc!r}")
        return _stale_or_none(symbol, cached)

    if not data:
        breaker.record_failure(symbol, "fetch_shareholding", "nsepython.nse_eq returned no data")
        return _stale_or_none(symbol, cached)

    security_info = data.get("securityWiseDP") or {}
    result = {}
    for nse_key, out_key in SHAREHOLDING_FIELDS.items():
        value = security_info.get(nse_key)
        if value is None:
            log_skip(logger, symbol, "fetch_shareholding", f"missing field {nse_key}")
        result[out_key] = value

    if all(v is None for v in result.values()):
        # A response with none of the fields means the source is fobbing us off (blocked
        # or a stub payload), so it counts toward the circuit just like a hard failure.
        breaker.record_failure(symbol, "fetch_shareholding", "no shareholding fields present in response")
        return _stale_or_none(symbol, cached)

    # A genuine success means the source is answering - forget earlier failures so one
    # flaky patch mid-run doesn't trip the breaker, and keep the result for a month.
    breaker.record_success()
    _write_cache(symbol, result)
    return result


def _stale_or_none(symbol: str, cached: dict | None) -> dict | None:
    if cached:
        run_stats.bump("stale_cache_served_shareholding")
        log_skip(logger, symbol, "fetch_shareholding", "fetch failed; serving stale cached shareholding")
        return cached["result"]
    return None


if __name__ == "__main__":
    for test_symbol in ("RELIANCE", "TCS", "INFY"):
        logger.info("%s shareholding: %s", test_symbol, fetch_shareholding(test_symbol))
