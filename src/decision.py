"""Decision-support layer: attention tiers, risk conditions, and trend labels.

Everything here is a NAMED BOOLEAN CONDITION or a COUNT of named conditions —
never a weighted composite score (CLAUDE.md "Ranking philosophy — the one hard
rule"). A tier/level can always be explained by listing exactly which conditions
produced it; two stocks can never swap places because of an invisible weight.

No existing calculation is changed: this module only reads the snapshot/flags the
pipeline already computes (plus the candle frame for the weekly trend) and adds
labels on top.
"""

import pandas as pd

# ---------------------------------------------------------------------------
# Patterns — the same transparent booleans the dashboard's Screens section uses,
# recomputed here so tiers and Telegram briefs share one definition.
# ---------------------------------------------------------------------------


def evaluate_patterns(snapshot: dict) -> dict:
    close = snapshot["close"]
    volume_surge = snapshot["volume"] >= 1.4 * snapshot["avg_volume20"] if snapshot["avg_volume20"] else False
    change = snapshot.get("change_pct")
    return {
        "breakout": close > snapshot["bb_high"] or close >= 0.995 * snapshot["high_52w"],
        "volume_surge": volume_surge,
        "silent_accumulation": volume_surge and change is not None and abs(change) <= 0.8,
        "near_buy_zone": (
            snapshot["ema50"] > snapshot["ema200"]
            and (
                abs(close / snapshot["ema20"] - 1) <= 0.02
                or abs(close / snapshot["ema50"] - 1) <= 0.02
            )
        ),
    }


# ---------------------------------------------------------------------------
# Attention tier — priority for the reader's time, never buy/sell advice.
# First matching rule wins; the met conditions are returned so the UI can show
# exactly why. Tier 1 is "Quiet today", deliberately not "Ignore" (that would be
# advice).
# ---------------------------------------------------------------------------

ATTENTION_TIERS = [
    {
        "tier": 5,
        "label": "Immediate attention",
        "rule": "≥7/8 flags and (breakout or volume ≥1.4× 20d avg)",
    },
    {
        "tier": 4,
        "label": "Watch closely",
        "rule": "≥6/8 flags and a named pattern (breakout / near buy zone / silent accumulation)",
    },
    {
        "tier": 3,
        "label": "Potential setup",
        "rule": "≥5/8 flags, or ≥4/8 flags with a named pattern",
    },
    {"tier": 2, "label": "Monitor", "rule": "3–4/8 flags"},
    {"tier": 1, "label": "Quiet today", "rule": "≤2/8 flags"},
]


def attention_tier(flag_result: dict, patterns: dict) -> dict:
    count = flag_result["flag_count"]
    pattern_names = [name for name, on in patterns.items() if on]
    reasons = [f"{count}/{flag_result['flag_total']} bullish flags"]
    if pattern_names:
        reasons.append("patterns: " + ", ".join(name.replace("_", " ") for name in pattern_names))

    if count >= 7 and (patterns["breakout"] or patterns["volume_surge"]):
        tier = 5
    elif count >= 6 and (patterns["breakout"] or patterns["near_buy_zone"] or patterns["silent_accumulation"]):
        tier = 4
    elif count >= 5 or (count >= 4 and pattern_names):
        tier = 3
    elif count >= 3:
        tier = 2
    else:
        tier = 1

    spec = next(t for t in ATTENTION_TIERS if t["tier"] == tier)
    return {
        "tier": tier,
        "label": spec["label"],
        "rule": spec["rule"],
        "reasons": reasons,
    }


# ---------------------------------------------------------------------------
# Risk conditions — a count of named observations, each with the numbers behind
# it. The level comes from the count alone (0–1 low, 2–3 elevated, ≥4 high);
# there is no weighting and no 0–100 number.
# ---------------------------------------------------------------------------

RISK_CONDITION_DEFINITIONS = [
    ("atr_high", "ATR ≥2.5% of price — large typical daily swings"),
    ("rsi_extreme", "RSI(14) ≥75 or ≤25 — momentum at an extreme"),
    ("below_ema200", "Price below EMA200 — long-term trend is down"),
    ("extended_above_ema20", "Price ≥8% above EMA20 — stretched, pullback-prone"),
    ("large_day_move", "Today's move ≥4% — gap-prone conditions"),
    ("near_52w_low", "Within 5% of the 52-week low"),
]


def risk_conditions(snapshot: dict) -> dict:
    close = snapshot["close"]
    atr_pct = (snapshot["atr14"] / close * 100) if close else None
    rsi = snapshot["rsi14"]
    change = snapshot.get("change_pct")

    fired = {
        "atr_high": atr_pct is not None and atr_pct >= 2.5,
        "rsi_extreme": rsi >= 75 or rsi <= 25,
        "below_ema200": close < snapshot["ema200"],
        "extended_above_ema20": close >= 1.08 * snapshot["ema20"],
        "large_day_move": change is not None and abs(change) >= 4,
        "near_52w_low": close <= 1.05 * snapshot["low_52w"],
    }
    detail = {
        "atr_high": f"ATR {snapshot['atr14']:.2f} = {atr_pct:.1f}% of price" if atr_pct is not None else "ATR unavailable",
        "rsi_extreme": f"RSI(14) {rsi:.1f}",
        "below_ema200": f"Close {close:,.2f} vs EMA200 {snapshot['ema200']:,.2f}",
        "extended_above_ema20": f"Close {close:,.2f} vs EMA20 {snapshot['ema20']:,.2f} ({(close / snapshot['ema20'] - 1) * 100:+.1f}%)",
        "large_day_move": f"Day change {change:+.1f}%" if change is not None else "no previous close",
        "near_52w_low": f"Close {close:,.2f} vs 52w low {snapshot['low_52w']:,.2f}",
    }

    conditions_on = [key for key, on in fired.items() if on]
    count = len(conditions_on)
    level = "low" if count <= 1 else ("elevated" if count <= 3 else "high")
    return {
        "conditions": fired,
        "conditions_detail": detail,
        "conditions_on": conditions_on,
        "condition_count": count,
        "condition_total": len(RISK_CONDITION_DEFINITIONS),
        "level": level,
    }


# ---------------------------------------------------------------------------
# Trend labels. Daily comes from the snapshot's EMA alignment; weekly from a
# weekly resample of the same candles. Intraday is deliberately absent — the
# pipeline collects daily candles only, and the UI says so instead of guessing.
# ---------------------------------------------------------------------------


def daily_trend(snapshot: dict) -> str:
    close = snapshot["close"]
    if close > snapshot["ema50"] > snapshot["ema200"]:
        return "bullish"
    if close < snapshot["ema50"] < snapshot["ema200"]:
        return "bearish"
    return "neutral"


def weekly_trend(df: pd.DataFrame) -> str | None:
    """Bullish = last weekly close above a rising 10-week EMA; bearish = below a
    falling one; neutral otherwise. Returns None (never a guess) below 15 weeks."""
    weekly = df.set_index("date")["close"].resample("W-FRI").last().dropna()
    if len(weekly) < 15:
        return None
    ema10 = weekly.ewm(span=10, adjust=False).mean()
    last_close, last_ema = float(weekly.iloc[-1]), float(ema10.iloc[-1])
    ema_4w_ago = float(ema10.iloc[-5])
    if last_close > last_ema and last_ema > ema_4w_ago:
        return "bullish"
    if last_close < last_ema and last_ema < ema_4w_ago:
        return "bearish"
    return "neutral"


# ---------------------------------------------------------------------------
# Assembly + published definitions (so the UI can show the exact rules).
# ---------------------------------------------------------------------------


def build_decision(snapshot: dict, flag_result: dict, df: pd.DataFrame) -> dict:
    patterns = evaluate_patterns(snapshot)
    risk = risk_conditions(snapshot)
    return {
        "attention": attention_tier(flag_result, patterns),
        "risk": risk,
        "patterns": patterns,
        "trend": {
            "daily": daily_trend(snapshot),
            "weekly": weekly_trend(df),
            "intraday": None,  # daily pipeline — no intraday data is collected
        },
    }


def definitions() -> dict:
    return {
        "attention_tiers": ATTENTION_TIERS,
        "risk_conditions": [{"key": k, "label": l} for k, l in RISK_CONDITION_DEFINITIONS],
        "risk_levels": "count of conditions: 0–1 low · 2–3 elevated · ≥4 high",
        "trend_rules": {
            "daily": "bullish: close > EMA50 > EMA200 · bearish: close < EMA50 < EMA200 · else neutral",
            "weekly": "bullish: weekly close above a rising 10-week EMA · bearish: below a falling one · else neutral · null under 15 weeks of history",
            "intraday": "not collected — the pipeline fetches daily candles only",
        },
        "note": "All labels are counts/thresholds of named conditions — never a weighted score.",
    }
