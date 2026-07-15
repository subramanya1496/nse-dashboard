"""Validates data/output before it is committed and published.

The 2026-07-14 incident is the reason this exists: a run where Angel timed out lost
137/184 symbols and the workflow happily published the wreckage, emptying the dashboard
and the portfolio for the rest of the day. Publishing bad data is worse than keeping
yesterday's good data live.

Run as the workflow step between the pipeline and the commit/Telegram steps:

    python -m src.validate_output

Exit code 0 = safe to publish. Exit code 1 = do NOT publish (the workflow stops, the
previously published data stays live, and no misleading Telegram brief goes out).
A full check-by-check report is written to data/output/validation_report.json either way.
"""

import json
import sys
from datetime import datetime, timezone

from src import config
from src.logging_utils import get_logger

logger = get_logger(__name__)

# A run that priced fewer than this fraction of symbols is treated as broken: better to
# keep yesterday's complete dashboard than publish today's fragment. (The 2026-07-14 bad
# run scored 0.21; normal runs score >0.95.)
MIN_OK_RATIO = 0.6
# meta.run_at older than this means we're somehow validating a previous run's output.
MAX_RUN_AGE_HOURS = 6


class Checks:
    def __init__(self) -> None:
        self.results: list[dict] = []

    def add(self, name: str, ok: bool, detail: str, fatal: bool = True) -> None:
        status = "pass" if ok else ("fail" if fatal else "warn")
        self.results.append({"check": name, "status": status, "detail": detail})
        log = logger.info if ok else (logger.error if fatal else logger.warning)
        log("validation %s: %s — %s", status.upper(), name, detail)

    @property
    def failed(self) -> bool:
        return any(r["status"] == "fail" for r in self.results)


def _load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _validate_stock_file(symbol: str, stock: dict) -> str | None:
    """Returns a problem description, or None if the file is sound."""
    if stock.get("symbol") != symbol:
        return f"symbol field {stock.get('symbol')!r} does not match filename"
    ind = stock.get("indicators") or {}
    close = ind.get("close")
    if not isinstance(close, (int, float)) or close <= 0:
        return f"close is {close!r}"
    rsi = ind.get("rsi14")
    if rsi is not None and not (0 <= rsi <= 100):
        return f"rsi14 out of range: {rsi!r}"
    flags = stock.get("flags") or {}
    count, total = flags.get("flag_count"), flags.get("flag_total")
    if not isinstance(count, int) or not isinstance(total, int) or not (0 <= count <= total):
        return f"flag_count/flag_total invalid: {count!r}/{total!r}"
    if not stock.get("price_history"):
        return "price_history empty"
    return None


def validate() -> bool:
    checks = Checks()

    # --- meta.json: the run happened, recently, and mostly succeeded ---
    meta = _load_json(config.OUTPUT_DIR / "meta.json")
    if meta is None:
        checks.add("meta_readable", False, "meta.json missing or unparseable")
        return _finish(checks)
    checks.add("meta_readable", True, "meta.json loads")

    try:
        run_age_h = (datetime.now(timezone.utc) - datetime.fromisoformat(meta["run_at"])).total_seconds() / 3600
        checks.add(
            "run_recent", run_age_h < MAX_RUN_AGE_HOURS,
            f"run_at is {run_age_h:.1f}h old (limit {MAX_RUN_AGE_HOURS}h)",
        )
    except (KeyError, ValueError):
        checks.add("run_recent", False, "meta.run_at missing or unparseable")

    summary = meta.get("summary") or {}
    total, ok = summary.get("total", 0), summary.get("ok", 0)
    ratio = ok / total if total else 0
    checks.add(
        "ok_ratio", ratio >= MIN_OK_RATIO,
        f"{ok}/{total} symbols ok ({ratio:.0%}; minimum {MIN_OK_RATIO:.0%}) — a lower ratio means "
        "the run lost most of its data and should not replace the last good publish",
    )

    # --- per-stock files: every 'ok' symbol has a sound file ---
    ok_symbols = [s for s, v in (meta.get("symbols") or {}).items() if v.get("status") == "ok"]
    problems: dict[str, str] = {}
    for symbol in ok_symbols:
        stock = _load_json(config.STOCKS_OUTPUT_DIR / f"{symbol}.json")
        if stock is None:
            problems[symbol] = "file missing or unparseable"
            continue
        problem = _validate_stock_file(symbol, stock)
        if problem:
            problems[symbol] = problem
    checks.add(
        "stock_files_sound", not problems,
        f"{len(ok_symbols) - len(problems)}/{len(ok_symbols)} ok-symbol files valid"
        + (f"; problems: {problems}" if problems else ""),
    )

    # --- portfolio.json: every configured holding is present (priced or explicitly not) ---
    portfolio_out = _load_json(config.OUTPUT_DIR / "portfolio.json")
    portfolio_cfg = _load_json(config.PORTFOLIO_PATH) or {}
    cfg_symbols = {h["symbol"] for h in portfolio_cfg.get("holdings", [])}
    out_symbols = {h.get("symbol") for h in (portfolio_out or {}).get("holdings", [])}
    checks.add(
        "portfolio_complete", cfg_symbols == out_symbols,
        f"configured={sorted(cfg_symbols)} published={sorted(out_symbols)}"
        if cfg_symbols != out_symbols else f"all {len(cfg_symbols)} holdings present",
    )

    # --- sectors + market: present, but index gaps are a warning, not a block ---
    sectors = _load_json(config.OUTPUT_DIR / "sectors.json")
    checks.add("sectors_present", bool(sectors), f"{len(sectors or [])} sectors")
    market = _load_json(config.OUTPUT_DIR / "market.json")
    india_count = len((market or {}).get("indices", []))
    checks.add(
        "market_indices", india_count > 0,
        f"{india_count} India indices published", fatal=False,
    )

    return _finish(checks)


def _finish(checks: Checks) -> bool:
    passed = not checks.failed
    report = {
        "validated_at": datetime.now(timezone.utc).isoformat(),
        "result": "pass" if passed else "fail",
        "checks": checks.results,
    }
    (config.OUTPUT_DIR / "validation_report.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    if passed:
        logger.info("validation PASSED — output is safe to publish")
    else:
        logger.error("validation FAILED — output must NOT be published (previous publish stays live)")
    return passed


if __name__ == "__main__":
    sys.exit(0 if validate() else 1)
