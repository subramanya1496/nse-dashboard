"""\"What changed since yesterday\" — diffs today's computed stock data against the
previously PUBLISHED stock JSONs (read from disk before the pipeline overwrites
them, which works because outputs are committed to the repo between runs).

Rules of honesty:
- Only diff when the data date actually advanced. On a same-day rerun the previous
  files are already today's, so diffing would erase every change — the existing
  changes.json is kept untouched instead (logged).
- First run / missing previous file → the symbol is skipped, and the output says
  how many had no baseline. Never a fabricated "no change".
- Every entry names the observed values (was → now), not an interpretation.
"""

import json
from datetime import datetime, timezone

from src import config
from src.logging_utils import get_logger

logger = get_logger(__name__)

CHANGES_PATH = config.OUTPUT_DIR / "changes.json"


def load_previous_stocks(symbols: list[str]) -> dict[str, dict]:
    """Snapshot the currently-published stock JSONs before the run overwrites them."""
    previous = {}
    for symbol in symbols:
        path = config.STOCKS_OUTPUT_DIR / f"{symbol}.json"
        if not path.exists():
            continue
        try:
            previous[symbol] = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("could not read previous %s.json for change diff: %r", symbol, exc)
    return previous


def _support_resistance(stock: dict) -> tuple[float, float] | None:
    history = stock.get("price_history") or []
    closes = [h["close"] for h in history[-20:] if h.get("close") is not None]
    if len(closes) < 20:
        return None
    return min(closes), max(closes)


def _diff_symbol(symbol: str, old: dict, new: dict) -> list[dict]:
    events: list[dict] = []
    o_ind, n_ind = old.get("indicators") or {}, new.get("indicators") or {}
    o_flags, n_flags = old.get("flags") or {}, new.get("flags") or {}

    def add(kind: str, text: str) -> None:
        events.append({"kind": kind, "text": text})

    # Flags gained / lost, by name
    o_on = set(o_flags.get("flags_on") or [])
    n_on = set(n_flags.get("flags_on") or [])
    gained, lost = sorted(n_on - o_on), sorted(o_on - n_on)
    if gained or lost:
        parts = []
        if gained:
            parts.append("gained " + ", ".join(f.replace("_", " ") for f in gained))
        if lost:
            parts.append("lost " + ", ".join(f.replace("_", " ") for f in lost))
        add(
            "flags",
            f"Flags {o_flags.get('flag_count')}→{n_flags.get('flag_count')}/8: " + "; ".join(parts),
        )

    # Attention tier movement (only present once both runs carry the decision block)
    o_att = (old.get("decision") or {}).get("attention") or {}
    n_att = (new.get("decision") or {}).get("attention") or {}
    if o_att.get("tier") and n_att.get("tier") and o_att["tier"] != n_att["tier"]:
        add("attention", f"Attention: {o_att['label']} → {n_att['label']}")

    # RSI level crossings (50 / 70 / 30)
    o_rsi, n_rsi = o_ind.get("rsi14"), n_ind.get("rsi14")
    if o_rsi is not None and n_rsi is not None:
        for level in (50, 70, 30):
            if (o_rsi < level) != (n_rsi < level):
                direction = "above" if n_rsi >= level else "below"
                add("rsi", f"RSI crossed {direction} {level} ({o_rsi:.1f} → {n_rsi:.1f})")
                break

    # MACD signal-line cross
    if all(v is not None for v in (o_ind.get("macd"), o_ind.get("macd_signal"), n_ind.get("macd"), n_ind.get("macd_signal"))):
        was_above = o_ind["macd"] > o_ind["macd_signal"]
        now_above = n_ind["macd"] > n_ind["macd_signal"]
        if was_above != now_above:
            add("macd", f"MACD crossed {'above' if now_above else 'below'} its signal line")

    # Long-term trend line cross
    if all(v is not None for v in (o_ind.get("close"), o_ind.get("ema200"), n_ind.get("close"), n_ind.get("ema200"))):
        was_above = o_ind["close"] > o_ind["ema200"]
        now_above = n_ind["close"] > n_ind["ema200"]
        if was_above != now_above:
            add("ema200", f"Price crossed {'above' if now_above else 'below'} EMA200")

    # New 52-week extremes (today's close beyond yesterday's recorded band)
    if n_ind.get("close") is not None:
        if o_ind.get("high_52w") is not None and n_ind["close"] > o_ind["high_52w"]:
            add("high_52w", f"New 52-week high: {n_ind['close']:,.2f} (was {o_ind['high_52w']:,.2f})")
        elif o_ind.get("low_52w") is not None and n_ind["close"] < o_ind["low_52w"]:
            add("low_52w", f"New 52-week low: {n_ind['close']:,.2f} (was {o_ind['low_52w']:,.2f})")

    # Volume surge appearing today
    o_vol_ratio = (o_ind.get("volume") / o_ind.get("avg_volume20")) if o_ind.get("avg_volume20") else None
    n_vol_ratio = (n_ind.get("volume") / n_ind.get("avg_volume20")) if n_ind.get("avg_volume20") else None
    if n_vol_ratio is not None and n_vol_ratio >= 1.5 and (o_vol_ratio is None or o_vol_ratio < 1.5):
        add("volume", f"Volume {n_vol_ratio:.1f}× the 20-day average")

    # 20-session support/resistance shifts >2%
    o_sr, n_sr = _support_resistance(old), _support_resistance(new)
    if o_sr and n_sr:
        for name, o_v, n_v in (("Support", o_sr[0], n_sr[0]), ("Resistance", o_sr[1], n_sr[1])):
            if o_v and abs(n_v / o_v - 1) > 0.02:
                add("levels", f"{name} (20-session) moved {o_v:,.2f} → {n_v:,.2f}")

    return events


def write_changes(previous: dict[str, dict], current: dict[str, dict]) -> None:
    """Diff and write changes.json, or keep the existing one on a same-day rerun."""
    # Establish the two data dates from any symbol present in both runs.
    dates = [
        ((previous[s].get("indicators") or {}).get("date"), (current[s].get("indicators") or {}).get("date"))
        for s in current
        if s in previous
    ]
    dates = [(o, n) for o, n in dates if o and n]
    if not dates:
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "baseline_date": None,
            "data_date": None,
            "symbols": {},
            "note": "No previous published run to compare against — changes appear from the next run onward.",
        }
        CHANGES_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        logger.info("changes.json: no baseline available; wrote explicit empty state")
        return

    baseline_date = max(o for o, _ in dates)
    data_date = max(n for _, n in dates)
    if baseline_date == data_date:
        logger.info(
            "changes.json: same-day rerun (data date %s unchanged) — keeping the existing "
            "change list instead of diffing today against itself",
            data_date,
        )
        return

    symbols: dict[str, list[dict]] = {}
    no_baseline = 0
    for symbol, new in current.items():
        old = previous.get(symbol)
        if old is None:
            no_baseline += 1
            continue
        events = _diff_symbol(symbol, old, new)
        if events:
            symbols[symbol] = events

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "baseline_date": baseline_date,
        "data_date": data_date,
        "symbols": symbols,
        "symbols_without_baseline": no_baseline,
    }
    CHANGES_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    logger.info(
        "wrote changes.json: %d symbols with changes (%s → %s), %d had no baseline",
        len(symbols), baseline_date, data_date, no_baseline,
    )
