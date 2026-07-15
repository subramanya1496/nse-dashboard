import os
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

CONFIG_DIR = ROOT_DIR / "config"
DATA_DIR = ROOT_DIR / "data"
OUTPUT_DIR = DATA_DIR / "output"
STOCKS_OUTPUT_DIR = OUTPUT_DIR / "stocks"
CACHE_DIR = DATA_DIR / "cache"

WATCHLIST_PATH = CONFIG_DIR / "watchlist.json"
PORTFOLIO_PATH = CONFIG_DIR / "portfolio.json"

ANGEL_API_KEY = os.environ.get("ANGEL_API_KEY")
ANGEL_CLIENT_ID = os.environ.get("ANGEL_CLIENT_ID")
ANGEL_PIN = os.environ.get("ANGEL_PIN")
ANGEL_TOTP_SECRET = os.environ.get("ANGEL_TOTP_SECRET")

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

DASHBOARD_URL = "https://subramanya1496.github.io/nse-dashboard/"

# How many symbols are processed concurrently. Each external API keeps its own
# thread-safe throttle, so more workers overlap *different* APIs (Angel candles for one
# symbol while another waits on yfinance) rather than hammering any single one harder.
# 4 is a sensible default for CI; override with the PIPELINE_WORKERS env var.
PIPELINE_WORKERS = max(1, int(os.environ.get("PIPELINE_WORKERS", "4")))

for _dir in (OUTPUT_DIR, STOCKS_OUTPUT_DIR, CACHE_DIR):
    _dir.mkdir(parents=True, exist_ok=True)
