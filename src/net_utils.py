"""Shared network plumbing for every fetcher: throttling, circuit breaking, retries.

The pipeline now processes symbols concurrently, so all of this is thread-safe. The
rules these classes encode were each learned from a real incident:

- Throttle: burst-calling Angel/yfinance gets the whole run rate-limited. Every module
  used to carry its own copy of the same _throttle() function; this is that function as
  a lockable object shared across worker threads.
- CircuitBreaker: when a source blocks us (NSE shareholding, yfinance-from-CI), it
  blocks us for the whole run, and each doomed attempt costs seconds of timeout/backoff.
  On 2026-07-15 yfinance's quote endpoint 429'd every one of 176 symbols and the retry
  backoff (~22s each) WAS the pipeline's ~65-minute runtime. After a few consecutive
  failures we stop paying to be told "no" — every subsequent skip is still logged
  individually (CLAUDE.md: no silent failures), it just skips the network wait.
"""

import threading
import time
from logging import Logger

from src.logging_utils import log_skip


class Throttle:
    """Enforces a minimum interval between calls, across threads.

    With concurrent workers this serialises access to one upstream API: whoever holds
    the lock sleeps out the remaining gap, so the API never sees a burst even though
    the rest of the per-symbol work overlaps.
    """

    def __init__(self, min_interval_sec: float) -> None:
        self.min_interval_sec = min_interval_sec
        self._lock = threading.Lock()
        self._last_call_ts = 0.0

    def wait(self) -> None:
        with self._lock:
            elapsed = time.monotonic() - self._last_call_ts
            if elapsed < self.min_interval_sec:
                time.sleep(self.min_interval_sec - elapsed)
            self._last_call_ts = time.monotonic()


class CircuitBreaker:
    """Stops calling a source for the rest of the run after repeated consecutive failures.

    A success resets the failure count, so one flaky patch mid-run doesn't trip it.
    reset() is called at the start of each pipeline run so every run gives the source
    a fresh chance.
    """

    def __init__(self, name: str, logger: Logger, max_consecutive_failures: int = 3) -> None:
        self.name = name
        self.logger = logger
        self.max_consecutive_failures = max_consecutive_failures
        self._lock = threading.Lock()
        self._consecutive_failures = 0
        self._open = False

    @property
    def is_open(self) -> bool:
        with self._lock:
            return self._open

    def reset(self) -> None:
        with self._lock:
            self._consecutive_failures = 0
            self._open = False

    def record_success(self) -> None:
        with self._lock:
            self._consecutive_failures = 0

    def record_failure(self, symbol: str, stage: str, reason: str) -> None:
        """Log the failure and open the circuit if the threshold is reached."""
        log_skip(self.logger, symbol, stage, reason)
        with self._lock:
            self._consecutive_failures += 1
            if not self._open and self._consecutive_failures >= self.max_consecutive_failures:
                self._open = True
                self.logger.warning(
                    "OPENING %s circuit: %d consecutive failures; skipping the network "
                    "for the remaining symbols this run (each skip is still logged). "
                    "The circuit resets on the next run.",
                    self.name,
                    self._consecutive_failures,
                )

    def skip(self, symbol: str, stage: str) -> None:
        """Log the per-symbol skip that happens while the circuit is open."""
        log_skip(self.logger, symbol, stage, f"skipped: {self.name} circuit open for this run")
