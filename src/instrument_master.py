import json
import time

import requests

from src import config
from src.logging_utils import get_logger

logger = get_logger(__name__)

SCRIP_MASTER_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json"
CACHE_PATH = config.CACHE_DIR / "scrip_master.json"
CACHE_MAX_AGE_SECONDS = 24 * 60 * 60
# The scrip master is a large file (~35 MB / 100k+ instruments). Angel One's CDN
# regularly drops the connection partway through, surfacing as
# ChunkedEncodingError / IncompleteRead. Guard against a truncated body being
# parsed or cached by requiring a plausible instrument count.
_MIN_INSTRUMENTS = 10_000
_DOWNLOAD_RETRIES = 4
_DOWNLOAD_TIMEOUT = (10, 120)  # (connect, read) seconds


class InstrumentLookupError(Exception):
    pass


def _download_scrip_master() -> list[dict]:
    """Download the scrip master, streaming with retries.

    Angel One's CDN frequently truncates this large response mid-transfer
    (ChunkedEncodingError: IncompleteRead). We stream into memory, retry with
    exponential backoff on any transport error, and reject any body that is not
    valid JSON or that carries an implausibly small instrument count — a
    truncated file must never be parsed or cached as if complete.
    """
    last_error: Exception | None = None
    for attempt in range(1, _DOWNLOAD_RETRIES + 1):
        logger.info(
            "downloading Angel One scrip master from %s (attempt %d/%d)",
            SCRIP_MASTER_URL,
            attempt,
            _DOWNLOAD_RETRIES,
        )
        try:
            with requests.get(
                SCRIP_MASTER_URL, timeout=_DOWNLOAD_TIMEOUT, stream=True
            ) as response:
                response.raise_for_status()
                # Read the whole body explicitly so a mid-stream break raises
                # here (as ChunkedEncodingError) rather than yielding a
                # silently short body.
                raw = response.content
            data = json.loads(raw)
            if not isinstance(data, list) or len(data) < _MIN_INSTRUMENTS:
                raise InstrumentLookupError(
                    f"scrip master looks truncated/invalid: got "
                    f"{len(data) if isinstance(data, list) else type(data).__name__} "
                    f"entries (expected ≥ {_MIN_INSTRUMENTS})"
                )
            CACHE_PATH.write_text(json.dumps(data), encoding="utf-8")
            logger.info(
                "cached scrip master (%d instruments) at %s", len(data), CACHE_PATH
            )
            return data
        except (requests.RequestException, ValueError, InstrumentLookupError) as exc:
            last_error = exc
            logger.warning(
                "scrip master download attempt %d/%d failed: %s",
                attempt,
                _DOWNLOAD_RETRIES,
                exc,
            )
            if attempt < _DOWNLOAD_RETRIES:
                backoff = 2 ** (attempt - 1)  # 1s, 2s, 4s, ...
                logger.info("retrying scrip master download in %ds", backoff)
                time.sleep(backoff)

    # Every attempt failed. Fall back to a cached copy even if stale — a slightly
    # old token map is far better than aborting the entire pipeline. Every such
    # fallback is logged explicitly (no silent stale data).
    if CACHE_PATH.exists():
        age = time.time() - CACHE_PATH.stat().st_mtime
        logger.warning(
            "scrip master download failed after %d attempts (%s); "
            "falling back to cached copy (age=%.0fs)",
            _DOWNLOAD_RETRIES,
            last_error,
            age,
        )
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))

    raise InstrumentLookupError(
        f"could not download scrip master after {_DOWNLOAD_RETRIES} attempts "
        f"and no cache is available: {last_error}"
    )


def _load_scrip_master(force_refresh: bool = False) -> list[dict]:
    if not force_refresh and CACHE_PATH.exists():
        age = time.time() - CACHE_PATH.stat().st_mtime
        if age < CACHE_MAX_AGE_SECONDS:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        logger.info("scrip master cache stale (age=%.0fs), refreshing", age)
    return _download_scrip_master()


def build_nse_equity_token_map(force_refresh: bool = False) -> dict[str, str]:
    """Maps bare NSE trading symbol (e.g. 'RELIANCE') -> Angel One symboltoken."""
    instruments = _load_scrip_master(force_refresh=force_refresh)
    token_map: dict[str, str] = {}
    for row in instruments:
        if row.get("exch_seg") != "NSE":
            continue
        symbol = row.get("symbol", "")
        if not symbol.endswith("-EQ"):
            continue
        bare_symbol = symbol[: -len("-EQ")]
        token_map[bare_symbol] = row["token"]
    logger.info("built NSE equity token map with %d symbols", len(token_map))
    return token_map


def get_token(symbol: str, token_map: dict[str, str]) -> str | None:
    token = token_map.get(symbol)
    if token is None:
        logger.warning("no Angel One symboltoken found for symbol=%s", symbol)
    return token


if __name__ == "__main__":
    mapping = build_nse_equity_token_map()
    for test_symbol in ("RELIANCE", "TCS", "INFY", "HDFCBANK", "DOES_NOT_EXIST"):
        logger.info("%s -> %s", test_symbol, get_token(test_symbol, mapping))
