import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from src import config, run_stats
from src.angel_auth import AngelAuthError, login
from src.fetch_fundamentals import breaker as fundamentals_breaker, fetch_market_view
from src.fetch_market import index_breaker, write_market_output, write_news_output
from src.fetch_ohlcv import fetch_daily_ohlcv
from src.fetch_shareholding import fetch_shareholding, reset_circuit as reset_shareholding_circuit
from src.flags import FLAG_DEFINITIONS, evaluate_flags
from src.indicators import compute_indicators, latest_indicator_snapshot, recent_price_history
from src.instrument_master import build_nse_equity_token_map, get_token
from src.logging_utils import get_logger, log_skip

logger = get_logger(__name__)

_PROGRESS_EVERY = 10  # log a progress/ETA line every N completed symbols


def load_watchlist() -> list[dict]:
    return json.loads(config.WATCHLIST_PATH.read_text(encoding="utf-8"))


def load_portfolio() -> dict:
    return json.loads(config.PORTFOLIO_PATH.read_text(encoding="utf-8"))


def _write_flag_definitions() -> None:
    definitions = [{"key": key, "label": label} for key, label in FLAG_DEFINITIONS]
    (config.OUTPUT_DIR / "flag_definitions.json").write_text(
        json.dumps(definitions, indent=2), encoding="utf-8"
    )


def _process_symbol(conn, token_map: dict, symbol: str, watch_info: dict) -> tuple[dict, dict | None]:
    """Full per-symbol work: candles -> indicators -> flags -> context -> stock JSON.

    Returns (meta_entry, stock_json|None). Runs on a worker thread; every external call
    inside goes through its module's thread-safe throttle/breaker, and any failure here
    only costs this one symbol — never the run.
    """
    token = get_token(symbol, token_map)
    if token is None:
        return {"status": "skipped", "reason": "no symboltoken found"}, None

    ohlcv = fetch_daily_ohlcv(conn, symbol, token)
    if ohlcv is None:
        return {"status": "skipped", "reason": "ohlcv fetch failed"}, None

    enriched = compute_indicators(symbol, ohlcv)
    if enriched is None:
        return {"status": "skipped", "reason": "insufficient history for indicators"}, None

    snapshot = latest_indicator_snapshot(enriched)
    flag_result = evaluate_flags(snapshot)

    market_view = fetch_market_view(symbol)
    fundamentals = market_view["fundamentals"]
    analyst = market_view["analyst"]
    events = market_view.get("events")  # stale caches from before the events field lack it
    shareholding = fetch_shareholding(symbol)

    stock_json = {
        "symbol": symbol,
        "name": watch_info.get("name"),
        "sector": watch_info.get("sector"),
        "indicators": snapshot,
        "price_history": recent_price_history(enriched),
        "flags": flag_result,
        "fundamentals": fundamentals,
        "analyst": analyst,
        "events": events,
        "shareholding": shareholding,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    (config.STOCKS_OUTPUT_DIR / f"{symbol}.json").write_text(
        json.dumps(stock_json, indent=2), encoding="utf-8"
    )
    meta_entry = {
        "status": "ok",
        "fundamentals_available": fundamentals is not None,
        "analyst_available": analyst is not None,
        "events_available": events is not None,
        "shareholding_available": shareholding is not None,
    }
    logger.info(
        "wrote output for symbol=%s flags=%d/%d",
        symbol,
        flag_result["flag_count"],
        flag_result["flag_total"],
    )
    return meta_entry, stock_json


def run() -> None:
    run_stats.reset()
    _write_flag_definitions()
    # Every run gives the often-blocked external sources a fresh chance.
    reset_shareholding_circuit()
    fundamentals_breaker.reset()
    index_breaker.reset()

    watchlist = load_watchlist()
    portfolio = load_portfolio()
    holdings = portfolio.get("holdings", [])

    watch_by_symbol = {row["symbol"]: row for row in watchlist}
    all_symbols = sorted(set(watch_by_symbol) | {h["symbol"] for h in holdings})

    with run_stats.stage("login_and_instruments"):
        try:
            conn, _ = login()
        except AngelAuthError as exc:
            logger.error("aborting pipeline run: Angel One login failed: %s", exc)
            return
        token_map = build_nse_equity_token_map()

    meta = {"run_at": datetime.now(timezone.utc).isoformat(), "symbols": {}}
    stock_data_by_symbol: dict[str, dict] = {}

    # Symbols are processed concurrently. Per-file output writes never collide (one file
    # per symbol, one symbol per future); the shared meta/stock dicts are only touched
    # here on the main thread as futures complete.
    logger.info("processing %d symbols with %d workers", len(all_symbols), config.PIPELINE_WORKERS)
    loop_started = time.monotonic()
    completed = failed = 0

    with run_stats.stage("symbol_processing"):
        with ThreadPoolExecutor(max_workers=config.PIPELINE_WORKERS) as pool:
            futures = {
                pool.submit(_process_symbol, conn, token_map, symbol, watch_by_symbol.get(symbol, {})): symbol
                for symbol in all_symbols
            }
            for future in as_completed(futures):
                symbol = futures[future]
                try:
                    meta_entry, stock_json = future.result()
                except Exception as exc:
                    # A bug in one symbol's processing must never kill the run.
                    log_skip(logger, symbol, "pipeline_worker", f"unhandled {exc!r}")
                    meta_entry, stock_json = {"status": "skipped", "reason": f"worker error: {exc}"}, None

                meta["symbols"][symbol] = meta_entry
                if stock_json is not None:
                    stock_data_by_symbol[symbol] = stock_json
                else:
                    failed += 1
                completed += 1

                if completed % _PROGRESS_EVERY == 0 or completed == len(all_symbols):
                    elapsed = time.monotonic() - loop_started
                    rate = completed / elapsed if elapsed > 0 else 0
                    remaining = (len(all_symbols) - completed) / rate if rate > 0 else 0
                    logger.info(
                        "progress %d/%d (ok=%d failed=%d) elapsed=%.1fm eta=%.1fm",
                        completed, len(all_symbols), completed - failed, failed,
                        elapsed / 60, remaining / 60,
                    )

    with run_stats.stage("portfolio_and_sectors"):
        _write_portfolio_output(holdings, stock_data_by_symbol, watch_by_symbol)
        _write_sector_strength(stock_data_by_symbol)

    with run_stats.stage("market_indices"):
        write_market_output()

    # News only for the symbols that matter most today: every holding plus the top
    # flag-count names — keeps request volume small.
    with run_stats.stage("news"):
        top_by_flags = sorted(
            stock_data_by_symbol.values(),
            key=lambda s: s["flags"]["flag_count"],
            reverse=True,
        )[:10]
        news_symbols = sorted({s["symbol"] for s in top_by_flags} | {h["symbol"] for h in holdings})
        # Pass the company name where we know it: the news search keys off it, and a bare
        # ticker like "BEL" or "SCTL" pulls in unrelated noise.
        news_targets = {
            symbol: (
                (stock_data_by_symbol.get(symbol) or {}).get("name")
                or watch_by_symbol.get(symbol, {}).get("name")
                or symbol
            )
            for symbol in news_symbols
        }
        write_news_output(news_targets)

    # Futures complete in arbitrary order; sort so meta.json diffs stay stable run-to-run.
    meta["symbols"] = dict(sorted(meta["symbols"].items()))
    meta["summary"] = {
        "total": len(all_symbols),
        "ok": sum(1 for v in meta["symbols"].values() if v["status"] == "ok"),
        "skipped": sum(1 for v in meta["symbols"].values() if v["status"] == "skipped"),
    }
    (config.OUTPUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    failed_symbols = {
        symbol: entry["reason"]
        for symbol, entry in meta["symbols"].items()
        if entry["status"] == "skipped"
    }
    report = run_stats.write_report(
        extra={
            "workers": config.PIPELINE_WORKERS,
            "symbols_total": len(all_symbols),
            "symbols_ok": meta["summary"]["ok"],
            "symbols_failed": meta["summary"]["skipped"],
            "failed_symbols": failed_symbols,
        }
    )
    logger.info("pipeline run complete: %s", meta["summary"])
    logger.info(
        "run report: runtime=%.1fm stages=%s counters=%s",
        (report["runtime_seconds"] or 0) / 60,
        report["stages_seconds"],
        report["counters"],
    )


def _write_portfolio_output(
    holdings: list[dict], stock_data_by_symbol: dict[str, dict], watch_by_symbol: dict[str, dict]
) -> None:
    portfolio_output = {"holdings": [], "updated_at": datetime.now(timezone.utc).isoformat()}

    for holding in holdings:
        symbol = holding["symbol"]
        stock = stock_data_by_symbol.get(symbol)
        if stock is None:
            log_skip(logger, symbol, "portfolio_join", "no stock data available for this holding this cycle")
            portfolio_output["holdings"].append(
                {**holding, "current_price": None, "pnl": None, "pnl_pct": None, "flags": None}
            )
            continue

        current_price = stock["indicators"]["close"]
        buy_price = holding["buy_price"]
        quantity = holding["quantity"]
        pnl = (current_price - buy_price) * quantity
        pnl_pct = (current_price - buy_price) / buy_price * 100 if buy_price else None

        portfolio_output["holdings"].append(
            {
                **holding,
                "current_price": current_price,
                "pnl": pnl,
                "pnl_pct": pnl_pct,
                "flags": stock["flags"],
                "sector": watch_by_symbol.get(symbol, {}).get("sector"),
            }
        )

    (config.OUTPUT_DIR / "portfolio.json").write_text(json.dumps(portfolio_output, indent=2), encoding="utf-8")


def _write_sector_strength(stock_data_by_symbol: dict[str, dict]) -> None:
    """Sector strength = average of already-computed flag_count/flag_total across a
    sector's tracked stocks. A transparent average, not a new weighted score - it doesn't
    change how individual stocks are ranked (still flag count only, per CLAUDE.md)."""
    by_sector: dict[str, list[dict]] = {}
    for stock in stock_data_by_symbol.values():
        sector = stock.get("sector")
        if not sector:
            continue
        by_sector.setdefault(sector, []).append(stock["flags"])

    sectors = []
    for sector, flag_results in by_sector.items():
        ratios = [fr["flag_count"] / fr["flag_total"] for fr in flag_results]
        avg_flag_pct = sum(ratios) / len(ratios) * 100
        sectors.append(
            {
                "sector": sector,
                "avg_flag_pct": round(avg_flag_pct, 1),
                "stock_count": len(flag_results),
            }
        )

    sectors.sort(key=lambda s: s["avg_flag_pct"], reverse=True)
    (config.OUTPUT_DIR / "sectors.json").write_text(json.dumps(sectors, indent=2), encoding="utf-8")
    logger.info("wrote sector strength for %d sectors", len(sectors))


if __name__ == "__main__":
    run()
