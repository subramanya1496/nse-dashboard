import argparse
import json
from datetime import datetime, timezone, timedelta

import requests

from src import config
from src.logging_utils import get_logger

logger = get_logger(__name__)

TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"
TOP_N = 5
IST = timezone(timedelta(hours=5, minutes=30))


def _load_output():
    meta = json.loads((config.OUTPUT_DIR / "meta.json").read_text(encoding="utf-8"))
    sectors = json.loads((config.OUTPUT_DIR / "sectors.json").read_text(encoding="utf-8"))
    portfolio = json.loads((config.OUTPUT_DIR / "portfolio.json").read_text(encoding="utf-8"))

    stocks = []
    for symbol, info in meta["symbols"].items():
        if info["status"] != "ok":
            continue
        stock_path = config.STOCKS_OUTPUT_DIR / f"{symbol}.json"
        stocks.append(json.loads(stock_path.read_text(encoding="utf-8")))
    stocks.sort(key=lambda s: s["flags"]["flag_count"], reverse=True)

    return meta, sectors, portfolio, stocks


def _load_market():
    """market.json is optional (only exists once the extended pipeline / morning index
    refresh has run). Return None rather than failing the brief."""
    path = config.OUTPUT_DIR / "market.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("could not read market.json: %r", exc)
        return None


def _now_ist_label() -> str:
    return datetime.now(IST).strftime("%d %b %Y, %I:%M %p IST")


def _fmt_change(pct) -> str:
    if pct is None:
        return "—"
    arrow = "▲" if pct > 0 else "▼" if pct < 0 else "▬"
    return f"{arrow} {abs(pct):.2f}%"


def _price(value) -> str:
    if value is None:
        return "—"
    return f"₹{value:,.2f}"


def _index_line(ix: dict) -> str:
    value = f"{ix['close']:,.2f}"
    return f"{ix['label']}: {value} {_fmt_change(ix.get('change_pct'))}"


def _index_map(market, key):
    if not market:
        return []
    return market.get(key, []) or []


def _format_stock_flag_line(rank: int, stock: dict) -> str:
    flags = stock["flags"]
    top_flag_labels = ", ".join(flags["flags_on"][:2]) or "no bullish flags"
    return f"{rank}. {stock['symbol']} ({stock['sector']}) — {flags['flag_count']}/{flags['flag_total']} · {top_flag_labels}"


# --- Morning: global tone + India indices + watchlist leaders -----------------------


def build_morning_message(meta, sectors, portfolio, stocks, market) -> str:
    lines = [f"🌅 *Good morning — Market brief*", f"_{_now_ist_label()}_", ""]

    global_ix = _index_map(market, "global_indices")
    if global_ix:
        lines.append("🌍 *Global (overnight / Asia):*")
        for ix in global_ix:
            lines.append(f"• {_index_line(ix)}")
        lines.append("")

    india_ix = _index_map(market, "indices")
    if india_ix:
        lines.append("🇮🇳 *India (previous close):*")
        for ix in india_ix:
            lines.append(f"• {_index_line(ix)}")
        lines.append("")

    if not global_ix and not india_ix:
        lines.append("_Index data unavailable this run (market.json not refreshed)._")
        lines.append("")

    if stocks:
        based_on = meta["run_at"][:10]
        lines.append(f"👀 *Watchlist leaders* (by flags, {based_on} close):")
        for i, stock in enumerate(stocks[:TOP_N], start=1):
            lines.append(_format_stock_flag_line(i, stock))
        lines.append("")

    lines.append(f"📈 Full dashboard: {config.DASHBOARD_URL}")
    lines.append("_Ranked by flag count, not a score — you make every decision._")
    return "\n".join(lines)


# --- Evening: day's movers + India close + your portfolio ---------------------------


def _top_movers(stocks, gainers=True, n=TOP_N):
    ranked = [s for s in stocks if s["indicators"].get("change_pct") is not None]
    ranked.sort(key=lambda s: s["indicators"]["change_pct"], reverse=gainers)
    return ranked[:n]


def build_evening_message(meta, sectors, portfolio, stocks, market) -> str:
    based_on = meta["run_at"][:10]
    lines = ["📊 *Evening wrap — market close*", f"_{_now_ist_label()} · data as of {based_on}_", ""]

    lines.append(f"{meta['summary']['ok']}/{meta['summary']['total']} symbols updated.")
    if meta["summary"]["skipped"]:
        lines.append(f"⚠️ {meta['summary']['skipped']} skipped (see dashboard for reasons).")
    lines.append("")

    india_ix = _index_map(market, "indices")
    if india_ix:
        lines.append("🇮🇳 *Indices:*")
        for ix in india_ix:
            lines.append(f"• {_index_line(ix)}")
        lines.append("")

    gainers = _top_movers(stocks, gainers=True)
    if gainers:
        lines.append("🔼 *Top gainers (watchlist):*")
        for i, s in enumerate(gainers, start=1):
            lines.append(f"{i}. {s['symbol']} {_fmt_change(s['indicators']['change_pct'])} · {_price(s['indicators']['close'])}")
        lines.append("")

    losers = _top_movers(stocks, gainers=False)
    if losers:
        lines.append("🔽 *Top losers (watchlist):*")
        for i, s in enumerate(losers, start=1):
            lines.append(f"{i}. {s['symbol']} {_fmt_change(s['indicators']['change_pct'])} · {_price(s['indicators']['close'])}")
        lines.append("")

    if sectors:
        top_sectors = ", ".join(f"{s['sector']} {s['avg_flag_pct']}%" for s in sectors[:3])
        lines.append(f"🏆 *Strongest sectors:* {top_sectors}")
        lines.append("")

    holdings = portfolio.get("holdings", [])
    if holdings:
        lines.append("💼 *Your portfolio:*")
        priced = [h for h in holdings if h.get("pnl") is not None]
        for h in holdings:
            if h.get("pnl_pct") is None:
                lines.append(f"• {h['symbol']}: no data this cycle")
            else:
                lines.append(f"• {h['symbol']}: {_fmt_change(h['pnl_pct'])} (₹{h['pnl']:,.0f})")
        if priced:
            invested = sum(h["buy_price"] * h["quantity"] for h in priced)
            total_pnl = sum(h["pnl"] for h in priced)
            total_pct = (total_pnl / invested * 100) if invested else 0
            sign = "+" if total_pnl >= 0 else "−"
            lines.append(f"*Total unrealized: {sign}₹{abs(total_pnl):,.0f} ({total_pct:+.2f}%)*")
        lines.append("")

    lines.append(f"📈 Full dashboard: {config.DASHBOARD_URL}")
    lines.append("_Not a recommendation service — you make every decision._")
    return "\n".join(lines)


def send_message(text: str) -> bool:
    if not config.TELEGRAM_BOT_TOKEN or not config.TELEGRAM_CHAT_ID:
        logger.warning("SKIP telegram_notify: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured")
        return False

    url = TELEGRAM_API.format(token=config.TELEGRAM_BOT_TOKEN)
    try:
        response = requests.post(
            url,
            data={"chat_id": config.TELEGRAM_CHAT_ID, "text": text, "parse_mode": "Markdown"},
            timeout=30,
        )
    except Exception as exc:
        logger.warning("SKIP telegram_notify: request raised %r", exc)
        return False

    if not response.ok or not response.json().get("ok"):
        logger.warning("SKIP telegram_notify: Telegram API returned failure: %s", response.text)
        return False

    logger.info("Telegram message sent successfully")
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["morning", "evening"], required=True)
    args = parser.parse_args()

    meta, sectors, portfolio, stocks = _load_output()
    market = _load_market()
    if args.mode == "evening":
        text = build_evening_message(meta, sectors, portfolio, stocks, market)
    else:
        text = build_morning_message(meta, sectors, portfolio, stocks, market)

    # Best-effort: a Telegram delivery failure should never fail the workflow job
    # (data collection + Pages deploy matter more than the notification).
    send_message(text)


if __name__ == "__main__":
    main()
