import json
from datetime import datetime, timezone

from src import config
from src.angel_auth import AngelAuthError, login
from src.fetch_fundamentals import fetch_market_view
from src.fetch_market import write_market_output, write_news_output
from src.fetch_ohlcv import fetch_daily_ohlcv
from src.fetch_shareholding import fetch_shareholding, reset_circuit as reset_shareholding_circuit
from src.flags import FLAG_DEFINITIONS, evaluate_flags
from src.indicators import compute_indicators, latest_indicator_snapshot, recent_price_history
from src.instrument_master import build_nse_equity_token_map, get_token
from src.logging_utils import get_logger, log_skip

logger = get_logger(__name__)


def load_watchlist() -> list[dict]:
    return json.loads(config.WATCHLIST_PATH.read_text(encoding="utf-8"))


def load_portfolio() -> dict:
    return json.loads(config.PORTFOLIO_PATH.read_text(encoding="utf-8"))


def _write_flag_definitions() -> None:
    definitions = [{"key": key, "label": label} for key, label in FLAG_DEFINITIONS]
    (config.OUTPUT_DIR / "flag_definitions.json").write_text(
        json.dumps(definitions, indent=2), encoding="utf-8"
    )


def run() -> None:
    _write_flag_definitions()
    reset_shareholding_circuit()  # every run gives the (often blocked) NSE source a fresh chance
    watchlist = load_watchlist()
    portfolio = load_portfolio()
    holdings = portfolio.get("holdings", [])

    watch_by_symbol = {row["symbol"]: row for row in watchlist}
    all_symbols = sorted(set(watch_by_symbol) | {h["symbol"] for h in holdings})

    try:
        conn, _ = login()
    except AngelAuthError as exc:
        logger.error("aborting pipeline run: Angel One login failed: %s", exc)
        return

    token_map = build_nse_equity_token_map()

    meta = {"run_at": datetime.now(timezone.utc).isoformat(), "symbols": {}}
    stock_data_by_symbol: dict[str, dict] = {}

    for symbol in all_symbols:
        watch_info = watch_by_symbol.get(symbol, {})

        token = get_token(symbol, token_map)
        if token is None:
            meta["symbols"][symbol] = {"status": "skipped", "reason": "no symboltoken found"}
            continue

        ohlcv = fetch_daily_ohlcv(conn, symbol, token)
        if ohlcv is None:
            meta["symbols"][symbol] = {"status": "skipped", "reason": "ohlcv fetch failed"}
            continue

        enriched = compute_indicators(symbol, ohlcv)
        if enriched is None:
            meta["symbols"][symbol] = {"status": "skipped", "reason": "insufficient history for indicators"}
            continue

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
        stock_data_by_symbol[symbol] = stock_json

        (config.STOCKS_OUTPUT_DIR / f"{symbol}.json").write_text(
            json.dumps(stock_json, indent=2), encoding="utf-8"
        )
        meta["symbols"][symbol] = {
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

    _write_portfolio_output(holdings, stock_data_by_symbol, watch_by_symbol)
    _write_sector_strength(stock_data_by_symbol)
    write_market_output()

    # News only for the symbols that matter most today: every holding plus the top
    # flag-count names — keeps yfinance request volume small.
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

    meta["summary"] = {
        "total": len(all_symbols),
        "ok": sum(1 for v in meta["symbols"].values() if v["status"] == "ok"),
        "skipped": sum(1 for v in meta["symbols"].values() if v["status"] == "skipped"),
    }
    (config.OUTPUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    logger.info("pipeline run complete: %s", meta["summary"])


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
