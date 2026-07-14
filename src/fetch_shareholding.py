import nsepython

from src.logging_utils import get_logger, log_skip

logger = get_logger(__name__)

# NSE's public endpoints (wrapped by nsepython) are known to be flaky - they frequently
# block non-browser/datacenter traffic with a non-JSON response. Per CLAUDE.md, this is
# treated as best-effort: log the failure explicitly and skip this section for the
# stock this cycle rather than fabricating a shareholding figure.

SHAREHOLDING_FIELDS = {
    "pPromoterChangePerc": "promoter_holding_change_pct",
    "pFIIChangePerc": "fii_holding_change_pct",
    "pDIIChangePerc": "dii_holding_change_pct",
}

# Circuit breaker. When NSE blocks us it does so for the whole run, and each blocked call
# burns ~22s hanging before it fails - across ~180 symbols that was ~65 minutes of the
# pipeline's runtime spent learning the same "no" over and over, which pushed the evening
# briefing hours late and widened the window for Angel timeouts mid-run.
# After a few consecutive failures we stop trying for the rest of this run. Every skip is
# still logged individually (CLAUDE.md: no silent skips) and the UI keeps saying the
# section is unavailable - we just stop paying 22s to be told so.
_MAX_CONSECUTIVE_FAILURES = 3
_consecutive_failures = 0
_circuit_open = False


def reset_circuit() -> None:
    """Called at the start of a pipeline run so a fresh run always retries the source."""
    global _consecutive_failures, _circuit_open
    _consecutive_failures = 0
    _circuit_open = False


def _record_failure(symbol: str, reason: str) -> None:
    global _consecutive_failures, _circuit_open
    _consecutive_failures += 1
    log_skip(logger, symbol, "fetch_shareholding", reason)
    if not _circuit_open and _consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
        _circuit_open = True
        logger.warning(
            "OPENING shareholding circuit: NSE source failed %d times consecutively; "
            "skipping shareholding for the remaining symbols this run (saves ~22s/symbol). "
            "It is retried from scratch on the next run.",
            _consecutive_failures,
        )


def fetch_shareholding(symbol: str) -> dict | None:
    global _consecutive_failures
    if _circuit_open:
        log_skip(logger, symbol, "fetch_shareholding", "skipped: NSE shareholding circuit open for this run")
        return None

    try:
        data = nsepython.nse_eq(symbol)
    except Exception as exc:
        _record_failure(symbol, f"nsepython.nse_eq raised {exc!r}")
        return None

    if not data:
        _record_failure(symbol, "nsepython.nse_eq returned no data")
        return None

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
        _record_failure(symbol, "no shareholding fields present in response")
        return None

    # A genuine success means the source is answering again - forget earlier failures so
    # one flaky patch mid-run doesn't trip the breaker.
    _consecutive_failures = 0
    return result


if __name__ == "__main__":
    for test_symbol in ("RELIANCE", "TCS", "INFY"):
        logger.info("%s shareholding: %s", test_symbol, fetch_shareholding(test_symbol))
